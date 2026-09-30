import { strict as assert } from "node:assert";
import test from "node:test";

import { validateSsoCallbackUrl } from "../src/config.js";

test("callback validator rejects https in stdio mode", () => {
  assert.throws(
    () => validateSsoCallbackUrl("https://mcp.example.com/callback", "stdio"),
    /127\.0\.0\.1/,
  );
});

test("callback validator accepts https in http mode", () => {
  assert.equal(
    validateSsoCallbackUrl("https://mcp.example.com/callback", "http"),
    "https://mcp.example.com/callback",
  );
});

test("callback validator accepts loopback in http mode for local dev", () => {
  assert.equal(
    validateSsoCallbackUrl("http://127.0.0.1:3000/callback", "http"),
    "http://127.0.0.1:3000/callback",
  );
});

test("callback validator rejects plain http hostnames in http mode", () => {
  assert.throws(
    () => validateSsoCallbackUrl("http://mcp.example.com/callback", "http"),
    /https/,
  );
});

import { AuthManager, authManager, injectAccessToken } from "../src/auth/auth-manager.js";

test("injectAccessToken does not touch the singleton", () => {
  assert.equal(authManager.getStatus().authenticated, false);
  const ephemeral = injectAccessToken("ephemeral-token", 3600);
  assert.ok(ephemeral instanceof AuthManager);
  assert.notEqual(ephemeral, authManager);
  assert.equal(ephemeral.getStatus().authenticated, true);
  assert.equal(authManager.getStatus().authenticated, false);
});

test("validateToken rejects expired bearer without refresh attempt", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const expired = injectAccessToken("expired-token", 0);
    await assert.rejects(() => expired.validateToken(), /TDEI_TOKEN_EXPIRED/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateToken rejects invalid bearer on probe 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    const bad = injectAccessToken("bad-token", 3600);
    await assert.rejects(() => bad.validateToken(), /TDEI_TOKEN_INVALID/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateToken accepts good bearer on probe success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    const good = injectAccessToken("good-token", 3600);
    await good.validateToken();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { AwsMcpClient } from "../src/aws/aws-mcp-client.js";

class StubAwsMcpClient extends AwsMcpClient {
  public startedWith: string[] = [];
  public closedCount = 0;
  protected override async startChild(accessToken: string): Promise<void> {
    this.startedWith.push(accessToken);
    (this as unknown as Record<string, unknown>)["client"] = {
      listTools: async () => ({
        tools: [
          {
            name: "listServices",
            description: "List TDEI services.",
            inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          },
        ],
      }),
      callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      close: async () => undefined,
    };
  }
  override async close(): Promise<void> {
    this.closedCount += 1;
    await super.close();
  }
}

test("AwsMcpClient uses injected provider instead of singleton", async () => {
  const seen: string[] = [];
  const client = new StubAwsMcpClient(async () => {
    seen.push("provider-called");
    return "bearer-A";
  });
  await client.callTool("listServices", {});
  assert.deepEqual(client.startedWith, ["bearer-A"]);
  assert.deepEqual(seen, ["provider-called"]);
  await client.close();
  assert.equal(client.closedCount, 1);
});

test("two clients with different providers stay isolated", async () => {
  const a = new StubAwsMcpClient(async () => "bearer-A");
  const b = new StubAwsMcpClient(async () => "bearer-B");
  await a.callTool("listServices", {});
  await b.callTool("listServices", {});
  assert.deepEqual(a.startedWith, ["bearer-A"]);
  assert.deepEqual(b.startedWith, ["bearer-B"]);
  await a.close();
  await b.close();
});

import { serveHttp } from "../src/http.js";

// Fixed test port passed via overrides (static imports hoist above any env
// assignment, so config already evaluated by the time module code runs).
const TEST_PORT = 18080;

function mcpBody(id: number, method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function postMcp(url: string, body: string, token?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

test("http.ts import has no side effects on singletons", async () => {
  const auth = await import("../src/auth/auth-manager.js");
  const aws = await import("../src/aws/aws-mcp-client.js");
  await import("../src/http.js");
  assert.equal(auth.authManager.getStatus().authenticated, false);
  assert.equal(aws.awsMcpClient.isConnected(), false);
});

test("POST /mcp without token returns 401 naming tdei_sso_login", async () => {
  const handle = await serveHttp({ createAwsClient: () => { throw new Error("must not spawn"); } }, { port: TEST_PORT });
  try {
    const response = await postMcp(`${handle.url}/mcp`, mcpBody(1, "tools/list"));
    assert.equal(response.status, 401);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, "TDEI_SSO_REQUIRED");
    assert.match(String(body.message), /tdei_sso_login/);
    assert.ok(String(body.loginUrl).includes("/api/v1/sso-redirect"));
  } finally {
    await handle.close();
  }
});

test("POST /mcp with bad bearer returns 401 without spawning child", async () => {
  let spawned = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/project-groups")) {
      return new Response("unauthorized", { status: 401 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const handle = await serveHttp({
      createAwsClient: () => { spawned += 1; throw new Error("must not spawn"); },
    }, { port: TEST_PORT });
    try {
      const response = await postMcp(`${handle.url}/mcp`, mcpBody(1, "tools/list"), "bad-token");
      assert.equal(response.status, 401);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.code, "TDEI_TOKEN_INVALID");
      assert.equal(spawned, 0);
    } finally {
      await handle.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("good bearer serves tools/list and calls; bearers isolated", async () => {
  const originalFetch = globalThis.fetch;
  const seenTokens: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> } & RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/project-groups")) {
      seenTokens.push(String(init?.headers?.["Authorization"] ?? ""));
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const closed: string[] = [];
    const handle = await serveHttp({
      createAwsClient: (token: string) => {
        const stub = new StubAwsMcpClient(async () => token);
        const origClose = stub.close.bind(stub);
        stub.close = async () => { closed.push(token); await origClose(); };
        return stub as unknown as AwsMcpClient;
      },
    }, { port: TEST_PORT });
    try {
      const list = await postMcp(`${handle.url}/mcp`, mcpBody(1, "tools/list"), "good-A");
      assert.equal(list.status, 200);
      const second = await postMcp(`${handle.url}/mcp`, mcpBody(2, "tools/list"), "good-B");
      assert.equal(second.status, 200);
      assert.deepEqual(seenTokens, ["Bearer good-A", "Bearer good-B"]);
      assert.deepEqual(closed, ["good-A", "good-B"]);
    } finally {
      await handle.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
