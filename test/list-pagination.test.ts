import assert from "node:assert/strict";
import test from "node:test";

import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

function jobsModule(pages: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ page?: number; pageSize?: number }> = [];
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [{ tdei_project_group_id: "g1", project_group_name: "Demo" }];
      },
      async listJobs(input) {
        calls.push({
          ...(input.page ? { page: input.page } : {}),
          ...(input.pageSize ? { pageSize: input.pageSize } : {}),
        });
        return (pages[(input.page ?? 1) - 1] ?? []) as Array<Record<string, unknown>>;
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  return { module, calls };
}

test("a full jobs page ends the scan at the first short page, no guessing", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => ({
    job_id: `j${i}`,
    created_at: "2026-01-01T00:00:00Z",
  }));
  // Exact-multiple total: page 2 is short (empty), so the response is complete
  // without ever treating the full page 1 as "maybe more".
  const { module, calls } = jobsModule([page1, []]);
  const result = await module.listJobs({ projectGroupId: "g1" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(calls, [
    { page: 1, pageSize: 50 },
    { page: 2, pageSize: 50 },
  ]);
  assert.equal(result.data.summary.matchingJobs, 50);
  assert.deepEqual(result.data.pagination, { page: 1, pageSize: 50, returned: 50, total: 50, hasMore: false });
});

test("services report an exact pagination block with a lookahead on full pages", async () => {
  const servicePages: Array<Array<Record<string, unknown>>> = [
    Array.from({ length: 10 }, (_, i) => ({ tdei_service_id: `s${i}` })),
    [{ tdei_service_id: "s10" }],
  ];
  const calls: Array<Record<string, unknown>> = [];
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices(input) {
        calls.push({ ...input });
        return (servicePages[(input.page ?? 1) - 1] ?? []).slice(0, input.pageSize);
      },
      async listProjectGroups() {
        return [];
      },
      async listJobs() {
        return [];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  const result = await module.listServices({}, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.pagination, { page: 1, pageSize: 10, returned: 10, hasMore: true });
  assert.deepEqual(
    calls.map((call) => ({ page: call.page, pageSize: call.pageSize })),
    [
      { page: 1, pageSize: 10 },
      { page: 2, pageSize: 1 },
    ],
  );

  const next = await module.listServices({ page: 2 }, { accessToken: "t" });
  assert.equal(next.status, "complete");
  if (next.status !== "complete") return;
  assert.equal(next.data.pagination.hasMore, false);
});

test("project groups report hasMore false without a lookahead on short pages", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups(input) {
        calls.push({ ...input });
        return [{ tdei_project_group_id: "g1" }];
      },
      async listJobs() {
        return [];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  const result = await module.listMyProjectGroups({}, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.pagination, { page: 1, pageSize: 50, returned: 1, hasMore: false });
  assert.equal(calls.length, 1);
});

test("feedbacks report the display window with an exact total", async () => {
  const calls: Array<{ page?: number; pageSize?: number }> = [];
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
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
      async listFeedbacks(input) {
        calls.push({ page: input.page, pageSize: input.pageSize });
        const count = input.page === 1 ? 50 : input.page === 2 ? 10 : 0;
        return Array.from({ length: count }, (_, i) => ({ id: `f${i}`, status: "open" }));
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  const result = await module.listFeedbacks({}, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(calls, [
    { page: 1, pageSize: 50 },
    { page: 2, pageSize: 50 },
  ]);
  assert.deepEqual(result.data.pagination, { page: 1, pageSize: 10, returned: 10, total: 60, hasMore: true });
});

test("dataset scans report the display window with an exact total", async () => {
  const datasets = Array.from({ length: 12 }, (_, i) => ({
    tdei_dataset_id: `d${i}`,
    uploaded_timestamp: "2026-01-01T00:00:00Z",
  }));
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets(input) {
        return input.page === 1 ? datasets : [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [{ tdei_project_group_id: "g1" }];
      },
      async listJobs() {
        return [];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  const result = await module.findDatasets({ projectGroupId: "g1", limit: 10 }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.pagination, { page: 1, pageSize: 10, returned: 10, total: 12, hasMore: true });
});

test("dataset name searches settle full pages with a lookahead", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const page1 = Array.from({ length: 10 }, (_, i) => ({ tdei_dataset_id: `d${i}`, name: `Seattle ${i}` }));
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets(input) {
        calls.push({ page: input.page, pageSize: input.pageSize });
        return input.page === 2 ? [] : page1;
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
    },
    places: { forwardGeocode: async () => [] },
  });
  const result = await module.findDatasets({ place: "Seattle" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.pagination, { page: 1, pageSize: 10, returned: 10, hasMore: false });
  assert.deepEqual(calls, [
    { page: 1, pageSize: 10 },
    { page: 2, pageSize: 1 },
  ]);
});
