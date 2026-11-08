import { webUiHandoff } from "../tdei-shared/web-ui-handoffs.js";
import { coreCompanionNote } from "../tdei-shared/companion-servers.js";
import { lookupToolInstruction } from "../tdei-shared/register-openapi-tools.js";

/**
 * Extra LLM-facing guidance appended to discovered Workspace OpenAPI tool
 * descriptions. Keys are the SHORT operation name (the FastAPI operationId up
 * to "_api_v1_"), so they survive the long generated suffixes. Facts come from
 * the Workspaces OpenAPI spec and the TCAT wiki (taskarcenteratuw.github.io/tcat-wiki).
 */

const FILE_UPLOAD_HINT =
  "MCP never accepts file bytes: ask the user for the absolute path of the file on the CLIENT machine, then run the multipart curl from that machine with the SSO bearer from tdei_sso_login.";
const JOB_HINT =
  "Creation/import is asynchronous: poll get_jobs_by_workspace_id / get_job_by_id (and the workspace's importStatus) until it completes before editing or configuring the workspace.";
const DESTRUCTIVE = "Destructive: do this only when the user explicitly asks, and confirm the target first.";

/** externalAppAccess is the "Publish this workspace for external apps" setting. */
export const EXTERNAL_APP_ACCESS_HELP =
  "externalAppAccess is the workspace setting that makes the workspace appear in AVIV ScoutRoute (ASR), the mobile app used to collect pedestrian and accessibility data. " +
  "It is OFF by default for new workspaces and must be enabled explicitly after creation; only workspace owners and TDEI project-group POCs can change it. " +
  "It is separate from making data public: workspace data stays private to its project group until exported and published through the TDEI workflow. " +
  "The API stores it as an integer (0, 1 or 2) and the mapping of those values is not documented: never guess one. Read the current value with the get workspace tool, " +
  "and to enable it use the value an already-published workspace shows, or ask the user. Confirm with the user before changing it.";

const ASR_ENABLE_STEPS =
  "To make a workspace available for ASR: (1) ask the user for the Long Form Quest Definition (LFQD) as JSON or a direct URL; (2) save it with the update long quest settings tool; " +
  "(3) enable external app access with the update workspace tool; (4) tell the user to refresh or switch workspace in ASR and that only members of the workspace's project group see it. " +
  "A saved quest definition without app access enabled is not a mobile deployment.";

const CONTRIBUTIONS_HELP =
  "There is no contribution-count endpoint. Two different things are called contributions. " +
  "(1) People: the Workspaces project 'Contributions' tab only shows summary cards (Total Contributors, Leads, Validators, Contributors) and the 'Contributors' tab lists people with their project role; rebuild that with the list project roles tool (role per user) and count by role. " +
  "(2) Activity: in Workspaces a contribution is a changeset: ASR quest answers and editor (Rapid/JOSM) edits are committed immediately and reviewed afterwards (review does not delay the commit). " +
  "Estimate activity by counting audit events of type changeset_submitted per tasking project (list project audit, paginate fully, filter by event type and actor) and task statuses from list tasks. " +
  "Per-changeset detail (author, time, sources, comments, before/after values) and edit history are only in the Workspaces web UI (Changeset Review, feature history); through this API only the augmented diff of a known changeset id is available. " +
  "State which measure you used, that edits made outside the tasking flow are not in the audit log, and that a changeset is not proof the observation is correct.";

const CREATION_METHODS =
  "Three creation methods: (a) Blank: create_workspace with no tdeiRecordId, starts with no map data; (b) From TDEI: create_workspace with tdeiRecordId (and tdeiServiceId) for a dataset already stored in TDEI; " +
  "(c) From File: create_workspace_from_file uploads a local OpenSidewalks (OSW) data file. Ask which source the user wants when it is unclear. " +
  "Every method needs a workspace title and a project group; the source dataset or file is needed for (b) and (c). " +
  "Any member with access can work with workspace data, but reviewing changesets, changing settings and uploading an export to TDEI need the matching workspace or TDEI project-group role.";

/** Export to TDEI is a web UI flow; there is no API operation for it. */
export const EXPORT_TO_TDEI_HELP = webUiHandoff("export_workspace");
const EDIT_FEATURES_HELP = webUiHandoff("edit_workspace_features");
const REVIEW_CHANGESETS_HELP = webUiHandoff("review_changesets");

const ROLES_HELP =
  "Role layers are separate. Workspace roles (lead, validator, contributor) and tasking-project roles use the same labels but the API does not define their permissions; do not infer a permission matrix. " +
  "TDEI project-group roles (for example POC, osw_data_generator) are a different layer, read from the SSO token via tdei_get_my_identity on the core server, not from this API. " +
  "Project-group membership does not by itself grant workspace editing, review, export or publication rights.";

