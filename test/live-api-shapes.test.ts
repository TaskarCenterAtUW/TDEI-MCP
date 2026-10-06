import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeAwsRecords } from "../src/adapters/aws-result-decoder.js";
import { recordsFrom } from "../src/adapters/tdei-records.js";

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/live-api-shapes.json"), "utf8"),
) as Record<string, unknown>;

function asMcp(body: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
}

test("live project-groups / services / datasets arrays parse for HTTP and MCP paths", () => {
  for (const key of ["listProjectGroups", "listServices", "listDatasetFiles", "oswDatasetViewerFeedbacks"]) {
    const body = fixtures[key];
    const direct = recordsFrom(body);
    const viaMcp = decodeAwsRecords(asMcp(body));
    assert.ok(direct.length > 0, key);
    assert.equal(viaMcp.length, direct.length, key);
  }
});

test("live versions envelopes parse via versions key", () => {
  for (const key of ["listOswVersions", "listApiVersions"]) {
    const body = fixtures[key];
    const direct = recordsFrom(body);
    assert.equal(direct.length, 1, key);
    assert.equal(typeof direct[0]?.version, "string", key);
    assert.equal(decodeAwsRecords(asMcp(body)).length, 1, key);
  }
});

test("service-metrics services array is preferred over nested project_group object", () => {
  const body = fixtures.serviceMetrics;
  const direct = recordsFrom(body);
  assert.equal(direct.length, 2);
  assert.equal(direct[0]?.tdei_service_id, "svc-1");
});

test("wrapped project_groups envelope still parses", () => {
  assert.deepEqual(recordsFrom(fixtures.wrappedProjectGroups), [
    { tdei_project_group_id: "pg-wrap", project_group_name: "Wrapped" },
  ]);
});

test("empty jobs list is a valid complete parse", () => {
  assert.deepEqual(recordsFrom(fixtures.listJobs), []);
  assert.deepEqual(decodeAwsRecords(asMcp(fixtures.listJobs)), []);
});

test("non-JSON upstream text surfaces a short actionable error", () => {
  assert.throws(
    () => decodeAwsRecords({
      content: [{ type: "text", text: "tdei_project_group_id is required for non-admin user" }],
    }),
    /tdei_project_group_id is required/,
  );
});

test("object metrics envelopes are not mistaken for empty list failures", () => {
  assert.deepEqual(recordsFrom(fixtures.systemCapabilities), []);
});
