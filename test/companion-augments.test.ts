import assert from "node:assert/strict";
import test from "node:test";

import { SEMANTIC_TOOL_DESCRIPTIONS } from "../src/intents/descriptions.js";
import { TDEI_CORE_SERVER_INSTRUCTIONS } from "../src/intents/server-instructions.js";
import { TDEI_WORKSPACE_SERVER_INSTRUCTIONS } from "../src/intents/server-instructions.js";
import { coreCompanionNote, workspaceCompanionNote } from "../src/tdei-shared/companion-servers.js";
import {
  augmentWorkspaceToolDescription,
  EXPORT_TO_TDEI_HELP,
  EXTERNAL_APP_ACCESS_HELP,
  shortWorkspaceOperationName,
} from "../src/tdei-workspace/tool-instructions.js";

test("companion notes send the user to the status page and ask for both servers", () => {
  const env = { TDEI_STATUS_PAGE_URL: "https://mcp.example.com/" } as NodeJS.ProcessEnv;
  for (const note of [coreCompanionNote(env), workspaceCompanionNote(env)]) {
    assert.match(note, /status page \(https:\/\/mcp\.example\.com\/\)/);
    assert.match(note, /install BOTH servers/);
  }
  assert.match(coreCompanionNote({} as NodeJS.ProcessEnv), /root URL of the TDEI MCP host/);
  for (const note of [coreCompanionNote(env), workspaceCompanionNote(env)]) {
    assert.match(note, /ONLY if the user's request actually needs both servers/);
    assert.match(note, /do not mention the other server or the status page/);
  }
});

test("workspace tools that need core data carry the companion note", () => {
  const ops = [
    "get_my_workspaces_api_v1_workspaces_mine_get",
    "create_workspace_api_v1_workspaces_post",
    "create_workspace_from_file_api_v1_workspaces_from_file_post",
  ];
  for (const op of ops)
    assert.match(
      augmentWorkspaceToolDescription(op, "base") ?? "",
      /Companion server required only for cross-server requests/,
    );
});

test("create_workspace asks for name and project group and handles latest-by-place", () => {
  const text = augmentWorkspaceToolDescription("create_workspace_api_v1_workspaces_post", "base") ?? "";
  assert.match(text, /ask the user for the workspace name and the project group/i);
  assert.match(text, /latest:true/);
  assert.match(text, /tdeiRecordId/);
  assert.match(text, /check_workspace_name/);
  assert.match(text, /Three creation methods/);
  assert.match(text, /Blank/);
});

test("ASR and externalAppAccess use the integer mapping from the Workspaces app", () => {
  const text = augmentWorkspaceToolDescription("update_workspace_api_v1_workspaces__workspace_id__patch", "base") ?? "";
  assert.match(text, /AVIV ScoutRoute/);
  assert.match(text, /OFF by default/);
  assert.match(text, /0 = Disabled, 1 = Public, 2 = Project Group Only/);
  assert.match(
    augmentWorkspaceToolDescription("resolve_changeset_api_v1_x_put", "") ?? "",
    /Mark a changeset as reviewed/,
  );
  assert.match(EXTERNAL_APP_ACCESS_HELP, /separate from making data public/);
  assert.match(
    augmentWorkspaceToolDescription(
      "update_long_quest_settings_api_v1_workspaces__workspace_id__quests_long_settings_patch",
      "",
    ) ?? "",
    /LFQD/,
  );
});

test("contribution tools explain changesets and that there is no count endpoint", () => {
  for (const op of ["list_project_audit", "list_task_audit", "list_tasks"]) {
    const text =
      augmentWorkspaceToolDescription(
        `${op}_api_v1_workspaces__workspace_id__tasking_projects__project_id__x_get`,
        "base",
      ) ?? "";
    assert.match(text, /no workspace-wide contribution-count endpoint/);
    assert.match(text, /changeset_submitted/);
    assert.match(text, /PEOPLE \(the web UI Contributors\/Contributions tabs\)/);
  }
  const roles = augmentWorkspaceToolDescription("list_project_roles_api_v1_x_get", "base") ?? "";
  assert.match(roles, /PEOPLE/);
});

test("operation names are shortened before the REST suffix", () => {
  assert.equal(shortWorkspaceOperationName("get_my_workspaces_api_v1_workspaces_mine_get"), "get_my_workspaces");
  assert.equal(shortWorkspaceOperationName("plain_name"), "plain_name");
});

test("core dataset tools carry the workspace companion note and creation flow", () => {
  for (const key of [
    "findDatasets",
    "listMyProjectGroups",
    "listServices",
    "getDatasetDetails",
    "getMyIdentity",
  ] as const) {
    assert.match(SEMANTIC_TOOL_DESCRIPTIONS[key], /Companion server for workspace tasks/);
  }
  assert.match(
    SEMANTIC_TOOL_DESCRIPTIONS.findDatasets,
    /Only when the user wants to create a workspace: workspace creation flow/,
  );
  for (const key of ["getDatasetDetails", "findDatasets"] as const) {
    assert.match(SEMANTIC_TOOL_DESCRIPTIONS[key], /no dataset-diff operation/);
    assert.match(SEMANTIC_TOOL_DESCRIPTIONS[key], /derived_from_dataset_id/);
  }
  assert.match(
    augmentWorkspaceToolDescription("get_changeset_adiff_api_v1_x_get", "") ?? "",
    /no whole-workspace diff/,
  );
  assert.match(SEMANTIC_TOOL_DESCRIPTIONS.uploadDataset, /^((?!Companion server for workspace tasks).)*$/s);
});

test("server instructions document the cross-server flow, ASR, export and contributions", () => {
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /Requests that span both servers \(workspace tasks\)/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /ASR = AVIV ScoutRoute/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /osw_data_generator/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /Upload to TDEI > Start/);
  assert.match(EXPORT_TO_TDEI_HELP, /Web UI only, no MCP operation/);
  assert.match(
    augmentWorkspaceToolDescription("get_workspace_api_v1_workspaces__workspace_id__get", "") ?? "",
    /Upload to TDEI/,
  );
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /no count endpoint/);
});

