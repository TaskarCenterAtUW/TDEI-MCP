import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.TDEI_API_URL = "https://ws-backend-dev.azurewebsites.net";
process.env.TDEI_AUTH_API_URL = "https://api-dev.tdei.us";
process.env.TDEI_SSO_CALLBACK_URL = "http://127.0.0.1:18766/callback";

const { loadConfig } = await import("../src/config.js");
const { resolveMultiMcp } = await import("../src/multi-config.js");
const { AuthManager } = await import("../src/auth/auth-manager.js");

test("workspace-style backends authenticate against core, not the data backend", async () => {
  const result = loadConfig();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.apiUrl, "https://ws-backend-dev.azurewebsites.net");
  assert.equal(result.config.authApiUrl, "https://api-dev.tdei.us");

  // The SSO login URL must target the auth issuer. The workspace backend
  // rejects even unauthenticated /api/v1/sso-redirect with
  // {"detail":"Not authenticated"}, so pointing login at apiUrl can never succeed.
  const auth = new AuthManager();
  try {
    const login = await auth.startSsoLogin({ preflight: false });
    const loginUrl = new URL(login.loginUrl);
    assert.equal(loginUrl.origin, "https://api-dev.tdei.us");
    assert.equal(loginUrl.pathname, "/api/v1/sso-redirect");
  } finally {
    // startSsoLogin binds a loopback listener; release it via logout path.
    await auth.logout({ bindCallbackListener: false }).catch(() => undefined);
  }
});

test("authApiUrl defaults to apiUrl for core servers", () => {
  const servers = resolveMultiMcp({
    host: "127.0.0.1",
    basePort: 3001,
    servers: [{ name: "tdei-core-dev", apiUrl: "https://api-dev.tdei.us" }],
  });
  assert.equal(servers[0]?.authApiUrl, "https://api-dev.tdei.us");
});

test("multi-config honors per-server authApiUrl override", () => {
  const servers = resolveMultiMcp({
    host: "127.0.0.1",
    basePort: 3001,
    servers: [
      {
        name: "tdei-workspace",
        apiUrl: "https://ws-backend-dev.azurewebsites.net/",
        authApiUrl: "https://api-dev.tdei.us",
      },
    ],
  });
  assert.equal(servers[0]?.apiUrl, "https://ws-backend-dev.azurewebsites.net");
  assert.equal(servers[0]?.authApiUrl, "https://api-dev.tdei.us");
});

test("shipped mcps.json keeps workspace login on TDEI core", () => {
  const file = JSON.parse(readFileSync(new URL("../mcps.json", import.meta.url), "utf8")) as {
    servers: Array<{ name: string; apiUrl: string; authApiUrl?: string }>;
  };
  const workspace = file.servers.find((entry) => entry.name === "tdei-workspace");
  assert.ok(workspace, "mcps.json must define tdei-workspace");
  assert.ok(
    workspace.authApiUrl?.startsWith("https://api"),
    `tdei-workspace needs authApiUrl on TDEI core (got ${JSON.stringify(workspace.authApiUrl)})`,
  );
  assert.notEqual(
    new URL(workspace.apiUrl).origin,
    new URL(workspace.authApiUrl ?? "").origin,
    "workspace apiUrl must differ from authApiUrl: the data backend does not serve SSO",
  );
});
