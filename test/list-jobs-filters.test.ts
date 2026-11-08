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
