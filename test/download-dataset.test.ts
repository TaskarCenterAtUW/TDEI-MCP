import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { resolveUserIntent } from "../src/intents/intent-resolver.js";
import { registerSemanticTools } from "../src/intents/register-tools.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

const API_URL = "https://api-dev.tdei.us";

function createModule(datasets: Array<Record<string, unknown>> = [], apiUrl: string = API_URL) {
  const seen: Array<Record<string, unknown>> = [];
  return {
    module: new SemanticIntentModule({
      operations: {
        async searchDatasets(input) {
          seen.push(input as unknown as Record<string, unknown>);
          return datasets;
        },
        async listServices() {
          return [];
        },
        async listProjectGroups() {
          return [];
        },
        async listJobs() {
          return [];
        },
        // NOTE: no downloadFileBytes — the download tool must stay
        // client-side and never touch dataset bytes server-side.
      },
      places: {
        async forwardGeocode() {
          return [];
        },
      },
      apiUrl,
    }),
    seen,
  };
}

test("downloadDataset asks for the dataset id when missing", async () => {
  const { module } = createModule();
  const result = await module.downloadDataset({});
  assert.equal(result.status, "needs_input");
  assert.ok(result.status === "needs_input" && result.missing.some((m) => m.field === "tdeiDatasetId"));
});

