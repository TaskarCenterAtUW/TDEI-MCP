import { TDEI_USER_MY_ROLES_HELP } from "../tdei-user/tool-instructions.js";
import { webUiHandoff, type WebUiTask } from "../tdei-shared/web-ui-handoffs.js";
import { workspaceCompanionNote } from "../tdei-shared/companion-servers.js";

export const TDEI_LLM_CACHE_INSTRUCTIONS =
  "Cache and reuse stable TDEI reference data (project group IDs and names, service IDs and types, dataset IDs and metadata) within the conversation context instead of re-fetching on every turn. Only re-query when the user asks to refresh, changes filter criteria, or after a mutation (such as dataset upload or creation).";

export const TDEI_PRESENTATION_INSTRUCTIONS =
  "Always beautify list results for the user: render datasets, services, project groups, jobs, feedbacks, versions, and metrics as a markdown table (one row per item with key columns such as name, type, project group, dates, and IDs) plus a one-line count summary. Never present raw JSON arrays as the primary answer; keep full IDs available for follow-up actions. " +
  "When a result carries summary counts plus a table, the summary covers every match and the table shows only the first N rows: report the summary numbers (they are the complete answer for count/average questions), say how many rows are shown out of how many matched, and offer to raise the row limit (up to 500 where supported) or narrow the filters instead of treating the visible table as the whole set. " +
  "When a result carries a pagination block, use it for 'showing X of Y' (returned/total) and follow hasMore exactly: true means at least one more row exists (pass page+1, or raise limit); false means the response is complete — never guess the end by waiting for a short page. " +
  "List endpoints also return X-Total-Count / X-Page-No / X-Page-Size response headers with a Link rel=\"next\" header only when another page exists: prefer that exact total for 'showing X of Y' and keep every active search filter when following the next page.";

