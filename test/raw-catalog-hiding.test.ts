import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/server";

import { registerTdeiOpenApiTools } from "../src/tdei-core/register-openapi-tools.js";
import { ALWAYS_HIDDEN_RAW_OPERATIONS, SEMANTIC_COVERED_RAW_OPERATIONS } from "../src/tdei-core/raw-tool-coverage.js";

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

test("TDEI_EXPOSE_ALL_RAW_TOOLS=1 restores the full catalog except confirm-gated destructive ops", async () => {
  process.env.TDEI_EXPOSE_ALL_RAW_TOOLS = "1";
  try {
    const server = new McpServer({ name: "t", version: "0" });
    await registerTdeiOpenApiTools(server, client, all);
    // cloneDataset stays hidden: the raw form bypasses the semantic confirm:true gate.
    assert.deepEqual(registered(server).sort(), ["job-download", "listApiVersions", "listProjectGroups"]);
  } finally {
    delete process.env.TDEI_EXPOSE_ALL_RAW_TOOLS;
  }
});

test("confirm-gated destructive ops stay hidden under EXPOSE_ALL but explicit allow wins", async () => {
  const destructiveClient = {
    listTools: async () => ({
      tools: ["osw-union", "deleteDataset", "editMetadata", "regenerateApiKey", "cloneDataset"].map((name) => ({
        name,
        inputSchema: { type: "object", properties: {}, required: [] },
      })),
    }),
    callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  };
  process.env.TDEI_EXPOSE_ALL_RAW_TOOLS = "1";
  try {
    const server = new McpServer({ name: "t", version: "0" });
    await registerTdeiOpenApiTools(server, destructiveClient, all);
    assert.deepEqual(registered(server), []);
  } finally {
    delete process.env.TDEI_EXPOSE_ALL_RAW_TOOLS;
  }
  const allowServer = new McpServer({ name: "t", version: "0" });
  await registerTdeiOpenApiTools(allowServer, destructiveClient, {
    mode: "allow",
    allow: ["osw-union"],
    deny: [],
    allowTags: [],
    denyTags: [],
  });
  assert.deepEqual(registered(allowServer), ["osw-union"]);
});

test("the union duplicate cannot come back: osw-union is always hidden and covered", () => {
  // tdei_union_datasets enforces confirm:true; osw-union must never sit next to it.
  assert.ok(ALWAYS_HIDDEN_RAW_OPERATIONS.has("osw-union"));
  assert.ok(SEMANTIC_COVERED_RAW_OPERATIONS.has("osw-union"));
  for (const name of ALWAYS_HIDDEN_RAW_OPERATIONS) {
    assert.ok(SEMANTIC_COVERED_RAW_OPERATIONS.has(name), `${name} must stay in the covered set`);
  }
});

test("operations with no semantic equivalent are never in the covered set", () => {
  assert.equal(SEMANTIC_COVERED_RAW_OPERATIONS.has("job-download"), false);
  assert.equal(SEMANTIC_COVERED_RAW_OPERATIONS.has("listApiVersions"), false);
});
