import assert from "node:assert/strict";
import test from "node:test";

import { truncateText, MAX_OUTPUT_BYTES } from "../src/mcp/errors.js";
import { SemanticIntentModule, type TdeiOperations } from "../src/intents/semantic-intent-module.js";

function harness(groupCount: number, opts: { failGroup?: string; delayMs?: number } = {}) {
  const stats = { groupCalls: 0, inFlight: 0, maxInFlight: 0, jobCalls: [] as string[] };
  const operations: TdeiOperations = {
    async searchDatasets() {
      return [];
    },
    async listServices() {
      return [];
    },
    async listProjectGroups() {
      stats.groupCalls += 1;
      return Array.from({ length: groupCount }, (_, i) => ({ tdei_project_group_id: `g${i}` }));
    },
    async listJobs(input) {
      stats.jobCalls.push(String(input.projectGroupId));
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 10));
      stats.inFlight -= 1;
      if (input.projectGroupId === opts.failGroup) throw new Error("forbidden");
      return [{ job_id: `job-${input.projectGroupId}` }];
    },
  };
  const module = new SemanticIntentModule({
    operations,
    places: { forwardGeocode: async () => [] },
  });
  return { module, stats };
}

test("listJobs fans out with bounded concurrency and keeps group order", async () => {
  const { module, stats } = harness(12);
  const result = await module.listJobs({ limit: 50, allGroups: true }, { accessToken: "tok" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.ok(stats.maxInFlight > 1, "expected parallel requests");
  assert.ok(stats.maxInFlight <= 5, `concurrency capped at 5, saw ${stats.maxInFlight}`);
  assert.deepEqual(
    result.data.jobs.map((j) => j.job_id),
    Array.from({ length: 12 }, (_, i) => `job-g${i}`),
  );
});

test("listJobs skips a failing group without failing the call", async () => {
  const { module } = harness(3, { failGroup: "g1" });
  const result = await module.listJobs({ allGroups: true }, { accessToken: "tok" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(
    result.data.jobs.map((j) => j.job_id),
    ["job-g0", "job-g2"],
  );
});

test("project group ids are cached per token", async () => {
  const { module, stats } = harness(2);
  await module.listJobs({ allGroups: true }, { accessToken: "a" });
  await module.listJobs({ allGroups: true }, { accessToken: "a" });
  assert.equal(stats.groupCalls, 1);
  await module.listJobs({ allGroups: true }, { accessToken: "b" });
  assert.equal(stats.groupCalls, 2);
});

test("a failed project group lookup is not cached", async () => {
  let calls = 0;
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return [{ tdei_project_group_id: "g0" }];
      },
      async listJobs() {
        return [];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  await assert.rejects(module.listJobs({ allGroups: true }, { accessToken: "a" }));
  const second = await module.listJobs({ allGroups: true }, { accessToken: "a" });
  assert.equal(second.status, "complete");
  assert.equal(calls, 2);
});

test("truncateText leaves short text alone and cuts large text on a character boundary", () => {
  assert.deepEqual(truncateText("héllo"), { text: "héllo", truncated: false });
  const big = "é".repeat(MAX_OUTPUT_BYTES); // 2 bytes each, well over the limit
  const out = truncateText(big);
  assert.equal(out.truncated, true);
  assert.ok(!out.text.includes("�"), "must not split a multi-byte character");
  assert.ok(Buffer.byteLength(out.text) < MAX_OUTPUT_BYTES + 200);
});

test("listJobs returns the newest jobs across groups, undated last", async () => {
  const byGroup: Record<string, Array<Record<string, unknown>>> = {
    g0: [{ job_id: "old", created_at: "2026-01-01T00:00:00Z" }, { job_id: "undated" }],
    g1: [{ job_id: "newest", created_at: "2026-03-01T00:00:00Z" }],
    g2: [{ job_id: "mid", created_at: "2026-02-01T00:00:00Z" }],
  };
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [{ tdei_project_group_id: "g0" }, { tdei_project_group_id: "g1" }, { tdei_project_group_id: "g2" }];
      },
      async listJobs(input) {
        return byGroup[String(input.projectGroupId)] ?? [];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  const result = await module.listJobs({ limit: 3, allGroups: true }, { accessToken: "t" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(
    result.data.jobs.map((j) => j.job_id),
    ["newest", "mid", "old"],
  );
});
