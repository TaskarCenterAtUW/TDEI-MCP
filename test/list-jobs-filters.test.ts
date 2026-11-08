import assert from "node:assert/strict";
import test from "node:test";

import { JOB_TYPES, normalizeJobType } from "../src/intents/job-types.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

test("portal job type labels map to the API job_type enum", () => {
  const portal: Record<string, string> = {
    "Clone Dataset": "Clone-Dataset",
    "Confidence - Calculate": "Confidence-Calculate",
    "Filter Dataset by BBox": "Dataset-BBox",
    "Dataset Incline Tag": "Dataset-Incline-Tag",
    "Dataset Publish": "Dataset-Publish",
    "Dataset Reformat": "Dataset-Reformat",
    "Dataset Road Tag": "Dataset-Road-Tag",
    "Dataset Spatial Join": "Dataset-Spatial-Join",
    "Dataset Union": "Dataset-Union",
    "Dataset Upload": "Dataset-Upload",
    "Dataset Validate": "Dataset-Validate",
    "Edit Metadata": "Edit-Metadata",
    "Quality Metric": "Quality-Metric",
  };
  for (const [label, expected] of Object.entries(portal)) assert.equal(normalizeJobType(label), expected, label);
  for (const type of JOB_TYPES) assert.equal(normalizeJobType(type), type);
  assert.equal(normalizeJobType("bbox"), "Dataset-BBox");
  assert.equal(normalizeJobType("convert"), "Dataset-Reformat");
  assert.equal(normalizeJobType("quality report"), "Quality-Report");
  assert.equal(normalizeJobType("not a job"), undefined);
});

function harness() {
  const sent: Array<{ jobType?: string; includeGroupJobs?: boolean }> = [];
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
        sent.push({
          ...(input.jobType ? { jobType: input.jobType } : {}),
          ...(input.includeGroupJobs !== undefined ? { includeGroupJobs: input.includeGroupJobs } : {}),
        });
        return [];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  return { module, sent };
}

test("listJobs sends the API job_type for a portal label and show_group_jobs for Show: All", async () => {
  const { module, sent } = harness();
  await module.listJobs(
    { projectGroupId: "g1", jobType: "Filter Dataset by BBox", includeGroupJobs: true },
    { accessToken: "t" },
  );
  assert.deepEqual(sent, [{ jobType: "Dataset-BBox", includeGroupJobs: true }]);
});

test("listJobs asks instead of sending an unknown job type", async () => {
  const { module, sent } = harness();
  const result = await module.listJobs({ projectGroupId: "g1", jobType: "mystery" }, { accessToken: "t" });
  assert.equal(result.status, "needs_input");
  assert.equal(sent.length, 0);
  if (result.status === "needs_input") {
    assert.equal(result.missing[0]?.field, "jobType");
    assert.ok(result.missing[0]?.allowedValues?.includes("Quality-Report"));
  }
});

function jobsHarness(count: number) {
  const calls: Array<{ pageSize?: number; page?: number }> = [];
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
          ...(input.pageSize ? { pageSize: input.pageSize } : {}),
          ...(input.page ? { page: input.page } : {}),
        });
        return Array.from({ length: count }, (_, i) => ({
          job_id: `j${i}`,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }));
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  return { module, calls };
}

test("a full API page is reported as possibly incomplete, with one call and no paging loop", async () => {
  const { module, calls } = jobsHarness(50);
  const result = await module.listJobs({ projectGroupId: "g1" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { pageSize: 50, page: 1 });
  assert.equal(result.data.truncation.apiPageFull, true);
  assert.equal(result.data.truncation.mayHaveMore, true);
  assert.equal(result.data.jobs.length, 20);
  assert.match(result.data.truncation.note, /narrow it/);
  assert.equal(String(result.data.jobs[0]?.job_id), "j49");
});

test("a short API page is reported as complete", async () => {
  const { module } = jobsHarness(7);
  const result = await module.listJobs({ projectGroupId: "g1" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.truncation.mayHaveMore, false);
  assert.equal(result.data.truncation.shown, 7);
  assert.match(result.data.truncation.note, /Complete for the filters used/);
});

test("more matches than the display limit are flagged even when the API page is not full", async () => {
  const { module } = jobsHarness(30);
  const result = await module.listJobs({ projectGroupId: "g1", limit: 10 }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.truncation.apiPageFull, false);
  assert.equal(result.data.truncation.mayHaveMore, true);
  assert.equal(result.data.jobs.length, 10);
});
