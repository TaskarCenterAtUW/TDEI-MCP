import { strict as assert } from "node:assert";
import test from "node:test";

import { OpenApiToolsLifecycle } from "../src/openapi/openapi-tools-lifecycle.js";
import { BinaryTdeiDownloads } from "../src/adapters/binary-tdei-downloads.js";

function makeAuth() {
  return {
    getTokenVersion: () => 1,
    async getAccessToken() {
      return "test-token";
    },
    async logout() {
      return {
        logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
        callbackUrl: "http://127.0.0.1:8765/callback",
        completion: Promise.resolve(),
      };
    },
  };
}

test("lifecycle routes binary downloads through the dedicated adapter", async () => {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const { registerTdeiOpenApiTools } = await import("../src/tdei/register-openapi-tools.js");
  const server = new McpServer({ name: "binary-routing-test", version: "1.0.0" });

  const auth = makeAuth();
  let childCalls = 0;
  const openapi = {
    async listTools() {
      return {
        tools: [
          {
            name: "getOswFile",
            description: "Streams the dataset zip file.",
            inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          },
        ],
      };
    },
    async callTool(_name: string, _args: Record<string, unknown>) {
      childCalls += 1;
      // Generic text tool execution must never receive ZIP bytes.
      throw new Error("'utf-8' codec can't decode byte 0x83 in position 50");
    },
    async close() {},
  };
  const downloaded: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const downloads = {
    async download(tool: string, input: Record<string, unknown>) {
      downloaded.push({ tool, input });
      return {
        tool,
        method: "GET" as const,
        path: "/api/v1/osw/yakima-1",
        filename: "getOswFile-yakima-1.zip",
        curlCommand:
          'curl -L -H "Authorization: Bearer $TDEI_TOKEN" "https://api.test/api/v1/osw/yakima-1" -o "getOswFile-yakima-1.zip"',
        instruction: "Run on the CLIENT machine.",
      };
    },
  };

  const lifecycle = new OpenApiToolsLifecycle(server, auth, openapi, registerTdeiOpenApiTools, downloads);
  await lifecycle.load();
  const result = await lifecycle.callTool("getOswFile", { tdei_dataset_id: "yakima-1" });

  assert.deepEqual(result, {
    tool: "getOswFile",
    method: "GET",
    path: "/api/v1/osw/yakima-1",
    filename: "getOswFile-yakima-1.zip",
    curlCommand:
      'curl -L -H "Authorization: Bearer $TDEI_TOKEN" "https://api.test/api/v1/osw/yakima-1" -o "getOswFile-yakima-1.zip"',
    instruction: "Run on the CLIENT machine.",
  });
  assert.deepEqual(downloaded, [{ tool: "getOswFile", input: { tdei_dataset_id: "yakima-1" } }]);
  assert.equal(childCalls, 0);
});

test("lifecycle routes JSON tools to the OpenAPI provider", async () => {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const { registerTdeiOpenApiTools } = await import("../src/tdei/register-openapi-tools.js");
  const server = new McpServer({ name: "binary-routing-json-test", version: "1.0.0" });

  const auth = makeAuth();
  const openapi = {
    async listTools() {
      return {
        tools: [
          {
            name: "listServices",
            description: "List TDEI services.",
            inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          },
        ],
      };
    },
    async callTool(name: string, _args: Record<string, unknown>) {
      assert.equal(BinaryTdeiDownloads.isDownloadTool(name), false);
      return { content: [{ type: "text" as const, text: "services" }] };
    },
    async close() {},
  };

  const lifecycle = new OpenApiToolsLifecycle(server, auth, openapi, registerTdeiOpenApiTools);
  await lifecycle.load();
  const result = await lifecycle.callTool("listServices", {});
  assert.deepEqual(result, { content: [{ type: "text", text: "services" }] });
});
