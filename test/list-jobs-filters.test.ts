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

function jobsHarness(pages: Array<Array<{ job_id: string; created_at: string }>>) {
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
        return (pages[(input.page ?? 1) - 1] ?? []) as Array<Record<string, unknown>>;
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  return { module, calls };
}

const jobsPage = (count: number, start = 0): Array<{ job_id: string; created_at: string }> =>
  Array.from({ length: count }, (_, i) => ({
    job_id: `j${start + i}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, start + i)).toISOString(),
  }));

test("a full first page is followed automatically and a short page ends the scan", async () => {
  const { module, calls } = jobsHarness([jobsPage(50), jobsPage(7, 50)]);
  const result = await module.listJobs({ projectGroupId: "g1" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(calls, [
    { pageSize: 50, page: 1 },
    { pageSize: 50, page: 2 },
  ]);
  assert.equal(result.data.summary.pagesRead, 2);
  assert.equal(result.data.summary.matchingJobs, 57);
  assert.equal(result.data.summary.duplicatesRemoved, 0);
  assert.equal(result.data.truncation.truncated, false);
  assert.equal(result.data.truncation.mayHaveMore, true);
  assert.equal(result.data.jobs.length, 50);
  assert.equal(String(result.data.jobs[0]?.job_id), "j56");
  assert.match(result.data.truncation.note, /Showing 50 of 57/);
});

test("a full scan reports complete when every match fits the display limit", async () => {
  const { module } = jobsHarness([jobsPage(50), jobsPage(7, 50)]);
  const result = await module.listJobs({ projectGroupId: "g1", limit: 100 }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.truncation.mayHaveMore, false);
  assert.equal(result.data.truncation.shown, 57);
  assert.equal(result.data.jobs.length, 57);
  assert.match(result.data.truncation.note, /Complete for the filters used/);
});

test("a short API page is reported as complete", async () => {
  const { module, calls } = jobsHarness([jobsPage(7)]);
  const result = await module.listJobs({ projectGroupId: "g1" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(calls.length, 1);
  assert.equal(result.data.truncation.mayHaveMore, false);
  assert.equal(result.data.truncation.shown, 7);
  assert.match(result.data.truncation.note, /Complete for the filters used/);
});

test("more matches than the display limit are flagged even when the API scan finished", async () => {
  const { module } = jobsHarness([jobsPage(30)]);
  const result = await module.listJobs({ projectGroupId: "g1", limit: 10 }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.truncation.truncated, false);
  assert.equal(result.data.truncation.mayHaveMore, true);
  assert.equal(result.data.jobs.length, 10);
  assert.equal(result.data.summary.matchingJobs, 30);
});

test("the scan cap stops a runaway group and reports truncation", async () => {
  const full = Array.from({ length: 20 }, () => jobsPage(50));
  const { module, calls } = jobsHarness(full);
  const result = await module.listJobs({ projectGroupId: "g1" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(calls.length, 20);
  assert.equal(result.data.truncation.truncated, true);
  assert.equal(result.data.truncation.mayHaveMore, true);
  assert.match(result.data.truncation.note, /scan cap/);
});

test("jobs are deduped across groups and date windows filter both ends", async () => {
  const shared = { job_id: "shared-1", created_at: "2026-02-01T00:00:00Z" };
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [{ tdei_project_group_id: "g0" }, { tdei_project_group_id: "g1" }];
      },
      async listJobs(input) {
        if (input.page > 1) return [];
        return [shared, { job_id: `only-${input.projectGroupId}`, created_at: "2026-03-01T00:00:00Z" }] as Array<
          Record<string, unknown>
        >;
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  const all = await module.listJobs({ allGroups: true }, { accessToken: "t" });
  assert.equal(all.status, "complete");
  if (all.status !== "complete") return;
  assert.equal(all.data.summary.matchingJobs, 3);
  assert.equal(all.data.summary.duplicatesRemoved, 1);
  assert.deepEqual(all.data.jobs.map((job) => job.job_id).sort(), ["only-g0", "only-g1", "shared-1"]);

  const windowed = await module.listJobs(
    { allGroups: true, createdAfter: "2026-02-15", createdBefore: "2026-03-15" },
    { accessToken: "t" },
  );
  assert.equal(windowed.status, "complete");
  if (windowed.status !== "complete") return;
  assert.equal(windowed.data.summary.matchingJobs, 2);
  assert.equal(windowed.data.summary.duplicatesRemoved, 0);
});

test("the summary reports runtime stats over every match", async () => {
  const { module } = jobsHarness([
    [
      { job_id: "a", created_at: "2026-01-01T00:00:00Z" },
      { job_id: "b", created_at: "2026-01-01T00:01:00Z" },
    ].map((job, i) => ({
      ...job,
      updated_at: new Date(Date.parse(job.created_at) + (i + 1) * 60_000).toISOString(),
    })),
  ]);
  const result = await module.listJobs({ projectGroupId: "g1" }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.summary.runtime, {
    jobsWithRuntime: 2,
    avgRuntimeSeconds: 90,
    minRuntimeSeconds: 60,
    maxRuntimeSeconds: 120,
    stddevRuntimeSeconds: 30,
  });
});
