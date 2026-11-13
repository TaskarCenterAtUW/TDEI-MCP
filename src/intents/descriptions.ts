import { TDEI_USER_MY_ROLES_HELP } from "../tdei-user/tool-instructions.js";
import { webUiHandoff, type WebUiTask } from "../tdei-shared/web-ui-handoffs.js";
import { workspaceCompanionNote } from "../tdei-shared/companion-servers.js";

export const TDEI_LLM_CACHE_INSTRUCTIONS =
  "Cache and reuse stable TDEI reference data (project group IDs and names, service IDs and types, dataset IDs and metadata) within the conversation context instead of re-fetching on every turn. Only re-query when the user asks to refresh, changes filter criteria, or after a mutation (such as dataset upload or creation).";

export const TDEI_PRESENTATION_INSTRUCTIONS =
  "Always beautify list results for the user: render datasets, services, project groups, jobs, feedbacks, versions, and metrics as a markdown table (one row per item with key columns such as name, type, project group, dates, and IDs) plus a one-line count summary. Never present raw JSON arrays as the primary answer; keep full IDs available for follow-up actions.";

const BASE_SEMANTIC_TOOL_DESCRIPTIONS = {
  findDatasets:
    "Find TDEI datasets from a natural-language place or bounding box. Use for requests such as 'get me the latest dataset for Seattle'. Searches dataset name first, then city, then forward-geocodes the place for a bbox search. Supports exact lookup via tdeiDatasetId (release-status follow-ups) and recent-upload filtering via uploadedAfter / uploadedWithinDays (client-side on uploaded_timestamp; the API has no uploaded_after). Returns ambiguity instead of guessing a place. Every complete result includes a markdown match table (#, name, tdei_dataset_id UUID, data_type, status) — always show that table to the user with a count summary instead of raw JSON, and reuse its UUIDs for follow-up actions (download, details, incline checks) without re-searching. Cache returned dataset IDs, names, project_group_id, service_id, and metadata in conversation memory to avoid redundant searches across follow-up turns.",
  listMyProjectGroups:
    "List all TDEI project groups visible to the authenticated login via listProjectGroups (GET /api/v1/project-groups). This is NOT membership; for the caller's own project groups and roles use tdei_my_project_group_roles. Use for 'project', 'projects', 'project group', 'project groups'. For who-am-I use tdei_get_my_identity. Never page all results plus filter poc emails to infer membership. Always state scopeExplanation in the answer. Cache and reuse returned project_group_id and name values across the conversation rather than calling repeatedly. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  listServices:
    "List TDEI services, optionally filtered by name, project group, or data type (OSW, GTFS Flex, or GTFS Pathways). Use for requests such as 'get me the list of services'. Cache returned service IDs, names, project_group_id, and service types in conversation context and reuse them for subsequent dataset queries or uploads instead of re-fetching. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  validateDataset:
    'Validate an OSW, GTFS Flex, or GTFS Pathways dataset ZIP. Ask for the local ZIP file when it is missing — MCP never accepts file bytes: no inline_base64, no url fetch; asset must be a local_path with the absolute file path on the CLIENT machine (only embedded in the curl command, never read by the server). For OSW, the ZIP must contain nodes/edges/points GeoJSON. If the data type or asset is missing, returns structured questions. Otherwise returns a hands-free client-side curl command (any size, single hop, directly to the TDEI backend; gateway is not a relay): curl -X POST "<apiUrl>/api/v1/{osw|gtfs-flex|gtfs-pathways}/validate" -H "Authorization: Bearer $TDEI_TOKEN" -F "dataset=@/path/to/file.zip" -sS --fail-with-body, with the caller bearer already embedded. Execute it now with your shell tool on the CLIENT machine (no human step, do not ask the user to run it), then poll with tdei_list_jobs using the returned job_id. Once the job is COMPLETED, download its result with job_download.',
  uploadDataset:
    "Upload a dataset to TDEI. MCP never accepts file bytes — no inline_base64, no url fetch; asset must be a local_path with the absolute file path on the CLIENT machine (only embedded in the curl command, never read by the server). Checks the target project group, service, and required metadata first, then returns a hands-free client-side curl command (any size, single hop, directly to the TDEI backend; gateway is not a relay) with the caller bearer already embedded and the metadata JSON quoted so quotes and semicolons survive, all on one line. Execute it now with your shell tool on the CLIENT machine (no human step, do not ask the user to run it, do not save it to a script file). Then poll with tdei_list_jobs. Reuse cached projectGroupId and serviceId from earlier calls.",
  myProjectGroupRoles: TDEI_USER_MY_ROLES_HELP,
  getMyIdentity:
    "Return the caller's identity and roles decoded from the SSO JWT (username, email, roles, groups). Use for 'who am I' / 'my email' / 'what are my roles'. This is the ONLY source of the login email — never infer it from project-group poc contacts. TDEI has no roles endpoint; roles come from JWT realm_access/resource_access claims. Requires a signed-in session.",
  listJobs:
    'List TDEI jobs (GET /api/v1/jobs), one project group at a time. The API needs a project group, so ASK THE USER WHICH PROJECT GROUP FIRST (by name) unless they already named one; pass it as projectGroupName (resolved against your groups) or projectGroupId. Only when the user explicitly says "all" (all groups, every project) pass allGroups:true to search every group (slower). Typical uses, most common first: (1) running jobs: status "IN-PROGRESS"; (2) the status of one job: jobId; (3) recent or failed jobs: status, jobType, createdWithinDays; (4) a job\'s result, which is the least common: only after the status is COMPLETED call job_download (GET /api/v1/job/download/<job_id>), never for FAILED or IN-PROGRESS jobs. If the reply is status needs_input, ask the user the question it contains and call again with their answer. Each project group costs ONE API call (max 50 jobs, no total count, no documented ordering; results are sorted newest first here). Read data.truncation: when mayHaveMore is true say the list may be incomplete and ask the user to narrow the filters (status, job type, job id, submitted-by-me vs group, recent days, one project group) instead of calling again to page. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON. Filters mirror the TDEI Portal Jobs page: jobId (Search Job Id); jobType (Job Type: Clone-Dataset, Confidence-Calculate, Dataset-BBox [portal: Filter Dataset by BBox], Dataset-Incline-Tag, Dataset-Publish, Dataset-Reformat, Dataset-Road-Tag, Dataset-Spatial-Join, Dataset-Union, Dataset-Upload, Dataset-Validate, Edit-Metadata, Quality-Metric, Quality-Report; portal labels and common wordings are accepted); status (COMPLETED, FAILED, IN-PROGRESS, ABANDONED); includeGroupJobs (portal Show: true = All jobs in the group, false or omitted = Submitted by me only). Date filters and limit are extras this tool adds.',
  getDatasetDetails:
    "Get dataset details by exact tdei_dataset_id (status/release + metadata). Includes an incline note: incline presence is not in metadata — download the ZIP via tdei_download_dataset and inspect edges for an incline tag; tag via tdei_tag_incline. Always beautify dataset details for the user as a markdown table instead of raw JSON.",
  downloadDataset:
    "Download a TDEI dataset ZIP to the user's machine. The MCP server never writes files, never touches file bytes, and never relays data — it resolves the dataset id + data type and returns a hands-free curl command with the caller bearer already embedded that runs directly against the TDEI backend. A UUID in tdeiDatasetId downloads immediately (pasting a full match-table row works too — the UUID is extracted from it). A dataset NAME does not download at once: the tool first returns the match table and asks for consent — for one match, repeat the call with confirm:true (or paste its UUID); for several matches, reply with the UUID or re-run with tdeiDatasetId set to the name plus selection:<1-based row number>. outputDir is an optional absolute folder on the CLIENT machine and defaults to the client-side expression $HOME/Downloads (your Downloads folder on macOS/Linux, and in PowerShell on Windows; substitute the absolute path on Windows cmd.exe). Execute the returned curlCommand now with your shell tool on the CLIENT machine (no export needed); no human step, do not ask the user to run it.",
  publishDataset:
    "Publish a dataset as an official release. Provide dataType and tdeiDatasetId; launches the publish job. Track with tdei_list_jobs.",
  deleteDataset: "Delete a dataset permanently (cannot be undone). Requires tdeiDatasetId and confirm:true.",
  cloneDataset:
    "Clone a dataset as the base for a new dataset in a target project group/service. Requires confirm:true.",
  editMetadata:
    "Overwrite a dataset's metadata document. Requires tdeiDatasetId, replacement metadata, and confirm:true.",
  calculateConfidence:
    "Calculate confidence for an OSW dataset, optionally scoped to a sub-region GeoJSON. Returns a job_id; track with tdei_list_jobs.",
  calculateQualityIntersection:
    "Calculate intersection quality for an OSW dataset, optionally with an intersection polygon. Returns a job_id.",
  tagQualityMetric: "Tag quality metrics on OSW dataset elements using a tag-quality JSON file. Returns a job_id.",
  generateQualityReport:
    'Generate a quality report for one OSW dataset via POST /api/v1/osw/quality-report/{tdei_dataset_id}. tdeiDatasetId is required: when it is missing, ask "Which TDEI dataset id should get a quality report?" instead of guessing a dataset name. Returns a job_id; poll it with tdei_list_jobs (jobId) until status is COMPLETED, then fetch the report with job_download: GET /api/v1/job/download/<job_id>.',
  sanitizeDataset: "Sanitize an OSW dataset ZIP (correct invalid/unsupported values). Returns a job_id.",
  convertOsw: "Convert between OSW and OSM formats. Provide the file plus source/target formats. Returns a job_id.",
  convertPathways:
    "Convert CAD drawings (DXF ZIP) or an ArcGIS service into a first-draft GTFS Pathways dataset. Returns a job_id.",
  selfMerge: "Self-merge spatial entities within one OSW dataset. Returns a job_id.",
  spatialJoin: "Spatial join between two OSW datasets (target/source + dimensions + join condition). Returns a job_id.",
  unionDatasets: "Union two OSW datasets (DS2 merged into DS1). Requires confirm:true. Returns a job_id.",
  cutDatasetBbox: "Cut a subgraph of an OSW dataset to a bounding box (osw/osm output). Returns a job_id.",
  tagRoad: "Tag sidewalks in a target dataset with the road network from a source dataset. Returns a job_id.",
  tagIncline:
    "Tag inclines on an OSW dataset. Returns a job_id. Use tdei_check_dataset_incline first for the client-side inspection runbook.",
  checkDatasetIncline:
    "Check whether an OSW dataset includes inclines. The MCP server never touches bytes — it returns a client-side runbook: the LLM downloads the ZIP via curl on the client machine and inspects edges files for an incline tag.",
  listFeedbacks:
    "List dataset-viewer feedbacks, optionally filtered by project group, dataset, date range, or status. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  getFeedbackSummary:
    "Feedback summary (counts, overdue) for viewer feedbacks, optionally scoped to a project group. Always beautify the summary for the user as a markdown table instead of raw JSON.",
  downloadFeedbacks:
    "Download viewer feedbacks for a project group as CSV/GeoJSON (returns a preview; use the raw download tool for the full file). Always beautify the preview for the user as a markdown table instead of raw text.",
  submitFeedback: "Submit viewer feedback for a dataset element. Requires projectId, tdeiDatasetId, feedbackText.",
  updateFeedbackStatus: "Resolve or triage viewer feedbacks (open/resolved + resolution).",
  getPmTilesUrl: "Get the PMTiles SAS URL for viewing a dataset.",
  setViewerAccess: "Set dataset-viewer visibility preferences for a dataset.",
  getMetrics:
    "Dataset/service/system metrics. Service scope requires projectGroupId. Always beautify metrics for the user as a markdown table instead of raw JSON.",
  listVersions:
    "Supported data-standard versions for OSW/Flex/Pathways (one or all). Always beautify the list for the user as a markdown table instead of raw JSON.",
  getSystemInfo:
    "System capabilities (upload limits) plus supported API versions. Always beautify the result for the user as a markdown table instead of raw JSON.",
  verifyEmail: "Send an email-verification link to an address (post-registration).",
  recoverPassword: "Send a password-recovery link to an email address.",
  regenerateApiKey:
    "Regenerate the TDEI API key (invalidates the old key; the new key appears in the chat, so warn the user first). Requires confirm:true.",
} as const;

