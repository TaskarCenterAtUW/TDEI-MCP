import { createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.TDEI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tdei-security-sessions-"));

import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";
import {
  codeChallengeS256,
  dispatchOAuth,
  issueOAuthCookie,
  oauthEndpoints,
  openAuthorizationCode,
  readOAuthCookie,
  sealAuthorizationCode,
} from "../src/oauth/mcp-oauth.js";
import { serveTestHttp } from "./helpers/test-http-server.js";

const tokens = { access_token: "alice-access", refresh_token: "alice-refresh", expires_in: 3600 };

test("a sealed code cannot be opened with only the public PKCE challenge", () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = codeChallengeS256(verifier);
  const code = sealAuthorizationCode(tokens, "http://127.0.0.1:9/callback", challenge);

  // An observer of the authorize URL knows the challenge but not the verifier or the server secret.
  const [iv, ciphertext, tag] = code.split(".").map((part) => Buffer.from(part, "base64url")) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  const publicKeyOnly = createHash("sha256").update(challenge).digest();
  assert.throws(() => {
    const decipher = createDecipheriv("aes-256-gcm", publicKeyOnly, iv);
    decipher.setAuthTag(tag);
    Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  });

  // The legitimate holder of the verifier still redeems it.
  assert.equal(openAuthorizationCode(code, verifier).access_token, "alice-access");
  // A different verifier cannot.
  assert.throws(() => openAuthorizationCode(code, randomBytes(32).toString("base64url")), /invalid_grant/);
});

test("a code sealed under one server secret is useless under another", () => {
  const verifier = randomBytes(32).toString("base64url");
  const previous = process.env.TDEI_OAUTH_SECRET;
  try {
    process.env.TDEI_OAUTH_SECRET = "secret-one";
    const code = sealAuthorizationCode(tokens, "http://127.0.0.1:9/callback", codeChallengeS256(verifier));
    assert.equal(openAuthorizationCode(code, verifier).access_token, "alice-access");
    process.env.TDEI_OAUTH_SECRET = "secret-two";
    assert.throws(() => openAuthorizationCode(code, verifier), /invalid_grant/);
  } finally {
    if (previous === undefined) delete process.env.TDEI_OAUTH_SECRET;
    else process.env.TDEI_OAUTH_SECRET = previous;
  }
});

test("a login cookie signed with values derivable from public data is rejected", () => {
  const apiUrl = "https://api.example.test";
  const pending = {
    slug: "tdei-core-dev",
    redirectUri: "http://127.0.0.1:9/callback",
    state: "attacker-state",
    codeChallenge: "attacker-challenge",
    exp: Date.now() + 60_000,
  };
  const body = Buffer.from(JSON.stringify(pending)).toString("base64url");
  // What an attacker could compute before this fix: the key came from public values only.
  const legacyKey = createHash("sha256").update(`tdei-mcp-oauth-v1\n${apiUrl}\n${pending.slug}\n`).digest();
  const forged = `${body}.${createHmac("sha256", legacyKey).update(body).digest("base64url")}`;
  assert.equal(readOAuthCookie(`tdei_oauth=${forged}`, apiUrl, pending.slug), undefined);

  // A cookie the server itself issued still verifies.
  const issued = issueOAuthCookie(pending, apiUrl, true).split(";")[0] ?? "";
  assert.ok(readOAuthCookie(issued, apiUrl, pending.slug));
});

test("an authorization code can be redeemed only once", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = "http://127.0.0.1:9/callback";
  const code = sealAuthorizationCode(tokens, redirectUri, codeChallengeS256(verifier));
  const endpoints = oauthEndpoints("https://mcp.example.test", "tdei-core-dev", "/tdei-core-dev/mcp");
  const redeem = () =>
    dispatchOAuth({
      method: "POST",
      url: new URL(endpoints.token),
      origin: "https://mcp.example.test",
      slug: "tdei-core-dev",
      mcpPath: "/tdei-core-dev/mcp",
      apiUrl: "https://api.example.test",
      cookieHeader: undefined,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
      exchangeCode: async () => {
        throw new Error("unused");
      },
      refreshToken: async () => {
        throw new Error("unused");
      },
    });
  assert.equal((await redeem())?.status, 200);
  const replay = await redeem();
  assert.equal(replay?.status, 400);
  assert.match(replay?.body ?? "", /invalid_grant/);
});

test("a cache entry for one user's token is never served to another user or to no token", async () => {
  let loads = 0;
  const module = new SemanticIntentModule({
    operations: {
      searchDatasets: async () => [],
      listServices: async () => [],
      listJobs: async () => [],
      listProjectGroups: async (_input, context) => {
        loads += 1;
        return [{ tdei_project_group_id: `pg-of-${context.accessToken}`, project_group_name: context.accessToken }];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  const names = async (accessToken: string | undefined) => {
    const result = await module
      .listJobs({ allGroups: true }, accessToken ? { accessToken } : {})
      .catch(() => undefined);
    return result?.status === "complete" ? result.data.appliedFilters.searchedProjectGroups : undefined;
  };
  assert.deepEqual(await names("alice"), ["pg-of-alice"]);
  assert.deepEqual(await names("bob"), ["pg-of-bob"], "bob must not see alice's cached groups");
  assert.deepEqual(await names("alice"), ["pg-of-alice"]);
  assert.equal(loads, 2, "each user loaded once; alice's second call was her own cache hit");
  await names(undefined);
  await names(undefined);
  assert.equal(loads, 4, "calls without a token are never cached");
});

async function postJson(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

test("a remote caller on plain HTTP is refused, over HTTPS is accepted, and status pages stay open", async () => {
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    const plain = await postJson(`${handle.url}/mcp`, { "X-Forwarded-Proto": "http", Authorization: "Bearer t" });
    assert.equal(plain.status, 400);
    assert.equal(((await plain.json()) as { code: string }).code, "TDEI_HTTPS_REQUIRED");

    const secure = await postJson(`${handle.url}/mcp`, { "X-Forwarded-Proto": "https" });
    assert.equal(secure.status, 200);
    assert.match(secure.headers.get("strict-transport-security") ?? "", /max-age=\d+/);

    const health = await fetch(`${handle.url}/health`, { headers: { "X-Forwarded-Proto": "http" } });
    assert.notEqual(health.status, 400, "status endpoints carry no token and stay reachable");
  } finally {
    await handle.close();
  }
});

test("MCP and auth responses are never cacheable", async () => {
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    const listed = await postJson(`${handle.url}/mcp`, {});
    assert.match(listed.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(listed.headers.get("x-content-type-options"), "nosniff");

    const challenge = await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tdei_list_my_project_groups", arguments: {} },
      }),
    });
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get("cache-control"), "no-store");
  } finally {
    await handle.close();
  }
});
