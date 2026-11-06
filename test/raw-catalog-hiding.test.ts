import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/server";

import { registerTdeiOpenApiTools } from "../src/tdei/register-openapi-tools.js";
import { SEMANTIC_COVERED_RAW_OPERATIONS } from "../src/tdei/raw-tool-coverage.js";

const tools = ["listProjectGroups", "cloneDataset", "job-download", "listApiVersions"].map((name) => ({
  name,
  inputSchema: { type: "object", properties: {}, required: [] },
}));
const client = {
  listTools: async () => ({ tools }),
  callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};
const all = { mode: "all" as const, allow: [], deny: [], allowTags: [], denyTags: [] };

function registered(server: McpServer): string[] {
  // oxlint-disable-next-line no-underscore-dangle -- SDK keeps its registry on a private field; no public listing without a transport.
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

test("operations covered by a semantic tool are left out of the catalog by default", async () => {
  delete process.env.TDEI_EXPOSE_ALL_RAW_TOOLS;
  const server = new McpServer({ name: "t", version: "0" });
  const result = await registerTdeiOpenApiTools(server, client, all);
  assert.deepEqual(registered(server).sort(), ["job-download", "listApiVersions"]);
  // Hidden operations still report a schema so workflow steps can call them.
  assert.ok(result.toolSchemas.has("listProjectGroups"));
  assert.ok(result.toolSchemas.has("cloneDataset"));
});

test("an explicit allow-list entry exposes a covered operation", async () => {
  delete process.env.TDEI_EXPOSE_ALL_RAW_TOOLS;
  const server = new McpServer({ name: "t", version: "0" });
  await registerTdeiOpenApiTools(server, client, {
    mode: "allow",
    allow: ["cloneDataset", "job-download"],
    deny: [],
    allowTags: [],
    denyTags: [],
  });
  assert.deepEqual(registered(server).sort(), ["cloneDataset", "job-download"]);
});

test("TDEI_EXPOSE_ALL_RAW_TOOLS=1 restores the full catalog", async () => {
  process.env.TDEI_EXPOSE_ALL_RAW_TOOLS = "1";
  try {
    const server = new McpServer({ name: "t", version: "0" });
    await registerTdeiOpenApiTools(server, client, all);
    assert.equal(registered(server).length, 4);
  } finally {
    delete process.env.TDEI_EXPOSE_ALL_RAW_TOOLS;
  }
});

test("operations with no semantic equivalent are never in the covered set", () => {
  assert.equal(SEMANTIC_COVERED_RAW_OPERATIONS.has("job-download"), false);
  assert.equal(SEMANTIC_COVERED_RAW_OPERATIONS.has("listApiVersions"), false);
});
