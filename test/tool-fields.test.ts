import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { TOOL_SPEC_FIELDS } from "../src/intents/generated/tool-fields.generated.js";
import { describeWithFields, registerSemanticTools } from "../src/intents/register-tools.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";
import { TOOL_SPEC_BINDINGS } from "../src/intents/tool-spec-map.js";
import { summarizeFields } from "../src/mcp/field-summary.js";
import { OpenApiMcpClient } from "../src/openapi/openapi-mcp-client.js";

async function listSemanticTools() {
  const module = new SemanticIntentModule({
    operations: {
      searchDatasets: async () => [],
      listServices: async () => [],
      listProjectGroups: async () => [],
      listJobs: async () => [],
    },
    places: { forwardGeocode: async () => [] },
  });
  const server = new McpServer({ name: "fields", version: "1.0.0" });
  registerSemanticTools(server, module);
  const client = new Client({ name: "fields-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const listed = await client.listTools();
  await client.close();
  return listed.tools;
}

test("every semantic tool has a spec binding and generated fields, and the reverse", async () => {
  const tools = (await listSemanticTools()).map((t) => t.name).sort();
  assert.deepEqual(Object.keys(TOOL_SPEC_BINDINGS).sort(), tools);
  assert.deepEqual(Object.keys(TOOL_SPEC_FIELDS).sort(), tools);
});

test("spec-required and one-of fields all exist in the tool's input schema", async () => {
  for (const tool of await listSemanticTools()) {
    const keys = Object.keys((tool.inputSchema.properties as Record<string, unknown>) ?? {});
    const spec = TOOL_SPEC_FIELDS[tool.name]!;
    for (const field of [...spec.required, ...(spec.oneOf ?? [])]) {
      assert.ok(keys.includes(field), `${tool.name}: spec field "${field}" is not an input (has: ${keys.join(", ")})`);
    }
  }
});

test("tool descriptions list required and optional fields", async () => {
  const tools = await listSemanticTools();
  const upload = tools.find((t) => t.name === "tdei_upload_dataset")!;
  assert.match(upload.description ?? "", /Fields - required: dataType, asset, projectGroupId, serviceId, metadata\./);
  assert.match(upload.description ?? "", /optional: .*derivedFromDatasetId/);
  const find = tools.find((t) => t.name === "tdei_find_datasets")!;
  assert.match(
    find.description ?? "",
    /required: none \(plus at least one of: place, bbox, projectGroupId, tdeiDatasetId\)/,
  );
  const jobs = tools.find((t) => t.name === "tdei_list_jobs")!;
  assert.match(jobs.description ?? "", /required: none/, "project group is fanned out, so it is not mandatory");
});

test("describeWithFields leaves unknown tools untouched", () => {
  assert.equal(describeWithFields("not_a_tool", "base", ["a"]), "base");
});

test("summarizeFields caps a long optional list", () => {
  const optional = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const line = summarizeFields({ required: ["id"], optional })!;
  assert.match(line, /required: id\. optional: f0, .*f11 \(\+8 more\)\./);
});

test("raw OpenAPI tools get required/optional fields from the spec", async () => {
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    logger: () => undefined,
    loadSpec: async () => ({
      paths: {
        "/jobs/{job_id}": {
          get: {
            operationId: "getJob",
            summary: "Get a job",
            parameters: [
              { name: "job_id", in: "path", required: true, schema: { type: "string" } },
              { name: "file", in: "query", schema: { type: "string" } },
            ],
          },
        },
        "/ping": { get: { operationId: "ping" } },
      },
    }),
  });
  const { tools } = await client.listTools();
  assert.match(
    tools.find((t) => t.name === "getJob")?.description ?? "",
    /Fields - required: job_id\. optional: file\./,
  );
  assert.equal(tools.find((t) => t.name === "ping")?.description, undefined);
});
