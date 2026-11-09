import assert from "node:assert/strict";
import test from "node:test";

import { EXPORT_WORKSPACE_TOOL, exportWorkspaceGuide } from "../src/tdei-workspace/export-tool.js";

test("export tool defaults to the web UI handoff with the workspace id in the link", () => {
  const text = exportWorkspaceGuide({ workspace_id: "42" }, { TDEI_ENV: "prod" } as NodeJS.ProcessEnv);
  assert.match(text, /dashboard\?workspace=42/);
  assert.match(text, /Upload to TDEI/);
  assert.match(text, new RegExp(EXPORT_WORKSPACE_TOOL));
});

test("export tool returns the API runbook on request", () => {
  const text = exportWorkspaceGuide({ method: "api_runbook" });
  assert.match(text, /Export a workspace to TDEI, advanced API recipe/);
});