import { portalUrl, resolveTdeiEnvironment, webUiHandoff, workspacesUrl } from "../src/tdei-shared/web-ui-handoffs.js";

test("web UI handoffs pick the right host per environment", () => {
  assert.equal(resolveTdeiEnvironment({ TDEI_MCP_NAME: "tdei-core-dev" } as NodeJS.ProcessEnv), "dev");
  assert.equal(resolveTdeiEnvironment({ TDEI_MCP_NAME: "tdei-workspace-stage" } as NodeJS.ProcessEnv), "stage");
  assert.equal(resolveTdeiEnvironment({ TDEI_API_URL: "https://api-stage.tdei.us" } as NodeJS.ProcessEnv), "stage");
  assert.equal(resolveTdeiEnvironment({ TDEI_MCP_NAME: "tdei-core-production" } as NodeJS.ProcessEnv), "prod");
  assert.equal(portalUrl("dev"), "https://portal-dev.tdei.us/");
  assert.equal(workspacesUrl("stage"), "https://workspaces-stage.sidewalks.washington.edu/dashboard");
});

test("web UI handoffs give a link, numbered steps, the role and a follow-up", () => {
  const dev = { TDEI_MCP_NAME: "tdei-workspace-dev" } as NodeJS.ProcessEnv;
  const text = webUiHandoff("export_workspace", dev);
  assert.match(text, /https:\/\/workspaces-dev\.sidewalks\.washington\.edu\/dashboard/);
  assert.match(text, /1\) .*2\) .*3\) /);
  assert.match(text, /osw_data_generator/);
  assert.match(text, /tdei_validate_dataset/);
  const service = webUiHandoff("create_service", dev);
  assert.match(service, /Create Service/);
  assert.match(service, /poc/);
  assert.match(webUiHandoff("manage_project_group_members", dev), /Assign New User/);
  assert.match(webUiHandoff("register_account", dev), /portal-dev\.tdei\.us\/register/);
});

test("UI-only tasks surface on the tools where users hit them", () => {
  assert.match(SEMANTIC_TOOL_DESCRIPTIONS.listServices, /Create Service/);
  assert.match(SEMANTIC_TOOL_DESCRIPTIONS.listMyProjectGroups, /Assign New User/);
  assert.match(SEMANTIC_TOOL_DESCRIPTIONS.verifyEmail, /Register Now/);
  assert.match(augmentWorkspaceToolDescription("get_workspace_api_v1_x_get", "") ?? "", /Export Workspace page/);
  assert.match(augmentWorkspaceToolDescription("resolve_changeset_api_v1_x_put", "") ?? "", /Mark as Reviewed/);
  assert.match(
    augmentWorkspaceToolDescription("create_workspace_api_v1_workspaces_post", "") ?? "",
    /Rapid in the browser/,
  );
});

