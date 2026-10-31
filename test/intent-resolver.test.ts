import { strict as assert } from "node:assert";
import test from "node:test";

import { resolveUserIntent } from "../src/intents/intent-resolver.js";

test("project, organization, and group aliases map to authenticated project groups", () => {
  for (const request of ["Which projects can I access?", "List my organizations", "Show my groups"]) {
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
    "dataset details",
    "services",
    "jobs",
    "roles/identity",
    "validate a dataset",
    "upload a dataset",
    "publish a dataset",
    "delete a dataset",
    "clone a dataset",
    "edit metadata",
    "feedbacks",
    "metrics",
    "versions",
    "system info",
    "verify email",
    "recover password",
    "regenerate API key",
  ]);
});

test("every documented alias resolves to its canonical project-group operation", () => {
  const aliases = [
    "project",
    "projects",
    "project group",
    "project groups",
    "organization",
    "organizations",
    "organisation",
    "organisations",
    "org",
    "orgs",
    "group",
    "groups",
  ];

  for (const alias of aliases) {
    const result = resolveUserIntent(`list my ${alias}`);
    assert.equal(result.status, "complete", alias);
    if (result.status !== "complete") continue;
    assert.deepEqual(
      result.data,
      {
        intent: "list_my_project_groups",
        tool: "tdei_list_my_project_groups",
        apiOperation: "listProjectGroups",
        method: "GET",
        path: "/api/v1/project-groups",
      },
      alias,
    );
  }
});

test("all declared validation action and dataset-object combinations resolve", () => {
  for (const action of ["validate", "validation", "verify", "check"]) {
    for (const object of ["dataset", "data", "file", "zip", "osw", "gtfs", "pathways", "flex"]) {
      const result = resolveUserIntent(`${action} this ${object}`);
      assert.equal(result.status, "complete", `${action} ${object}`);
      if (result.status !== "complete") continue;
      assert.equal(result.data.tool, "tdei_validate_dataset", `${action} ${object}`);
      assert.equal(result.data.apiOperation, "validateDataset", `${action} ${object}`);
    }
  }
});

test("all declared upload actions resolve to uploadDataset", () => {
  for (const action of ["upload", "submit", "ingest"]) {
    const result = resolveUserIntent(`${action} this dataset`);
    assert.equal(result.status, "complete", action);
    if (result.status !== "complete") continue;
    assert.equal(result.data.tool, "tdei_upload_dataset", action);
    assert.equal(result.data.apiOperation, "uploadDataset", action);
  }
});

test("every pair of supported intents produces structured ambiguity", () => {
  const combinations = [
    ["list my projects", "find datasets"],
    ["list my projects", "list services"],
    ["list my projects", "validate a dataset"],
    ["list my projects", "upload a dataset"],
    ["find datasets", "list services"],
    ["find datasets", "validate a dataset"],
    ["find datasets", "upload a dataset"],
    ["list services", "validate a dataset"],
    ["list services", "upload a dataset"],
    ["validate", "upload this dataset"],
  ] as const;

  for (const [first, second] of combinations) {
    const request = `${first} and ${second}`;
    const result = resolveUserIntent(request);
    assert.equal(result.status, "ambiguous", request);
    if (result.status !== "ambiguous") continue;
    assert.equal(result.candidates.length, 2, request);
    assert.ok(result.question, request);
    assert.deepEqual(result.accepted, { request }, request);
  }
});

test("roles, jobs, and dataset-detail requests route to the new tools", async () => {
  const cases = [
    ["what are my roles?", "tdei_get_my_identity", "none"],
    ["show my recent uploads", "tdei_list_jobs", "listJobs"],
    ["what is the release status of dataset abc-123?", "tdei_get_dataset_details", "listDatasetFiles"],
    ["does this dataset include inclines?", "tdei_get_dataset_details", "listDatasetFiles"],
  ] as const;

  for (const [request, tool, apiOperation] of cases) {
    const result = resolveUserIntent(request);
    assert.equal(result.status, "complete", request);
    if (result.status !== "complete") continue;
    assert.equal(result.data.tool, tool, request);
    assert.equal(result.data.apiOperation, apiOperation, request);
  }
});

test("job and status questions route to list_jobs, not upload or validate", () => {
  for (const request of [
    "check the upload history",
    "list jobs for upload failures",
    "did my validation finish",
    "has my upload finished",
    "is the validation done",
    "what is the status of my upload",
    "show my recent uploads",
  ]) {
    const result = resolveUserIntent(request);
    assert.equal(result.status, "complete", request);
    if (result.status !== "complete") continue;
    assert.equal(result.data.tool, "tdei_list_jobs", request);
  }
});

test("upload and validate verbs still win when no job or status phrase is present", () => {
  for (const [request, tool] of [
    ["upload this dataset", "tdei_upload_dataset"],
    ["validate this OSW file", "tdei_validate_dataset"],
    ["check my dataset", "tdei_validate_dataset"],
  ] as const) {
    const result = resolveUserIntent(request);
    assert.equal(result.status, "complete", request);
    if (result.status !== "complete") continue;
    assert.equal(result.data.tool, tool, request);
  }
});

test("an upload action combined with a job lookup stays ambiguous", () => {
  const result = resolveUserIntent("upload this file and then show job status");
  assert.equal(result.status, "ambiguous");
  if (result.status !== "ambiguous") return;
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.tool),
    ["tdei_upload_dataset", "tdei_list_jobs"],
  );
});

test("lifecycle, feedback, metrics, versions, system, and auth requests route to the new tools", () => {
  const cases = [
    ["publish this dataset", "tdei_publish_dataset", "publishDataset"],
    ["delete dataset abc-123", "tdei_delete_dataset", "deleteDataset"],
    ["clone this dataset", "tdei_clone_dataset", "cloneDataset"],
    ["edit the metadata of this dataset", "tdei_edit_metadata", "editMetadata"],
    ["list viewer feedbacks", "tdei_list_feedbacks", "listFeedbacks"],
    ["show data metrics", "tdei_get_metrics", "getMetrics"],
    ["which osw versions are supported", "tdei_list_versions", "listVersions"],
    ["show system capabilities", "tdei_get_system_info", "systemInfo"],
    ["verify my email", "tdei_verify_email", "authAction"],
    ["send me the email verification link", "tdei_verify_email", "authAction"],
    ["help me recover my password", "tdei_recover_password", "authAction"],
    ["regenerate my api key", "tdei_regenerate_api_key", "authAction"],
  ] as const;

  for (const [request, tool, apiOperation] of cases) {
    const result = resolveUserIntent(request);
    assert.equal(result.status, "complete", request);
    if (result.status !== "complete") continue;
    assert.equal(result.data.tool, tool, request);
    assert.equal(result.data.apiOperation, apiOperation, request);
  }
});

test("new lifecycle routes do not fire on the legacy corpus", () => {
  for (const [request, tool] of [
    ["what is the release status of dataset abc-123?", "tdei_get_dataset_details"],
    ["does this dataset include inclines?", "tdei_get_dataset_details"],
    ["what are my roles?", "tdei_get_my_identity"],
    ["verify this dataset", "tdei_validate_dataset"],
    ["check my dataset", "tdei_validate_dataset"],
    ["upload this dataset", "tdei_upload_dataset"],
  ] as const) {
    const result = resolveUserIntent(request);
    assert.equal(result.status, "complete", request);
    if (result.status !== "complete") continue;
    assert.equal(result.data.tool, tool, request);
  }
});
