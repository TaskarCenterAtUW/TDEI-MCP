import assert from "node:assert/strict";
import { test } from "node:test";
import { exportToTdeiRunbook } from "../src/tdei-workspace/export-to-tdei.js";
import { augmentWorkspaceToolDescription } from "../src/tdei-workspace/tool-instructions.js";

const envs = [
  { name: "tdei-workspace-dev", osm: "osm.workspaces-dev.sidewalks.washington.edu", core: "api-dev.tdei.us" },
  { name: "tdei-workspace-stage", osm: "osm.workspaces-stage.sidewalks.washington.edu", core: "api-stage.tdei.us" },
  { name: "tdei-workspace-prod", osm: "osm.workspaces.sidewalks.washington.edu", core: "api.tdei.us" },
] as const;

test("export runbook covers the same calls as the Workspaces export", () => {
  const text = exportToTdeiRunbook({ TDEI_MCP_NAME: "tdei-workspace-dev" } as NodeJS.ProcessEnv);
  for (const needle of [
    "get_workspace_bbox",
    "/api/0.6/map",
    "0.0000001",
    "X-Workspace",
    "osw/convert",
    "job/download",
    "osw/upload/<projectGroupId>/<serviceId>",
    "derived_from_dataset_id",
    "metadata.json",
    "changeset.zip",
    "dataset_area",
    "gtfs-pathways/upload",
  ]) {
    assert.ok(text.includes(needle), needle);
  }
  assert.match(text, /holds no data/);
  assert.match(text, /recommended way is the Workspaces web UI/);
  assert.match(text, /Never print the SSO bearer/);
});

test("export runbook points only at its own environment's hosts", () => {
  for (const server of envs) {
    const text = exportToTdeiRunbook({ TDEI_MCP_NAME: server.name } as NodeJS.ProcessEnv);
    assert.ok(text.includes(`https://${server.osm}/api/0.6`), `${server.name} osm`);
    assert.ok(text.includes(`https://${server.core}/api/v1`), `${server.name} core`);
    for (const other of envs) {
      if (other.name === server.name) continue;
      assert.ok(!text.includes(`https://${other.osm}/`), `${server.name} must not mention ${other.osm}`);
      assert.ok(!text.includes(`https://${other.core}/`), `${server.name} must not mention ${other.core}`);
    }
  }
});

test("the bbox tool points at the export runbook", () => {
  const text =
    augmentWorkspaceToolDescription("get_workspace_bbox_api_v1_workspaces__workspace_id__bbox_get", "") ?? "";
  assert.match(text, /recommended way is the Workspaces web UI/);
});