test("each shipped server only points at the portal and Workspaces of its own environment", () => {
  const servers = [
    { name: "tdei-core-dev", apiUrl: "https://api-dev.tdei.us", env: "dev" },
    { name: "tdei-core-staging", apiUrl: "https://api-stage.tdei.us", env: "stage" },
    { name: "tdei-core-production", apiUrl: "https://api.tdei.us", env: "prod" },
    { name: "tdei-workspace-dev", apiUrl: "https://ws-backend-dev.azurewebsites.net/", env: "dev" },
    { name: "tdei-workspace-stage", apiUrl: "https://ws-backend-stage.azurewebsites.net/", env: "stage" },
    { name: "tdei-workspace-prod", apiUrl: "https://api.workspaces.sidewalks.washington.edu/", env: "prod" },
  ] as const;
  const portals = {
    dev: "https://portal-dev.tdei.us",
    stage: "https://portal-stage.tdei.us",
    prod: "https://portal.tdei.us",
  };
  const workspaces = {
    dev: "https://workspaces-dev.sidewalks.washington.edu",
    stage: "https://workspaces-stage.sidewalks.washington.edu",
    prod: "https://workspaces.sidewalks.washington.edu",
  };
  for (const server of servers) {
    const env = { TDEI_MCP_NAME: server.name, TDEI_API_URL: server.apiUrl } as NodeJS.ProcessEnv;
    assert.equal(resolveTdeiEnvironment(env), server.env, server.name);
    const text = [
      webUiHandoff("create_service", env),
      webUiHandoff("export_workspace", env),
      webUiHandoff("register_account", env),
    ].join(" ");
    assert.ok(text.includes(portals[server.env]), `${server.name} portal`);
    assert.ok(text.includes(workspaces[server.env]), `${server.name} workspaces`);
    for (const other of ["dev", "stage", "prod"] as const) {
      if (other === server.env) continue;
      // Compare on "host/" so portal.tdei.us is not matched inside portal-dev.tdei.us.
      assert.ok(!text.includes(`${portals[other]}/`), `${server.name} must not mention ${portals[other]}`);
      assert.ok(!text.includes(`${workspaces[other]}/`), `${server.name} must not mention ${workspaces[other]}`);
    }
  }
});

test("the server name wins over the API host and TDEI_ENVIRONMENT wins over both", () => {
  assert.equal(
    resolveTdeiEnvironment({
      TDEI_MCP_NAME: "tdei-workspace-stage",
      TDEI_API_URL: "https://ws-backend-dev.azurewebsites.net/",
    } as NodeJS.ProcessEnv),
    "stage",
  );
  assert.equal(
    resolveTdeiEnvironment({ TDEI_ENVIRONMENT: "prod", TDEI_MCP_NAME: "tdei-core-dev" } as NodeJS.ProcessEnv),
    "prod",
  );
});

import { pendingFeaturesNote, pendingToolBanner } from "../src/tdei-workspace/pending-features.js";

test("production tells the user the dev/stage-only features are in testing and coming once deployed", () => {
  const prod = pendingFeaturesNote("prod");
  assert.match(prod, /Not yet available in production/);
  assert.match(prod, /check_workspace_create/);
  assert.match(prod, /get_fixmes/);
  assert.match(prod, /under testing on the dev and stage/);
  assert.match(prod, /available once they are deployed to production/);
  assert.match(prod, /do not call them a connection problem/);
});

test("dev and stage mark the same features as under testing", () => {
  for (const env of ["dev", "stage"] as const) {
    assert.match(
      pendingFeaturesNote(env),
      new RegExp(`available on this ${env} server but are not deployed to production yet`),
    );
    assert.match(pendingToolBanner(env), /Under testing/);
  }
  assert.match(pendingToolBanner("prod"), /not yet deployed to production/);
});

test("the pending-feature note reaches the workspace instructions and create_workspace", () => {
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /Features still in testing/);
  assert.match(
    augmentWorkspaceToolDescription("create_workspace_api_v1_workspaces_post", "") ?? "",
    /check_workspace_create/,
  );
});

test("companion notes are conditional and never push the other server on single-server requests", () => {
  const env = {} as NodeJS.ProcessEnv;
  for (const note of [coreCompanionNote(env), workspaceCompanionNote(env)]) {
    // The trigger comes before the instruction to check or install anything.
    assert.ok(note.indexOf("only") < note.indexOf("status page"), "condition precedes the status page redirect");
    assert.match(note, /if it stays on this server, ignore this note/);
  }
  const listing = augmentWorkspaceToolDescription("get_my_workspaces_api_v1_workspaces_mine_get", "") ?? "";
  assert.match(listing, /project group NAMES/);
  assert.match(listing, /ONLY if the user's request actually needs both servers/);
});

test("instructions disambiguate 'project', 'roles' and 'contributions' per server and match the API", () => {
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /"project": on this server it means a TASKING project/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /gig_only=true/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /to_map, to_review, to_remap, completed/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /pagination\.total/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /a TDEI PROJECT GROUP/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /A dataset NAME is not an id/);
  const audit = augmentWorkspaceToolDescription("list_project_audit_api_v1_x_get", "") ?? "";
  assert.match(audit, /event_type=changeset_submitted/);
  assert.match(audit, /page_size=1/);
  assert.match(audit, /occurred_from/);
  assert.match(audit, /last_mapper_id/);
  assert.doesNotMatch(audit, /paginate fully/);
  const mine = augmentWorkspaceToolDescription("get_my_workspaces_api_v1_workspaces_mine_get", "") ?? "";
  assert.match(mine, /gig_only=true/);
  assert.match(
    augmentWorkspaceToolDescription("check_workspace_name_api_v1_workspaces_check_post", "") ?? "",
    /Returns \{available\}/,
  );
  assert.match(augmentWorkspaceToolDescription("list_projects_api_v1_x_get", "") ?? "", /draft, open, done/);
});
