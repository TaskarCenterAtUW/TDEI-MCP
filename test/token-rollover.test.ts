import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { AwsToolsLifecycle } from "../src/aws/aws-tools-lifecycle.js";
import { registerAwsTools } from "../src/aws/register-aws-tools.js";
import { createServer } from "../src/server.js";

function listServicesTool() {
  return {
    name: "listServices",
    description: "List TDEI services.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  };
}

function makeAuth() {
  let tokenVersion = 1;
  return {
    getTokenVersion: () => tokenVersion,
    bumpVersion: () => { tokenVersion += 1; },
    async logout() {
      return {
        logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
        callbackUrl: "http://127.0.0.1:8765/callback",
        completion: Promise.resolve(),
      };
    },
  };
}

function makeAws() {
  let closes = 0;
  return {
    get closes() { return closes; },
    async listTools() { return { tools: [listServicesTool()] }; },
    async callTool(name: string, _args: Record<string, unknown>) {
      assert.equal(name, "listServices");
      return { content: [{ type: "text" as const, text: "services" }] };
    },
    async close() { closes += 1; },
  };
}

test("token rollover triggers exactly one child restart", async () => {
  const auth = makeAuth();
  const aws = makeAws();
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    awsMcpClient: aws,
    registerAwsTools,
  });
  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools);
  await lifecycle.load();
  await lifecycle.callTool("listServices", {});
  assert.equal(aws.closes, 0);
  auth.bumpVersion();
  await lifecycle.callTool("listServices", {});
  assert.equal(aws.closes, 1);
  await lifecycle.callTool("listServices", {});
  assert.equal(aws.closes, 1);
});

test("concurrent calls during refresh issue one restart only", async () => {
  const auth = makeAuth();
  const aws = makeAws();
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    awsMcpClient: aws,
    registerAwsTools,
  });
  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools);
  await lifecycle.load();
  auth.bumpVersion();
  await Promise.all([
    lifecycle.callTool("listServices", {}),
    lifecycle.callTool("listServices", {}),
    lifecycle.callTool("listServices", {}),
  ]);
  assert.equal(aws.closes, 1);
});

// Without the logout reset, load-after-bump would see a version mismatch and
// close+reload (closes=2). With the reset, post-logout load is a silent first
// load (closes stays 1 — logout's own close).
test("logout resets version so next load starts fresh", async () => {
  const auth = makeAuth();
  const aws = makeAws();
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    awsMcpClient: aws,
    registerAwsTools,
  });
  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools);
  await lifecycle.load();
  await lifecycle.logout();
  auth.bumpVersion();
  await lifecycle.load();
  assert.equal(aws.closes, 1);
});

test("registered tool handlers route through the lifecycle version gate", async () => {
  const auth = makeAuth();
  const aws = makeAws();
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    awsMcpClient: aws,
    registerAwsTools,
  });
  const client = new Client({ name: "rollover-closure-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await client.callTool({ name: "listServices", arguments: {} });
    assert.equal(aws.closes, 0);
    auth.bumpVersion();
    await client.callTool({ name: "listServices", arguments: {} });
    assert.equal(aws.closes, 1);
  } finally {
    await client.close();
  }
});