export const TDEI_WORKSPACE_TOOL_INSTRUCTIONS: Readonly<Record<string, string>> = {
  get_my_workspaces:
    `Call this first and cache every workspace id and title; almost every other workspace tool is scoped by workspace_id. Never guess one. ` +
    `Each item has the caller's workspace role, tdeiProjectGroupId (an id only: project group NAMES need tdei_list_my_project_groups on the core server), projectsCount and membersCount. ` +
    `To answer "my workspaces and roles, grouped by project group", join those two sources and render a markdown table. ${ROLES_HELP} ${coreCompanionNote()}`,

  create_workspace:
    `Create a workspace: an editable private COPY of a TDEI dataset, or a blank one. ${CREATION_METHODS} Required: type (osw, pathways or flex; use the dataset's data type), title and tdeiProjectGroupId. ` +
    `For a copy of a dataset also pass tdeiRecordId (the TDEI dataset id) and tdeiServiceId (the dataset's service_id). ` +
    `ALWAYS ask the user for the workspace name and the project group first, listing their project groups from tdei_list_my_project_groups as a table; never choose either for them. ` +
    `For "latest dataset for <place>" resolve the dataset on the core server with tdei_find_datasets (place, dataType osw, status Publish, latest:true), show the match table and let the user confirm one row. ` +
    `Before creating, call the name/creation check tools (check_workspace_name; check_workspace_create where present) and stop with the reason when the name is taken or canCreate is false. ` +
    `The workspace is a snapshot: later dataset versions are not synced, the source dataset is not modified, and the workspace is not public. ${JOB_HINT} ` +
    `Report the new workspace id plus the source dataset id and version for lineage. Then offer the next step, editing: ${EDIT_FEATURES_HELP} ${coreCompanionNote()}`,

  create_workspace_from_file: `${CREATION_METHODS} ${FILE_UPLOAD_HINT} The file must be a supported OpenSidewalks (OSW) file. Requires type, title and tdeiProjectGroupId: ask the user for the title and project group (list them from the core server). ${JOB_HINT} ${coreCompanionNote()}`,

  check_workspace_name:
    "Checks whether a workspace title is available in a project group (requires title and tdeiProjectGroupId). Call before create_workspace and tell the user if the name is taken.",
  check_workspace_create:
    "Checks whether a workspace can be created for a type, project group and optional tdeiRecordId (dataset id). If canCreate is false, report the reason and stop; most often the user lacks access to the project group or dataset.",

  get_workspace: `Get one workspace (includes tdeiRecordId/tdeiServiceId lineage, role and importStatus). Note externalAppAccess: ${EXTERNAL_APP_ACCESS_HELP} ${EXPORT_TO_TDEI_HELP}`,
  update_workspace:
    `Update title, description, externalAppAccess, autoFlagReview (auto-flag contributor changesets for review) and overrideConflicts (edit-conflict handling: override = last edit wins, otherwise resolve per field). ` +
    `Only workspace owners and project-group POCs can change settings. ${EXTERNAL_APP_ACCESS_HELP} ${ASR_ENABLE_STEPS}`,
  delete_workspace: `${DESTRUCTIVE} Irreversible: confirm the workspace title with the user first.`,

  get_long_quest_def: "Returns the active AVIV ScoutRoute Long Form Quest Definition (LFQD) JSON for the workspace.",
  get_long_quest_settings:
    "Returns how the LFQD is sourced: type NONE, JSON (stored in Workspaces) or URL (fetched from an external address at runtime).",
  update_long_quest_settings:
    `Set the AVIV ScoutRoute (ASR) Long Form Quest Definition. type is NONE, JSON (pass the definition as valid JSON) or URL (pass a direct URL to a JSON definition; it is fetched at runtime, not stored). ` +
    `Ask the user for the LFQD if they have not given it, and validate that it is valid JSON before saving. ${ASR_ENABLE_STEPS}`,
  get_imagery_settings:
    "Returns the workspace's custom imagery definition (raw JSON, same schema as the ASR imagery list).",
  update_imagery_settings:
    "Set custom imagery with a raw JSON definition that follows the ASR imagery-list schema; ask the user for the JSON and validate it first. Check the imagery source's access and attribution terms.",

  get_jobs_by_workspace_id:
    "Workspace jobs (import, creation, export-style processing). Poll after any async action and read the result when the job completes.",
  get_job_by_id: "One workspace job by id. Do not treat a job as finished until its status says so.",

  get_privileged_workspace_members: `Lists privileged workspace members and their roles. ${ROLES_HELP}`,
  assign_member_role: `Assign a workspace role (lead, validator, contributor). ${ROLES_HELP} Confirm the user and role first.`,
  remove_member_role: `${DESTRUCTIVE}`,

  list_project_audit: `Audit events for one tasking project (paginated). ${CONTRIBUTIONS_HELP}`,
  list_task_audit: `Audit events for one task. ${CONTRIBUTIONS_HELP}`,
  list_tasks: `Tasks of a tasking project with status (paginated). Use for task-status counts. ${CONTRIBUTIONS_HELP}`,
  list_project_roles: `Roles per user in one tasking project (lead, validator, contributor). This is the data behind the web UI Contributors tab. ${CONTRIBUTIONS_HELP}`,
  list_projects: "Tasking projects in a workspace; list these before tasks and cache project ids.",
  submit_changeset:
    "Record an OSM changeset against a task (osm_changeset_id). Changesets are how contributions land in a workspace; they are committed immediately and reviewed afterwards.",
  get_changeset_adiff: `Augmented diff of one changeset id: use it to show what a contribution changed. ${REVIEW_CHANGESETS_HELP} To explain what changed between a workspace and its source dataset, compare the source lineage from get_workspace (tdeiRecordId, version) with the changesets involved; there is no whole-workspace diff endpoint, and the per-feature edits view (review or restore) is only in the Workspaces web UI.`,
  resolve_changeset: `Resolve a conflicted changeset; confirm the chosen values with the user first. ${REVIEW_CHANGESETS_HELP}`,

  upload_project_aoi: FILE_UPLOAD_HINT,
  reset_task: DESTRUCTIVE,
  reset_project: DESTRUCTIVE,
};

/** "create_workspace_api_v1_workspaces_post" -> "create_workspace". */
export function shortWorkspaceOperationName(operationName: string): string {
  const cut = operationName.indexOf("_api_v1_");
  return cut > 0 ? operationName.slice(0, cut) : operationName;
}

export function augmentWorkspaceToolDescription(operationName: string, description: string | undefined) {
  const short = shortWorkspaceOperationName(operationName);
  return lookupToolInstruction(TDEI_WORKSPACE_TOOL_INSTRUCTIONS, short, description);
}
