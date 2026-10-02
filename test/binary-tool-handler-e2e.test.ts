import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { registerAwsTools } from "../src/aws/register-aws-tools.js";
import { createServer } from "../src/server.js";

// Drives the reported getOswFile call through the public MCP handler. A valid
// regression test must prove both sides of the routing decision: the local
// binary adapter is called and the UTF-8-decoding AWS child is never called.
test("registered getOswFile tool routes locally, child never sees binary", async () => {
  const childCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const downloadCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const awsClient = {
    async listTools() {
      return {
        tools: [{
          name: "getOswFile",
          description: "Streams the dataset zip file.",
          inputSchema: {
            type: "object" as const,
            properties: { tdei_dataset_id: { type: "string" as const } },
            required: ["tdei_dataset_id"],
            additionalProperties: false,
          },
        }],
      };
    },
    async callTool(name: string, args: Record<string, unknown>) {
      childCalls.push({ name, args });
      throw new Error("'utf-8' codec can't decode byte 0x83 in position 50: invalid start byte");
    },
    async close() {},
    isConnected: () => true,
  };
  const binaryDownloads = {
    async download(tool: string, input: Record<string, unknown>) {
      downloadCalls.push({ tool, input });
      return {
        tool,
        path: "/tmp/getOswFile-yakima.zip",
        bytes: 12_345,
        contentType: "application/zip",
      };
    },
  };

  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async completeSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      async logout() {
        return {
          logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
          callbackUrl: "http://127.0.0.1:8765/callback",
          completion: Promise.resolve(),
        };
      },
      getTokenVersion: () => 1,
    },
    awsMcpClient: awsClient,
    registerAwsTools,
    binaryDownloads,
  });
  const client = new Client({ name: "binary-e2e-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "getOswFile",
      arguments: { tdei_dataset_id: "288715e9-b17f-47b8-837a-eca897987061" },
    });
    assert.notEqual(result.isError, true);
    const first = result.content[0];
    assert.equal(first?.type, "text");
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.deepEqual(body, {
      tool: "getOswFile",
      path: "/tmp/getOswFile-yakima.zip",
      bytes: 12_345,
      contentType: "application/zip",
    });
    assert.deepEqual(downloadCalls, [{
      tool: "getOswFile",
      input: { tdei_dataset_id: "288715e9-b17f-47b8-837a-eca897987061" },
    }]);
    assert.deepEqual(childCalls, []);
  } finally {
    await client.close();
  }
});