test("downloadDataset defaults to the client Downloads folder when outputDir is missing", async () => {
  const { module } = createModule();
  const result = await module.downloadDataset({ tdeiDatasetId: "80296cbe-53ac-463b-b5f6-dad8b8e5e788" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error("expected complete");
  assert.ok(result.data.filePath.startsWith("$HOME/Downloads/"));
  assert.ok(result.data.filePath.endsWith(".zip"));
  assert.match(result.data.instruction, /\$HOME\/Downloads/);
});

test("downloadDataset returns a client-side curl command without fetching bytes", async () => {
  const { module, seen } = createModule();
  const result = await module.downloadDataset({
    tdeiDatasetId: "80296cbe-53ac-463b-b5f6-dad8b8e5e788",
    dataType: "osw",
    outputDir: "/Users/tester/downlaods",
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error("expected complete");
  assert.equal(result.data.tdeiDatasetId, "80296cbe-53ac-463b-b5f6-dad8b8e5e788");
  assert.equal(result.data.dataType, "osw");
  assert.equal(result.data.method, "GET");
  assert.equal(result.data.path, "/api/v1/osw/80296cbe-53ac-463b-b5f6-dad8b8e5e788");
  assert.match(result.data.filePath, /^\/Users\/tester\/downlaods\//);
  assert.match(result.data.curlCommand, /curl -L/);
  assert.match(result.data.curlCommand, /\$TDEI_TOKEN/);
  assert.ok(result.data.curlCommand.includes(API_URL));
  assert.match(result.data.instruction, /CLIENT machine/);
  // No dataset lookup needed when dataType is explicit.
  assert.equal(seen.length, 0);
});

test("downloadDataset auto-detects flex type and dataset name for the filename", async () => {
  const { module } = createModule([{ tdei_dataset_id: "flex-1", data_type: "flex", name: "FLex Seattle" }]);
  const result = await module.downloadDataset({
    tdeiDatasetId: "flex-1",
    outputDir: "/tmp/dl/",
    confirm: true,
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error("expected complete");
  assert.equal(result.data.dataType, "flex");
  assert.equal(result.data.apiOperation, "getGtfsFlexFile");
  assert.equal(result.data.path, "/api/v1/gtfs-flex/flex-1");
  assert.equal(result.data.filePath, "/tmp/dl/FLex_Seattle.zip");
  assert.equal(result.data.datasetName, "FLex Seattle");
});

test("downloadDataset honours an explicit filename and strips path separators", async () => {
  const { module } = createModule();
  const result = await module.downloadDataset({
    tdeiDatasetId: "id-1",
    dataType: "pathways",
    outputDir: "/tmp/dl",
    filename: "../evil.zip",
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error("expected complete");
  assert.equal(result.data.path, "/api/v1/gtfs-pathways/id-1");
  assert.equal(result.data.filePath, "/tmp/dl/.._evil.zip");
});

test("downloadDataset asks for confirmation with a match table for a NAME", async () => {
  const { module } = createModule([
    {
      tdei_dataset_id: "7d6ae05c-8928-4727-bb0d-4717e46242f1",
      data_type: "osw",
      name: "Seattle_WSP_TDEI_OSW_0p2_Dataset_bbox",
    },
  ]);
  const result = await module.downloadDataset({
    tdeiDatasetId: "Seattle_WSP_TDEI_OSW_0p2_Dataset_bbox",
    outputDir: "/tmp/dl",
  });
  assert.equal(result.status, "needs_input");
  if (result.status !== "needs_input") throw new Error("expected needs_input");
  assert.ok(result.missing.some((m) => m.field === "confirm"));
  const question = result.missing.map((m) => m.question).join("\n");
  assert.ok(question.includes("7d6ae05c-8928-4727-bb0d-4717e46242f1"));
  assert.ok(question.includes("| # | name | tdei_dataset_id | data_type | status |"));
});

test("downloadDataset downloads a NAME after confirm:true using the resolved UUID", async () => {
  const { module } = createModule([
    {
      tdei_dataset_id: "7d6ae05c-8928-4727-bb0d-4717e46242f1",
      data_type: "osw",
      name: "Seattle_WSP_TDEI_OSW_0p2_Dataset_bbox",
    },
  ]);
  const result = await module.downloadDataset({
    tdeiDatasetId: "Seattle_WSP_TDEI_OSW_0p2_Dataset_bbox",
    outputDir: "/tmp/dl",
    confirm: true,
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error("expected complete");
  // The resolved UUID — not the raw name — must appear in the download path.
  assert.equal(result.data.tdeiDatasetId, "7d6ae05c-8928-4727-bb0d-4717e46242f1");
  assert.equal(result.data.path, "/api/v1/osw/7d6ae05c-8928-4727-bb0d-4717e46242f1");
  assert.ok(!result.data.path.includes("Seattle_WSP"));
  assert.equal(result.data.datasetName, "Seattle_WSP_TDEI_OSW_0p2_Dataset_bbox");
});

test("downloadDataset lists multiple matches and downloads the selected row", async () => {
  const datasets = [
    { tdei_dataset_id: "11111111-1111-4111-8111-111111111111", data_type: "osw", name: "Seattle Downtown" },
    { tdei_dataset_id: "22222222-2222-4222-8222-222222222222", data_type: "osw", name: "Seattle Downtown 2" },
  ];
  const { module } = createModule(datasets);
  const asked = await module.downloadDataset({ tdeiDatasetId: "Seattle Downtown" });
  assert.equal(asked.status, "needs_input");
  if (asked.status !== "needs_input") throw new Error("expected needs_input");
  assert.ok(asked.missing.some((m) => m.field === "tdeiDatasetId"));
  const question = asked.missing.map((m) => m.question).join("\n");
  assert.ok(question.includes("2 datasets"));
  assert.ok(question.includes("22222222-2222-4222-8222-222222222222"));

  const picked = await module.downloadDataset({ tdeiDatasetId: "Seattle Downtown", selection: 2 });
  assert.equal(picked.status, "complete");
  if (picked.status !== "complete") throw new Error("expected complete");
  assert.equal(picked.data.tdeiDatasetId, "22222222-2222-4222-8222-222222222222");
  assert.equal(picked.data.path, "/api/v1/osw/22222222-2222-4222-8222-222222222222");
});

test("downloadDataset accepts a pasted table row by extracting its UUID", async () => {
  const { module } = createModule();
  const result = await module.downloadDataset({
    tdeiDatasetId:
      "| 1 | Seattle_WSP_TDEI_OSW_0p2_Dataset_bbox | 7d6ae05c-8928-4727-bb0d-4717e46242f1 | osw | Pre-Release |",
    dataType: "osw",
    outputDir: "/tmp/dl",
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error("expected complete");
  assert.equal(result.data.tdeiDatasetId, "7d6ae05c-8928-4727-bb0d-4717e46242f1");
  assert.equal(result.data.path, "/api/v1/osw/7d6ae05c-8928-4727-bb0d-4717e46242f1");
});

test("downloadDataset asks for a UUID when a NAME matches nothing", async () => {
  const { module } = createModule([]);
  const result = await module.downloadDataset({ tdeiDatasetId: "No_Such_Dataset_Name_xyz" });
  assert.equal(result.status, "needs_input");
  assert.ok(result.status === "needs_input" && result.missing.some((m) => m.field === "tdeiDatasetId"));
});

test("download intent resolves to the registered tdei_download_dataset tool", async () => {
  const resolved = resolveUserIntent("download this Seattle dataset");
  assert.equal(resolved.status, "complete");
  if (resolved.status !== "complete") throw new Error("expected complete");
  assert.equal(resolved.data.tool, "tdei_download_dataset");

  const { module } = createModule();
  const server = new McpServer({ name: "download-dataset-test", version: "1.0.0" });
  registerSemanticTools(server, module);
  const client = new Client({ name: "download-dataset-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "tdei_download_dataset"));
    const called = await client.callTool({
      name: "tdei_download_dataset",
      arguments: { tdeiDatasetId: "80296cbe-53ac-463b-b5f6-dad8b8e5e788" },
    });
    const first = called.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.equal(body.status, "complete");
    assert.ok(body.data.filePath.startsWith("$HOME/Downloads/"));
    assert.match(body.data.curlCommand, /curl -L/);
  } finally {
    await client.close();
  }
});

test("feedback download requests do not resolve to dataset download", async () => {
  const resolved = resolveUserIntent("download viewer feedbacks for my project group");
  assert.equal(resolved.status, "complete");
  if (resolved.status !== "complete") throw new Error("expected complete");
  assert.notEqual(resolved.data.tool, "tdei_download_dataset");
});