/**
 * Guidance for "create a workspace from a dataset" flows that start on the core server. The workspace
 * server owns the create call; core owns project groups, services and datasets.
 */
const WORKSPACE_CREATE_FLOW =
  "Only when the user wants to create a workspace: workspace creation flow (creates a private editable COPY of a dataset on the tdei-workspace-* server): " +
  "(1) resolve the dataset: for a jurisdiction such as a city, county or state ('latest dataset for Oak Harbor') use tdei_find_datasets with place, dataType osw, status Publish and latest:true, then show the match table and let the user confirm one row; for a known id use tdei_get_dataset_details; " +
  "(2) ALWAYS ask the user for the workspace name (title) and the project group it should live in, showing their project groups from tdei_list_my_project_groups as a table; never pick either yourself; " +
  "(3) pass the dataset's tdei_dataset_id as tdeiRecordId, its data type as type, its service_id as tdeiServiceId, and the chosen project group id as tdeiProjectGroupId to the workspace create call. " +
  "The user needs access to that project group and dataset; stop and report if either is missing.";

/**
 * "What changed in this dataset?" There is no dataset-diff endpoint: answer from lineage and exact
 * versions (TCAT wiki: dataset lineage, release versioning) and be explicit about what is not known.
 */
const DATASET_CHANGES_HELP =
  "What changed in a dataset? TDEI has no dataset-diff operation. Answer from lineage and exact versions: use tdei_get_dataset_details and compare the dataset id, metadata version, upload/publication dates, source, data type and derived_from_dataset_id (the dataset it was derived from, e.g. by a workspace export); compare exact dataset ids/versions, never dataset names. " +
  "tdei_list_versions lists supported data-standard (schema) versions, not dataset release versions. Only for data that came from a workspace, and only if the workspace server is connected (otherwise skip this), get_workspace there shows the source dataset lineage and its changeset tools show individual edits; the per-feature edits view (review or restore) is only in the Workspaces web UI. " +
  "If lineage or the source/version cannot be verified from metadata, say so and suggest confirming with the data steward or field checks rather than inferring changes.";

