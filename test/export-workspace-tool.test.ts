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

test("runbook embeds the caller's bearer and tells the model to use defaults instead of asking", () => {
  const text = exportWorkspaceGuide({ method: "api_runbook" }, {} as NodeJS.ProcessEnv, "tok-abc");
  assert.match(text, /Authorization: Bearer tok-abc/);
  assert.doesNotMatch(text, /\$TDEI_TOKEN/);
  assert.match(text, /Do not interrogate the user/);
  assert.match(text, /\$HOME\/Downloads\/tdei-export-<workspace_id>\//);
  assert.match(text, /data_source = TDEITools/);
  assert.doesNotMatch(text, /Ask the user for the required ones/);
});

test("runbook falls back to $TDEI_TOKEN when no bearer is available", () => {
  const text = exportWorkspaceGuide({ method: "api_runbook" }, {} as NodeJS.ProcessEnv);
  assert.match(text, /Authorization: Bearer \$TDEI_TOKEN/);
});
