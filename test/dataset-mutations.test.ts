import { strict as assert } from "node:assert";
import test from "node:test";

import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

function moduleWithMutations() {
  const mutations: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() { return []; },
      async listServices() { return []; },
      async validateDataset(input) {
        mutations.push({ kind: "validate", input: input as unknown as Record<string, unknown> });
        return { jobId: "validation-job", location: "/jobs/validation-job" };
      },
      async uploadDataset(input) {
        mutations.push({ kind: "upload", input: input as unknown as Record<string, unknown> });
        return { jobId: "upload-job", location: "/jobs/upload-job" };
      },
    },
    places: { async forwardGeocode() { return []; } },
  });
  return { module, mutations };
}

test("incomplete validation asks for every missing input without mutating", async () => {
  const harness = moduleWithMutations();
  const result = await harness.module.validateDataset({});
  assert.equal(result.status, "needs_input");
  if (result.status !== "needs_input") return;
  assert.deepEqual(result.missing.map((item) => item.field), ["dataType", "asset"]);
  assert.deepEqual(harness.mutations, []);
});

test("incomplete upload returns target and metadata questions without mutating", async () => {
  const harness = moduleWithMutations();
  const result = await harness.module.uploadDataset({ dataType: "osw" });
  assert.equal(result.status, "needs_input");
  if (result.status !== "needs_input") return;
  assert.deepEqual(result.missing.map((item) => item.field), [
    "asset",
    "projectGroupId",
    "serviceId",
    "metadata.dataset_detail.name",
    "metadata.dataset_detail.version",
    "metadata.dataset_detail.collected_by",
    "metadata.dataset_detail.collection_date",
    "metadata.dataset_detail.data_source",
    "metadata.dataset_detail.schema_version",
  ]);
  assert.deepEqual(harness.mutations, []);
});

test("complete validation and upload return accepted jobs", async () => {
  const harness = moduleWithMutations();
  const asset = {
    kind: "inline_base64" as const,
    name: "dataset.zip",
    mediaType: "application/zip",
    data: "UEsDBA==",
  };
  const validation = await harness.module.validateDataset({ dataType: "osw", asset });
  assert.deepEqual(validation, {
    status: "complete",
    data: { jobId: "validation-job", location: "/jobs/validation-job" },
  });
  const upload = await harness.module.uploadDataset({
    dataType: "osw",
    asset,
    projectGroupId: "group-1",
    serviceId: "service-1",
    metadata: {
      dataset_detail: {
        name: "Seattle OSW",
        version: "1.0",
        collected_by: "City of Seattle",
        collection_date: "2026-09-01",
        data_source: "InHouse",
        schema_version: "0.3",
      },
    },
  });
  assert.deepEqual(upload, {
    status: "complete",
    data: { jobId: "upload-job", location: "/jobs/upload-job" },
  });
  assert.deepEqual(harness.mutations.map((item) => item.kind), ["validate", "upload"]);
});
