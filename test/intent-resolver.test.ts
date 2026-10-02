import { strict as assert } from "node:assert";
import test from "node:test";

import { resolveUserIntent } from "../src/intents/intent-resolver.js";

test("project, organization, and group aliases map to authenticated project groups", () => {
  for (const request of [
    "Which projects can I access?",
    "List my organizations",
    "Show my groups",
  ]) {
    assert.deepEqual(resolveUserIntent(request), {
      status: "complete",
      data: {
        intent: "list_my_project_groups",
        tool: "tdei_list_my_project_groups",
        apiOperation: "listProjectGroups",
        method: "GET",
        path: "/api/v1/project-groups",
      },
    });
  }
});

test("supported user intents map deterministically to semantic tools and APIs", () => {
  const cases = [
    ["find the latest OSW dataset", "tdei_find_datasets", "listDatasetFiles"],
    ["list services for my project", "tdei_list_services", "listServices"],
    ["validate this GTFS pathways zip", "tdei_validate_dataset", "validateDataset"],
    ["upload this sidewalk dataset", "tdei_upload_dataset", "uploadDataset"],
  ] as const;

  for (const [request, tool, apiOperation] of cases) {
    const result = resolveUserIntent(request);
    assert.equal(result.status, "complete");
    if (result.status !== "complete") continue;
    assert.equal(result.data.tool, tool);
    assert.equal(result.data.apiOperation, apiOperation);
  }
});

test("requests spanning multiple actions return structured clarification", () => {
  const result = resolveUserIntent("Validate and upload this dataset");

  assert.equal(result.status, "ambiguous");
  if (result.status !== "ambiguous") return;
  assert.match(result.question ?? "", /validate.*upload/i);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.tool),
    ["tdei_validate_dataset", "tdei_upload_dataset"],
  );
  assert.deepEqual(result.accepted, { request: "Validate and upload this dataset" });
});

test("requests explicitly combining domains return each deterministic candidate", () => {
  const result = resolveUserIntent("Show my projects and services");

  assert.equal(result.status, "ambiguous");
  if (result.status !== "ambiguous") return;
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.tool),
    ["tdei_list_services", "tdei_list_my_project_groups"],
  );
});

test("unknown requests ask which supported domain the user means", () => {
  const result = resolveUserIntent("Help me with TDEI");

  assert.equal(result.status, "needs_input");
  if (result.status !== "needs_input") return;
  assert.deepEqual(result.missing[0]?.allowedValues, [
    "projects/project groups",
    "datasets",
    "services",
    "validate a dataset",
    "upload a dataset",
  ]);
});
