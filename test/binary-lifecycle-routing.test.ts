import { strict as assert } from "node:assert";
import test from "node:test";

import { AwsToolsLifecycle } from "../src/aws/aws-tools-lifecycle.js";
import { BinaryTdeiDownloads } from "../src/adapters/binary-tdei-downloads.js";

function makeAuth() {
  return {
    getTokenVersion: () => 1,
    async getAccessToken() { return "test-token"; },
    async logout() {
      return {
        logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
        callbackUrl: "http://127.0.0.1:8765/callback",
        completion: Promise.resolve(),
      };
    },
  };
}

test("lifecycle routes binary downloads locally, never to the AWS child", async () => {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const { registerAwsTools } = await import("../src/aws/register-aws-tools.js");
  const server = new McpServer({ name: "binary-routing-test", version: "1.0.0" });

  const auth = makeAuth();
  let childCalls = 0;
  const aws = {
    async listTools() {
      return {
        tools: [{
          name: "getOswFile",
          description: "Streams the dataset zip file.",
          inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
        }],
      };
    },
    async callTool(_name: string, _args: Record<string, unknown>) {
      childCalls += 1;
      // This is what the Python child does with ZIP bytes: strict UTF-8 decode.
      throw new Error("'utf-8' codec can't decode byte 0x83 in position 50");
    },
    async close() {},
  };
  const downloaded: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const downloads = {
    async download(tool: string, input: Record<string, unknown>) {
      downloaded.push({ tool, input });
      return { tool, path: "/tmp/fake.zip", bytes: 123 };
    },
  };

  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools, downloads);
  await lifecycle.load();
  const result = await lifecycle.callTool("getOswFile", { tdei_dataset_id: "yakima-1" });

  assert.deepEqual(result, { tool: "getOswFile", path: "/tmp/fake.zip", bytes: 123 });
  assert.deepEqual(downloaded, [{ tool: "getOswFile", input: { tdei_dataset_id: "yakima-1" } }]);
  assert.equal(childCalls, 0);
});

test("lifecycle still routes JSON tools to the AWS child", async () => {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const { registerAwsTools } = await import("../src/aws/register-aws-tools.js");
  const server = new McpServer({ name: "binary-routing-json-test", version: "1.0.0" });

  const auth = makeAuth();
  const aws = {
    async listTools() {
      return {
        tools: [{
          name: "listServices",
          description: "List TDEI services.",
          inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
        }],
      };
    },
    async callTool(name: string, _args: Record<string, unknown>) {
      assert.equal(BinaryTdeiDownloads.isDownloadTool(name), false);
      return { content: [{ type: "text" as const, text: "services" }] };
    },
    async close() {},
  };

  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools);
  await lifecycle.load();
  const result = await lifecycle.callTool("listServices", {});
  assert.deepEqual(result, { content: [{ type: "text", text: "services" }] });
});
