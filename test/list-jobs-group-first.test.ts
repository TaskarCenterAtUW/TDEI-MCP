import assert from "node:assert/strict";
import test from "node:test";

import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

function harness() {
  const stats = { groupCalls: 0, jobGroups: [] as string[] };
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        stats.groupCalls += 1;
        return [
          { tdei_project_group_id: "g-seattle", project_group_name: "Seattle OSW" },
          { tdei_project_group_id: "g-spokane", project_group_name: "Spokane OSW" },
          { tdei_project_group_id: "g-demo", project_group_name: "Demo" },
        ];
      },
      async listJobs(input) {
        stats.jobGroups.push(String(input.projectGroupId));
        return [{ job_id: `job-${input.projectGroupId}`, status: input.status, created_at: "2026-01-01T00:00:00Z" }];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  return { module, stats };
}

const ctx = { accessToken: "tok" };

test("without a group the tool asks for a project group name and lists the options", async () => {
  const { module, stats } = harness();
  const result = await module.listJobs({ status: "IN-PROGRESS" }, ctx);
  assert.equal(result.status, "needs_input");
  if (result.status !== "needs_input") return;
  assert.equal(result.missing[0]?.field, "projectGroupName");
  assert.deepEqual(result.missing[0]?.allowedValues, ["Seattle OSW", "Spokane OSW", "Demo"]);
  assert.match(result.missing[0]?.question ?? "", /say "all"/);
  assert.deepEqual(stats.jobGroups, [], "nothing is fetched until the group is known");
});

test("a project group name is resolved case-insensitively to one request", async () => {
  const { module, stats } = harness();
  const result = await module.listJobs({ projectGroupName: "seattle osw", status: "IN-PROGRESS" }, ctx);
  assert.equal(result.status, "complete");
  assert.deepEqual(stats.jobGroups, ["g-seattle"]);
});

test("a partial name resolves when unique and asks when it matches several or none", async () => {
  const { module, stats } = harness();
  const unique = await module.listJobs({ projectGroupName: "demo" }, ctx);
  assert.equal(unique.status, "complete");
  assert.deepEqual(stats.jobGroups, ["g-demo"]);

  const several = await module.listJobs({ projectGroupName: "OSW" }, ctx);
  assert.equal(several.status, "needs_input");
  if (several.status === "needs_input")
    assert.deepEqual(several.missing[0]?.allowedValues, ["Seattle OSW", "Spokane OSW"]);

  const none = await module.listJobs({ projectGroupName: "Portland" }, ctx);
  assert.equal(none.status, "needs_input");
  if (none.status === "needs_input")
    assert.match(none.missing[0]?.question ?? "", /No project group matches "Portland"/);
  assert.equal(stats.jobGroups.length, 1, "only the unique match fetched jobs");
});

test("an explicit id skips the group lookup entirely", async () => {
  const { module, stats } = harness();
  await module.listJobs({ projectGroupId: "g-demo", jobId: "42" }, ctx);
  assert.equal(stats.groupCalls, 0);
  assert.deepEqual(stats.jobGroups, ["g-demo"]);
});

test("allGroups fans out across every group, and repeated calls reuse the cached group list", async () => {
  const { module, stats } = harness();
  const result = await module.listJobs({ allGroups: true }, ctx);
  assert.equal(result.status, "complete");
  assert.deepEqual([...stats.jobGroups].sort(), ["g-demo", "g-seattle", "g-spokane"]);
  await module.listJobs({ projectGroupName: "Demo" }, ctx);
  await module.listJobs({ projectGroupName: "Seattle OSW" }, ctx);
  assert.equal(stats.groupCalls, 1, "the group list is fetched once and cached");
});
