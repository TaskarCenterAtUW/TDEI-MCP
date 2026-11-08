import assert from "node:assert/strict";
import test from "node:test";

import {
  getClientSetupJs,
  renderClientSetupPowershell,
  renderClientSetupScript,
  renderSetupOverview,
} from "../src/http-setup-script.js";
import { renderStatusPage } from "../src/http-status-page.js";

const BASE = "https://mcp.example.com";
const CORE_ONLY = /tdei_list_my_project_groups|tdei_list_jobs/;
const WORKSPACE_ONLY = /get_my_workspaces|get_jobs_by_workspace_id/;

test("core install pages never mention workspace tools", () => {
  const pages = [
    renderStatusPage(BASE, "/mcp", "tdei-core-dev", "core"),
    renderSetupOverview(BASE, "/mcp", "tdei-core-dev", "core"),
  ];
  for (const page of pages) assert.doesNotMatch(page, WORKSPACE_ONLY);
  assert.match(pages[0], CORE_ONLY);
});

test("workspace install pages never mention core tools", () => {
  const pages = [
    renderStatusPage(BASE, "/mcp", "tdei-workspace-dev", "workspace"),
    renderSetupOverview(BASE, "/mcp", "tdei-workspace-dev", "workspace"),
  ];
  for (const page of pages) assert.doesNotMatch(page, /tdei_list_my_project_groups|tdei_list_jobs/);
  assert.match(pages[0], /get_my_workspaces/);
  assert.match(pages[1], /get_my_workspaces/);
});

test("installers pass the profile to the shared setup program", () => {
  const sh = renderClientSetupScript("claude-cli", BASE, 8765, "install", "/mcp", "tdei-workspace-dev", "workspace");
  const ps = renderClientSetupPowershell(
    "claude-cli",
    BASE,
    8765,
    "install",
    "/mcp",
    "tdei-workspace-dev",
    "workspace",
  );
  assert.match(sh, /PROFILE="workspace"/);
  assert.match(ps, /\$Profile = 'workspace'|\$Profile = "workspace"/);
  assert.match(renderClientSetupScript("claude-cli", BASE), /PROFILE="core"/);
  assert.match(getClientSetupJs(), /get_my_workspaces/);
});
