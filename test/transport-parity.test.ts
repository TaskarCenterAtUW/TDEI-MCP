import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createHttpSemanticServer } from "../src/http-semantic-server.js";
import { createServer } from "../src/server.js";
import { registerTdeiOpenApiTools } from "../src/tdei/register-openapi-tools.js";

const API_URL = "https://tdei-parity.example";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function stubFetch(): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = jsonResponse;
    if (url.pathname === "/api/v1/project-groups") {
      return json([{ tdei_project_group_id: "group-1", name: "Group One" }]);
    }
    if (url.pathname === "/api/v1/datasets") {
      return json([
        {
          tdei_dataset_id: "abc-123",
          name: "Seattle OSW",
          status: "Publish",
          data_type: "osw",
          uploaded_timestamp: "2026-09-30T12:00:00Z",
        },
      ]);
    }
    if (url.pathname === "/api/v1/jobs") {
      return json([{ job_id: "job-1", job_type: "publish", status: "COMPLETED" }]);
    }
    if (url.pathname === "/api/v1/osw/publish/abc-123") {
      return json({ job_id: "pub-1" }, 202);
    }
    if (url.pathname === "/api/v1/osw/versions") {
      return json({ osw: "1.0" });
    }
    if (url.pathname === "/api/v1/system/capabilities") {
      return json({ maxUploadMB: 10 });
    }
    if (url.pathname === "/api/v1/api") {
      return json({ v1: "/api/v1" });
    }
    return json({ error: `unexpected ${request.method} ${url.pathname}` }, 500);
  }) as typeof fetch;
}

function stubAuthManager() {
  return {
    async startSsoLogin(): Promise<never> {
      throw new Error("not used");
    },
    async getAccessToken(): Promise<string> {
      return "test-token";
    },
    getStatus: () => ({
      configured: true,
      authenticated: true,
      state: "authenticated" as const,
      loginMethod: "sso" as const,
    }),
    getTokenVersion: () => 1,
    async logout(): Promise<never> {
      throw new Error("not used");
    },
  };
}

function stubOpenApiClient() {
  return {
    async listTools() {
      return { tools: [] };
    },
    async callTool(name: string): Promise<never> {
      throw new Error(`must not use OpenAPI provider (${name})`);
    },
    async close() {},
    isConnected: () => false,
  };
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return JSON.parse(first.type === "text" ? first.text : "{}");
}

test("stdio and HTTP transports expose identical semantic tools with identical results", async (t) => {
  const fetchImpl = stubFetch();
  t.mock.method(globalThis, "fetch", fetchImpl);

  const httpServer = createHttpSemanticServer({
    apiUrl: API_URL,
    fetchImpl,
    accessToken: "test-token",
  });
  const stdioServer = await createServer({
    authManager: stubAuthManager(),
    openApiMcpClient: stubOpenApiClient(),
    registerTdeiOpenApiTools,
  });

  const httpClient = new Client({ name: "parity-http", version: "1.0.0" });
  const stdioClient = new Client({ name: "parity-stdio", version: "1.0.0" });
  const [httpCt, httpSt] = InMemoryTransport.createLinkedPair();
  const [stdioCt, stdioSt] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    httpServer.connect(httpSt),
    httpClient.connect(httpCt),
    stdioServer.connect(stdioSt),
    stdioClient.connect(stdioCt),
  ]);

  try {
    const [httpTools, stdioTools] = await Promise.all([httpClient.listTools(), stdioClient.listTools()]);
    const stdioByName = new Map(stdioTools.tools.map((tool) => [tool.name, tool]));
    assert.ok(httpTools.tools.length > 0);
    for (const tool of httpTools.tools) {
      const match = stdioByName.get(tool.name);
      assert.ok(match, `stdio transport is missing ${tool.name}`);
      assert.equal(match.description, tool.description, `${tool.name} description`);
      assert.deepEqual(match.inputSchema, tool.inputSchema, `${tool.name} schema`);
    }

    const battery: Array<[string, Record<string, unknown>]> = [
      ["tdei_list_my_project_groups", {}],
      ["tdei_find_datasets", { tdeiDatasetId: "abc-123" }],
      ["tdei_get_dataset_details", { tdeiDatasetId: "abc-123" }],
      ["tdei_list_jobs", { projectGroupId: "group-1" }],
      ["tdei_get_system_info", {}],
      ["tdei_list_versions", { dataType: "osw" }],
      ["tdei_publish_dataset", { dataType: "osw", tdeiDatasetId: "abc-123" }],
      ["tdei_delete_dataset", { tdeiDatasetId: "abc-123" }],
      ["tdei_verify_email", {}],
    ];
    for (const [name, args] of battery) {
      const [viaHttp, viaStdio] = await Promise.all([
        callJson(httpClient, name, args),
        callJson(stdioClient, name, args),
      ]);
      assert.deepEqual(viaStdio, viaHttp, `${name} parity`);
    }
  } finally {
    await Promise.all([httpClient.close(), stdioClient.close()]);
  }
});
