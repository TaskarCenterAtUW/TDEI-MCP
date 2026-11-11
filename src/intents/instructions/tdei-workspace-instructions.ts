import { pendingFeaturesNote } from "../../tdei-workspace/pending-features.js";
import { exportToTdeiRunbook } from "../../tdei-workspace/export-to-tdei.js";
import { coreCompanionNote } from "../../tdei-shared/companion-servers.js";
import { TDEI_SHARED_SERVER_INSTRUCTIONS } from "./tdei-shared-instructions.js";

/** Instructions for the TDEI Workspace backend. */
export const TDEI_WORKSPACE_SERVER_INSTRUCTIONS = `${TDEI_SHARED_SERVER_INSTRUCTIONS}

## TDEI workspace server
This server talks to the TDEI Workspace backend for workspace editing, tasking, teams, and review workflows. It is not the core dataset catalog. Authentication still uses the TDEI core SSO session from tdei_sso_login.

- Start with get_my_workspaces (GET /api/v1/workspaces/mine) and cache each workspace_id and name. Almost every workspace tool is scoped by workspace_id; never guess or invent one.
- Tasking tools also need project_id and, for task actions, task_number. List projects and tasks before acting, and reuse cached IDs.
- Typical task flow: list projects → list tasks → lock task → work → extend lock if needed → submit task or submit changeset → review the task/project audit. Reset only when the user explicitly asks.
- Workspace jobs use the workspace endpoints: GET /api/v1/workspaces/{workspace_id}/jobs and GET /api/v1/workspaces/jobs/{job_id}. Poll them after starting an async action and fetch the result when the job completes.
- Workspace file operations (create workspace from file, upload project AOI) follow the same client-side curl rule: ask for the absolute path on the CLIENT machine and run the returned command there.
- Dataset validation, upload, publish, and dataset downloads belong to the matching tdei-core-* server. Send the user there only when they ask for those operations; do not call core-only tools on this workspace server and do not bring them up otherwise.

## Requests that span both servers
${coreCompanionNote()}

## Understanding the request (workspace server)
Words that mean different things here, so resolve them before calling anything:
- "project": on this server it means a TASKING project inside a workspace (list_projects). A TDEI project group is a different thing (an organization); if the user says "project group" or "organization", that is a cross-server request. If unclear, ask: "tasking project in a workspace, or TDEI project group?"
- "my workspaces": get_my_workspaces. "available in ASR / ScoutRoute / on the mobile app": get_my_workspaces with gig_only=true. "make a workspace available for ASR": the ASR steps below, not a read.
- "roles": ask which layer (workspace role, tasking-project role, or TDEI project-group role) unless the user names one. "my role in workspace X": the role field of get_my_workspaces / get_workspace. "who is in workspace X": get_privileged_workspace_members and teams.
- "contributions" / "how many edits": ask whether they mean people or activity, then count with page_size=1 and pagination.total (never page through everything).
- "tasks": states are to_map, to_review, to_remap, completed. "lock/submit/reset a task": lock_task, submit_task, reset_task (reset only when explicitly asked).
- "create a workspace": three methods (blank, From TDEI dataset, From File); always ask for the title and project group, and the source if it is not blank.
- "export workspace to TDEI": recommend the Workspaces web UI handoff (link with ?workspace=<id>, steps, role, project group by name and id, edit/review reminders); use the advanced runbook below only if the user asks you to do it yourself. "edit features", "review changesets", "mark reviewed": web UI only, hand off with the link and steps.
- A named workspace ("workspace Oak Harbor") needs its numeric id: find it in get_my_workspaces first; never guess an id. If several match, show them and ask.
- Destructive or hard to undo (delete workspace/project/AOI, reset, remove a role): confirm the exact target with the user first.

## Features still in testing
${pendingFeaturesNote()}

## Create a workspace
Three methods: blank (no map data), From TDEI (a dataset stored in TDEI) and From File (a local OpenSidewalks file, uploaded with a client-side curl). All need a title and a project group. Reviewing changesets, changing settings and exporting to TDEI need the matching workspace or TDEI project-group role; plain data work needs only membership.

### From a TDEI dataset
Ask the user for the workspace name and the project group (if they do not know the id, list their project groups from the core server as a table). Only when the user wants a copy of a dataset, resolve it on the core server (for "latest dataset for <city/county/state>" use tdei_find_datasets with place, osw, Publish, latest), run the name/creation checks, then create_workspace with tdeiRecordId, tdeiServiceId, type and tdeiProjectGroupId. Creation is async and produces a private copy, not a synced or public dataset.

## AVIV ScoutRoute (ASR)
ASR = AVIV ScoutRoute, the mobile app for collecting pedestrian and accessibility data. A workspace appears in ASR only when externalAppAccess is enabled (off by default, owner/POC only) and a Long Form Quest Definition (LFQD, JSON or URL) is configured. externalAppAccess is an integer: 0 = Disabled, 1 = Public (what the "Publish this workspace for external apps" switch sets), 2 = Project Group Only; read it first and confirm before changing. It is separate from making data public.

## Web UI only tasks
Feature editing, changeset review (per-feature history and restore) and export to TDEI have no single API operation. Never stop at "not supported": give the user the Workspaces link for their environment and the steps from the matching tool description, tell them which role they need, and offer to continue with MCP afterwards. Service creation, project-group members and account registration are TDEI Portal tasks (see the core server).

## Export, roles and contributions
- Export of a workspace to TDEI has no backend API operation, but the export_workspace_to_tdei tool exists: call it whenever the user asks to export or push a workspace to TDEI core (method web_ui by default, api_runbook only when they ask you to do it yourself). RECOMMEND the Workspaces web UI: tell the user the recommended way to export is from the Workspaces web app (do not frame it as a limitation or say you cannot); give the dashboard link with ?workspace=<workspace_id>; the steps (workspace actions menu > Export > on the Export Workspace page choose Upload to TDEI > Start > follow the prompts), naming the target project group by name and id if the user gave one; the role needed (POC or osw_data_generator in a TDEI project group, check the user's role in that group with tdei_get_my_identity if useful); remind them to make any edits first (a workspace that is an unedited copy of its source dataset would upload a near-identical new dataset), to confirm the project group and review status on the export page, and that the labels may differ slightly. Export only uploads the dataset: it does not validate or publish it; offer to find the new dataset, validate or publish it, or check the upload job once they say it is done (cross-server on the core server; follow the companion-server rule if it is missing).
- When the user asks you to do the export ("export it", "do it now") and your client can run commands on their machine, follow the advanced "Export a workspace to TDEI" runbook below (or call export_workspace_to_tdei with method api_runbook) without asking them to choose between methods. Use its defaults for the output folder and the dataset metadata instead of asking, never ask the user for a token, and ask only for the workspace when it is unclear. Do not start the export when the user has only asked whether it is possible.
- Workspace roles (lead, validator, contributor) are separate from TDEI project-group roles (POC, osw_data_generator, ...), which come from tdei_get_my_identity on the core server (mention these only when the user asks about project-group roles). Permission matrices are not defined by the API.
- Contributions are changesets committed immediately and reviewed afterwards. There is no count endpoint: aggregate changeset_submitted audit events and task statuses per tasking project, and say which measure you used.

## Export a workspace to TDEI (advanced; only when the user asks you to do it yourself)
${exportToTdeiRunbook()}
${coreCompanionNote()}
`;
