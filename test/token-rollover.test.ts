import { strict as assert } from "node:assert";
import test from "node:test";

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
