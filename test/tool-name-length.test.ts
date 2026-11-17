import { strict as assert } from "node:assert";
import test from "node:test";

import {
  defaultOperationName,
  enforceToolNameLength,
  MAX_TOOL_NAME_LENGTH,
  OpenApiMcpClient,
} from "../src/openapi/openapi-mcp-client.js";
import { workspaceOperationName } from "../src/tdei-workspace/operation-names.js";

test("tool names are capped at 64 chars", () => {
  assert.equal(MAX_TOOL_NAME_LENGTH, 64);
  const longId = `get_project_role_api_v1_workspaces__workspace_id__tasking_projects__project_id__roles__user_id__get`;
  assert.ok(longId.length > 64);
  const name = defaultOperationName(longId);
  assert.ok(name.length <= 64, `got ${name.length}: ${name}`);
  assert.match(name, /^[A-Za-z0-9_]{1,64}$/);
  // Deterministic: same input, same output.
  assert.equal(defaultOperationName(longId), name);
  // Different long ids get different names (hash suffix).
  const other = `${longId}_x`;
  assert.notEqual(defaultOperationName(other), name);
});

test("enforceToolNameLength passes short names through untouched", () => {
  assert.equal(enforceToolNameLength("get_my_workspaces", "get_my_workspaces"), "get_my_workspaces");
  assert.equal(enforceToolNameLength("listServices", "listServices"), "listServices");
});

test("workspace operation names use the short function prefix", () => {
  assert.equal(
    workspaceOperationName(
      "get_project_role_api_v1_workspaces__workspace_id__tasking_projects__project_id__roles__user_id__get",
    ),
    "get_project_role",
  );
  assert.equal(
    workspaceOperationName(
      "submit_changeset_api_v1_workspaces__workspace_id__tasking_projects__project_id__tasks__task_number__submit_changeset_post",
    ),
    "submit_changeset",
  );
  assert.equal(workspaceOperationName("get_my_workspaces"), "get_my_workspaces");
  // All short workspace names fit the limit, including the Codex prefix.
  for (const short of ["delete_member_from_workspace_team", "get_privileged_workspace_members", "get_my_workspaces"]) {
    const total = `mcp__tdei-workspace-dev__${short}`.length;
    assert.ok(total <= 64, `${short}: Codex name is ${total} chars`);
  }
});

test("workspace client maps long operationIds to short tool names within the limit", async () => {
  const client = new OpenApiMcpClient({
    apiUrl: "https://ws.example.test",
    operationName: workspaceOperationName,
    loadSpec: async () => ({
      openapi: "3.1.0",
      paths: {
        "/api/v1/workspaces/{workspace_id}/tasking-projects/{project_id}/roles/{user_id}": {
          get: {
            operationId:
              "get_project_role_api_v1_workspaces__workspace_id__tasking_projects__project_id__roles__user_id__get",
            responses: {},
          },
          put: {
            operationId:
              "put_project_role_api_v1_workspaces__workspace_id__tasking_projects__project_id__roles__user_id__put",
            responses: {},
          },
        },
      },
    }),
  });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["get_project_role", "put_project_role"],
  );
  for (const tool of tools) assert.ok(tool.name.length <= 64);
});