const WORKSPACE_COMPANION_KEYS = [
  "findDatasets",
  "listMyProjectGroups",
  "listServices",
  "getDatasetDetails",
  "getMyIdentity",
] as const;

function withWorkspaceNotes<T extends Record<string, string>>(base: T): T {
  const note = workspaceCompanionNote();
  const out: Record<string, string> = { ...base };
  for (const key of WORKSPACE_COMPANION_KEYS) {
    if (!(key in out)) continue;
    const flow = key === "findDatasets" || key === "listMyProjectGroups" ? ` ${WORKSPACE_CREATE_FLOW}` : "";
    const changes = key === "getDatasetDetails" || key === "findDatasets" ? ` ${DATASET_CHANGES_HELP}` : "";
    out[key] = `${out[key]}${flow}${changes} ${note}`;
  }
  return out as T;
}

/** UI-only tasks that surface from these core tools: hand the user to the right web page with the steps. */
const WEB_UI_HANDOFFS: Record<string, readonly WebUiTask[]> = {
  listServices: ["create_service", "export_workspace"],
  listMyProjectGroups: ["manage_project_group_members"],
  getMyIdentity: ["manage_project_group_members", "register_account"],
  verifyEmail: ["register_account"],
  recoverPassword: ["register_account"],
};

function withWebUiHandoffs<T extends Record<string, string>>(base: T): T {
  const out: Record<string, string> = { ...base };
  for (const [key, tasks] of Object.entries(WEB_UI_HANDOFFS)) {
    if (!(key in out)) continue;
    out[key] = `${out[key]} ${tasks.map((task) => webUiHandoff(task)).join(" ")}`;
  }
  return out as T;
}

export const SEMANTIC_TOOL_DESCRIPTIONS = withWebUiHandoffs(withWorkspaceNotes(BASE_SEMANTIC_TOOL_DESCRIPTIONS));
