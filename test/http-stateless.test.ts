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
