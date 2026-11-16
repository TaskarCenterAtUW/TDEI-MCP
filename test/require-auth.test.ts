import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { ensureSessionAuth } from "../src/auth/require-auth.js";
import { registerSemanticTools } from "../src/intents/register-tools.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";
import { formatError, SsoRequiredError } from "../src/mcp/errors.js";
import { OpenApiToolsLifecycle } from "../src/openapi/openapi-tools-lifecycle.js";

const LOGIN_URL = "https://auth.example.test/sso-redirect?client_id=tdei-mcp";
const CALLBACK_URL = "http://127.0.0.1:18765/callback";

function pendingLogin() {
  return {
    loginUrl: LOGIN_URL,
    callbackUrl: CALLBACK_URL,
    completion: new Promise<void>(() => undefined),
  };
}

test("ensureSessionAuth resolves without starting a login when the token is usable", async () => {
  let starts = 0;
  const auth = {
    getAccessToken: async () => "good-token",
    startSsoLogin: async () => {
      starts += 1;
      return pendingLogin();
    },
  };
  await ensureSessionAuth(auth);
  assert.equal(starts, 0);
});

test("ensureSessionAuth starts one login and throws copy-pasteable URLs when signed out", async () => {
  let starts = 0;
  let pending: ReturnType<typeof pendingLogin> | undefined;
  const auth = {
    getAccessToken: async () => {
      throw new Error("TDEI_SSO_REQUIRED");
    },
    // Mirrors AuthManager: the first call starts the login, later calls reuse it.
    startSsoLogin: async () => {
      if (!pending) {
        starts += 1;
        pending = pendingLogin();
      }
      return pending;
    },
  };
  const first = await ensureSessionAuth(auth).then(
    () => assert.fail("expected SsoRequiredError"),
    (err: unknown) => err,
  );
  assert.ok(first instanceof SsoRequiredError);
  assert.equal(first.loginUrl, LOGIN_URL);
  assert.equal(first.callbackUrl, CALLBACK_URL);
  assert.match(first.message, /tdei_sso_complete/);

  // A second unauthenticated call reuses the pending login: no new listener.
  const second = await ensureSessionAuth(auth).then(
    () => assert.fail("expected SsoRequiredError"),
    (err: unknown) => err,
  );
  assert.ok(second instanceof SsoRequiredError);
  assert.equal(starts, 1);
});

test("ensureSessionAuth surfaces a port conflict instead of a bare login URL", async () => {
  const auth = {
    getAccessToken: async () => {
      throw new Error("TDEI_SSO_REQUIRED");
    },
    startSsoLogin: async () => {
      throw new Error("Unable to start TDEI SSO callback server at http://127.0.0.1:8765: EADDRINUSE.");
    },
  };
  const error = await ensureSessionAuth(auth).then(
    () => assert.fail("expected SsoRequiredError"),
    (err: unknown) => err,
  );
  assert.ok(error instanceof SsoRequiredError);
  assert.equal(error.loginUrl, undefined);
  assert.match(error.message, /EADDRINUSE/);
});

test("formatError carries loginUrl/callbackUrl on SsoRequiredError only", () => {
  const withUrls = JSON.parse(
    String(
      formatError(new SsoRequiredError("login needed", { loginUrl: LOGIN_URL, callbackUrl: CALLBACK_URL })).content[0]
        .text,
    ),
  ) as Record<string, unknown>;
  assert.equal(withUrls.code, "TDEI_SSO_REQUIRED");
  assert.equal(withUrls.loginUrl, LOGIN_URL);
  assert.equal(withUrls.callbackUrl, CALLBACK_URL);

  const plain = JSON.parse(String(formatError(new Error("TDEI_SSO_REQUIRED")).content[0].text)) as Record<
    string,
    unknown
  >;
  assert.equal(plain.code, "TDEI_SSO_REQUIRED");
  assert.ok(!("loginUrl" in plain));
});

test("semantic tools do not run when the auth gate rejects", async () => {
  let ran = 0;
  const module = new SemanticIntentModule({
    operations: {
      async listProjectGroups() {
        ran += 1;
        return [];
      },
    },
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });
  const server = new McpServer({ name: "require-auth-test", version: "1.0.0" });
  registerSemanticTools(
    server,
    module,
    () => ({}),
    async () => {
      throw new SsoRequiredError("login needed", { loginUrl: LOGIN_URL, callbackUrl: CALLBACK_URL });
    },
  );
  const client = new Client({ name: "require-auth-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name: "tdei_list_my_project_groups", arguments: {} })) as {
      isError?: boolean;
      content: [{ type: string; text: string }];
    };
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    assert.equal(payload.code, "TDEI_SSO_REQUIRED");
    assert.equal(payload.loginUrl, LOGIN_URL);
    assert.equal(ran, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("lifecycle callTool never reaches upstream without a session", async () => {
  let upstream = 0;
  const openApiSession = {
    close: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      upstream += 1;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  };
  const lifecycle = new OpenApiToolsLifecycle(
    {} as never,
    { logout: async () => ({}) as never, getTokenVersion: () => 0 },
    openApiSession,
    (async () => ({ discovered: 0, registered: 0, skipped: 0, toolSchemas: new Map() })) as never,
    undefined,
    async () => {
      throw new SsoRequiredError("login needed", { loginUrl: LOGIN_URL });
    },
  );
  await assert.rejects(lifecycle.callTool("x", {}), SsoRequiredError);
  assert.equal(upstream, 0);
});