const BASE_SEMANTIC_TOOL_DESCRIPTIONS = {
  findDatasets:
    "Find TDEI datasets from a natural-language place or bounding box. Use for requests such as 'get me the latest dataset for Seattle'. Searches dataset name first, then city, then forward-geocodes the place for a bbox search. Narrows by projectGroupId or serviceId when the user names a project group or service — pass BOTH when the user names both, the API ANDs them so the scan reads far fewer pages. A projectGroupId/serviceId search scans dataset pages newest-first and keeps the latest version of each dataset name (numeric version compare so 1.10 beats 1.9, newest upload as tie-break) and reports versionsAvailable, so 'latest datasets for <project group>' returns one row per name with no duplicate versions; pass latestPerName:false only when the user wants every version. This is the only implementation of the latest-unique-datasets rule — dependent flows (tdei_get_dataset_details, tdei_download_dataset, workspace creation) resolve their dataset through this tool and inherit it. Supports exact lookup via tdeiDatasetId (release-status follow-ups) and recent-upload filtering via uploadedAfter / uploadedWithinDays (the API has no uploaded_after: filtering is client-side on uploaded_timestamp, but date-filtered scans stop paging early once pages predate the cutoff, so 'datasets uploaded today' reads ~1 page instead of the whole group). Any further detail the user gives is pushed to the API as a server-side filter — always pass it through, never filter client-side: version, dataSource (3rdParty/TDEITools/InHouse), collectionMethod (manual/transform/generated/other), collectedBy, derivedFromDatasetId, collectionDate (datasets collected after), confidenceLevel (minimum 0-100), schemaVersion, validFrom, validTo, city, county, region. A place given together with projectGroupId/serviceId narrows the listing by dataset name server-side. Returns ambiguity instead of guessing a place. The datasets API (GET /api/v1/datasets) returns one page per call with the full match set described in X-Total-Count / X-Page-No / X-Page-Size response headers and a Link rel=\"next\" header only when another page exists (defaults page 1, size 10, max 50): report 'showing R of T' from that total and keep every search filter when paging. Every complete result includes a markdown match table (#, name, version, tdei_dataset_id UUID, data_type, status) — always show that table to the user with a count summary instead of raw JSON, and reuse its UUIDs for follow-up actions (download, details, incline checks) without re-searching. Cache returned dataset IDs, names, project_group_id, service_id, and metadata in conversation memory to avoid redundant searches across follow-up turns.",
  listMyProjectGroups:
    "List all TDEI project groups visible to the authenticated login via listProjectGroups (GET /api/v1/project-groups). This is NOT membership; for the caller's own project groups and roles use tdei_my_project_group_roles. Use for 'project', 'projects', 'project group', 'project groups'. For who-am-I use tdei_get_my_identity. Never page all results plus filter poc emails to infer membership. Every result carries data.pagination {page, pageSize, returned, hasMore} with an exact hasMore (a full page is settled with a 1-row lookahead, so a short page is never the only end-of-list signal; the project-groups API also returns the exact match total in X-Total-Count with X-Page-No / X-Page-Size headers and a Link rel=\"next\" header only when another page exists — defaults page 1, size 10, max 50); when hasMore is true pass page+1 to read on, keeping any searchText filter. Report 'showing R of T' from the X-Total-Count total. Cache and reuse returned project_group_id and name values across the conversation rather than calling repeatedly. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  listServices:
    "List TDEI services, optionally filtered by name, project group, or data type (OSW, GTFS Flex, or GTFS Pathways). Use for requests such as 'get me the list of services'. Every result carries data.pagination {page, pageSize, returned, hasMore} with an exact hasMore (a full page is settled with a 1-row lookahead; the services API also returns the exact match total in X-Total-Count with X-Page-No / X-Page-Size headers and a Link rel=\"next\" header only when another page exists — defaults page 1, size 10, max 50); when hasMore is true pass page+1 to read on, keeping every search filter (searchText, projectGroupId, serviceType). Report 'showing R of T' from the X-Total-Count total. Cache returned service IDs, names, project_group_id, and service types in conversation context and reuse them for subsequent dataset queries or uploads instead of re-fetching. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  validateDataset:
    'Validate an OSW, GTFS Flex, or GTFS Pathways dataset ZIP. Ask for the local ZIP file when it is missing — MCP never accepts file bytes: no inline_base64, no url fetch; asset must be a local_path with the absolute file path on the CLIENT machine (only embedded in the curl command, never read by the server). For OSW, the ZIP must contain nodes/edges/points GeoJSON. If the data type or asset is missing, returns structured questions. Otherwise returns a hands-free client-side curl command (any size, single hop, directly to the TDEI backend; gateway is not a relay): curl -X POST "<apiUrl>/api/v1/{osw|gtfs-flex|gtfs-pathways}/validate" -H "Authorization: Bearer $TDEI_TOKEN" -F "dataset=@/path/to/file.zip" -sS --fail-with-body, with the caller bearer already embedded. Execute it now with your shell tool on the CLIENT machine (no human step, do not ask the user to run it), then poll with tdei_list_jobs using the returned job_id. Once the job is COMPLETED, download its result with job_download.',
  uploadDataset:
    "Upload a dataset to TDEI. MCP never accepts file bytes — no inline_base64, no url fetch; asset must be a local_path with the absolute file path on the CLIENT machine (only embedded in the curl command, never read by the server). Checks the target project group, service, and required metadata first, then returns a hands-free client-side curl command (any size, single hop, directly to the TDEI backend; gateway is not a relay) with the caller bearer already embedded; the metadata JSON is piped into curl as a metadata.json file part (the endpoint requires a file upload, not a text field), all on one line. Execute it now with your shell tool on the CLIENT machine (no human step, do not ask the user to run it, do not save it to a script file). Then poll with tdei_list_jobs. Reuse cached projectGroupId and serviceId from earlier calls.",
  myProjectGroupRoles: TDEI_USER_MY_ROLES_HELP,
  getMyIdentity:
    "Return the caller's identity and roles decoded from the SSO JWT (username, email, roles, groups). Use for 'who am I' / 'my email' / 'what are my roles'. This is the ONLY source of the login email — never infer it from project-group poc contacts. TDEI has no roles endpoint; roles come from JWT realm_access/resource_access claims. Requires a signed-in session.",
  listJobs:
    'List TDEI jobs (GET /api/v1/jobs), one project group at a time. The API needs a project group, so ASK THE USER WHICH PROJECT GROUP FIRST (by name) unless they already named one; pass it as projectGroupName (resolved against your groups) or projectGroupId. Only when the user explicitly says "all" (all groups, every project) pass allGroups:true to search every group (slower). The tool pages through the jobs API itself (up to 20 pages of 50 per group) and dedupes repeats of the same job across groups by job id, so older jobs are reachable and you never page manually. Typical uses, most common first: (1) running jobs: status "IN-PROGRESS"; (2) the status of one job: jobId; (3) recent or failed jobs: status, jobType, createdWithinDays or a createdAfter/createdBefore window; (4) a job\'s result, which is the least common: only after the status is COMPLETED call job_download (GET /api/v1/job/download/<job_id>), never for FAILED or IN-PROGRESS jobs. If the reply is status needs_input, ask the user the question it contains and call again with their answer. Results are sorted newest first by created_at. The jobs API (GET /api/v1/jobs) returns one page per call with the full match set described in X-Total-Count / X-Page-No / X-Page-Size response headers and a Link rel="next" header only when another page exists (defaults page 1, size 10, max 50): report \'showing R of T\' from that total and keep every filter when paging. Read data.truncation: when mayHaveMore is true say the list may be incomplete and ask the user to narrow the filters (status, job type, job id, submitted-by-me vs group, a created-before/after window, one project group) or raise limit (max 500, default 50). Read data.summary for aggregates over every match: matchingJobs, duplicatesRemoved, pagesRead, and runtime stats (avg/min/max/stddev seconds over jobs with a created_at -> updated_at span) — use it for "how many jobs / how long did they take" questions instead of counting table rows. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON. Filters mirror the TDEI Portal Jobs page: jobId (Search Job Id); jobType (Job Type: Clone-Dataset, Confidence-Calculate, Dataset-BBox [portal: Filter Dataset by BBox], Dataset-Incline-Tag, Dataset-Publish, Dataset-Reformat, Dataset-Road-Tag, Dataset-Spatial-Join, Dataset-Union, Dataset-Upload, Dataset-Validate, Edit-Metadata, Quality-Metric, Quality-Report; portal labels and common wordings are accepted); status (COMPLETED, FAILED, IN-PROGRESS, ABANDONED); includeGroupJobs (portal Show: true = All jobs in the group, false or omitted = Submitted by me only). Date filters and limit are extras this tool adds. data.pagination mirrors the display window over every match (page 1, the row limit, exact total and hasMore) — use it when the user asks how many matched or for showing X of Y.',
  getDatasetDetails:
    "Get dataset details by exact tdei_dataset_id (status/release + metadata). Includes an incline note: incline presence is not in metadata — call tdei_check_dataset_incline (sync Sidewalk/incline tag-quality metric, one id per call) for a verdict; tag via tdei_tag_incline. Always beautify dataset details for the user as a markdown table instead of raw JSON.",
  getTcatQaReports:
    "Read-only TCAT QA/QC report inventory for a project group (optionally one service): scans ALL dataset pages (GET /api/v1/datasets, page_size 50, status All by default so pre-release rows are included), keeps the latest version per dataset name (numeric version compare so 1.10 beats 1.9, newest upload as tie-break), and returns one row per dataset with the QA/QC report fields from metadata.dataset_detail.custom_metadata: tcat_quality_report_url_pdf, tcat_quality_report_url_html, tcat_quality_report_code, tcat_qa_qc_report_version, map_source, plus pipeline_version, tract_no, area, county and release_notes. Use for 'QA/QC report detail for <project group/service>', 'latest report links per city', or 'which datasets are missing a quality report'. This is the READ side: tdei_generate_quality_report CREATES one report job for one dataset id, so never use it to look up existing reports. The summary counts always cover every scanned dataset; rows/table show at most limit rows (default 50), so when truncation.mayHaveMore is true narrow with serviceId, nameContains, reportFilter or uploadedWithinDays instead of calling again. data.pagination mirrors the display window over every match (page 1, the row limit, exact total and hasMore). Always beautify the table for the user as a markdown table plus the count summary instead of raw JSON; full report URLs live in rows[].reportUrlPdf / rows[].reportUrlHtml (the table only shows yes/missing).",
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
    "Tag inclines on an OSW dataset. Returns a job_id. Use tdei_check_dataset_incline first to see whether inclines are already present.",
  checkDatasetIncline:
    "Check whether OSW dataset Sidewalks have incline tags via POST /api/v1/osw/quality-metric/tag/{tdei_dataset_id} with [{entity_type:'Sidewalk',tags:['incline']}] (synchronous, no download, no job to poll). Single id -> one verdict with hasIncline/inclinePercent. Batch: pass tdeiDatasetIds (up to 50, checked with 5 parallel calls) or projectGroupName/projectGroupId with uploadedWithinDays (1 = 'uploaded today'); returns one row per dataset plus an N-of-M summary. For live per-dataset streaming, prefer parallel single-id calls in one block — each result renders as it completes instead of waiting for the batch. If no id or group is given, the tool asks. A false result is report-only: no incline job is run.",
  listFeedbacks:
    "List dataset-viewer feedbacks, optionally filtered by project group, dataset, date range, or status. The tool pages through the feedbacks API itself (up to 10 pages of 50) so older feedbacks are reachable and you never page manually; the table shows the newest limit rows (default 10, max 500) and the summary/truncation counts cover every match. data.pagination mirrors the display window over every match (page 1, the row limit, exact total and hasMore). Always beautify the list for the user as a markdown table with a count summary instead of raw JSON; for the full set as a file use tdei_download_feedbacks (CSV/GeoJSON).",
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
