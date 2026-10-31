export const TDEI_LLM_CACHE_INSTRUCTIONS =
  "Cache and reuse stable TDEI reference data (project group IDs and names, service IDs and types, dataset IDs and metadata, and resolved intent mappings) within the conversation context instead of re-fetching on every turn. Only re-query when the user asks to refresh, changes filter criteria, or after a mutation (such as dataset upload or creation).";

export const TDEI_PRESENTATION_INSTRUCTIONS =
  "Always beautify list results for the user: render datasets, services, project groups, jobs, feedbacks, versions, and metrics as a markdown table (one row per item with key columns such as name, type, project group, dates, and IDs) plus a one-line count summary. Never present raw JSON arrays as the primary answer; keep full IDs available for follow-up actions.";

export const TDEI_SERVER_INSTRUCTIONS = `${TDEI_LLM_CACHE_INSTRUCTIONS}\n\n${TDEI_PRESENTATION_INSTRUCTIONS}`;

export const SEMANTIC_TOOL_DESCRIPTIONS = {
  resolveIntent:
    "Deterministically map a plain-language TDEI request to a supported semantic tool and underlying API operation. Use first when the request uses broad terms or aliases such as projects, organizations, orgs, or groups, or could match more than one TDEI domain. Returns a structured clarification instead of guessing when multiple intents are explicit. Cache the resolved intent mapping for similar requests in the conversation.",
  findDatasets:
    "Find TDEI datasets from a natural-language place or bounding box. Use for requests such as 'get me the latest dataset for Seattle'. Searches dataset name first, then city, then forward-geocodes the place for a bbox search. Supports exact lookup via tdeiDatasetId (release-status follow-ups) and recent-upload filtering via uploadedAfter / uploadedWithinDays (client-side on uploaded_timestamp; the API has no uploaded_after). Returns ambiguity instead of guessing a place. Every complete result includes a markdown match table (#, name, tdei_dataset_id UUID, data_type, status) — always show that table to the user with a count summary instead of raw JSON, and reuse its UUIDs for follow-up actions (download, details, incline checks) without re-searching. Cache returned dataset IDs, names, project_group_id, service_id, and metadata in conversation memory to avoid redundant searches across follow-up turns.",
  listMyProjectGroups:
    "List all TDEI project groups visible to the authenticated login via listProjectGroups (GET /api/v1/project-groups). This is NOT membership — TDEI has no membership endpoint. Use for 'project', 'projects', 'project group', 'project groups'. For who-am-I use tdei_get_my_identity. Never page all results plus filter poc emails to infer membership. Always state scopeExplanation in the answer. Cache and reuse returned project_group_id and name values across the conversation rather than calling repeatedly. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  listServices:
    "List TDEI services, optionally filtered by name, project group, or data type (OSW, GTFS Flex, or GTFS Pathways). Use for requests such as 'get me the list of services'. Cache returned service IDs, names, project_group_id, and service types in conversation context and reuse them for subsequent dataset queries or uploads instead of re-fetching. Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  validateDataset:
    'Validate an OSW, GTFS Flex, or GTFS Pathways dataset ZIP. MCP never accepts file bytes — no inline_base64, no url fetch; asset must be a local_path with the absolute file path on the CLIENT machine (only embedded in the curl command, never read by the server). If the data type or asset is missing, returns structured questions. Otherwise returns a ready-to-run client-side curl command (any size, single hop): curl -X POST "<apiUrl>/api/v1/{osw|gtfs-flex|gtfs-pathways}/validate" -H "Authorization: Bearer <SSO bearer>" -F "dataset=@/path/to/file.zip", then poll with tdei_list_jobs. The SSO bearer is already embedded in returned commands when the session is authenticated; otherwise sign in via SSO first.',
  uploadDataset:
    'Upload a dataset to TDEI. MCP never accepts file bytes — no inline_base64, no url fetch; asset must be a local_path with the absolute file path on the CLIENT machine (only embedded in the curl command, never read by the server). Checks the target project group, service, and required metadata first, then returns a ready-to-run client-side curl command (any size, single hop): curl -X POST "<apiUrl>/api/v1/{osw|gtfs-flex|gtfs-pathways}/upload/{projectGroupId}/{serviceId}" -H "Authorization: Bearer <SSO bearer>" -F "dataset=@/path/to/file.zip" -F \'metadata=<json>;type=application/json\'. Then poll with tdei_list_jobs. The SSO bearer is already embedded in returned commands when the session is authenticated. Reuse cached projectGroupId and serviceId from earlier calls.',
  getMyIdentity:
    "Return the caller's identity and roles decoded from the SSO JWT (username, email, roles, groups). Use for 'who am I' / 'my email' / 'what are my roles'. This is the ONLY source of the login email — never infer it from project-group poc contacts. TDEI has no roles endpoint; roles come from JWT realm_access/resource_access claims. Requires a signed-in session.",
  listJobs:
    "List TDEI jobs (GET /api/v1/jobs). The API requires tdei_project_group_id, so without projectGroupId this fans out across your accessible groups. Supports jobId lookup, jobType, status, and recent filtering via createdAfter / createdWithinDays (client-side on created_at). Always beautify the list for the user as a markdown table with a count summary instead of raw JSON.",
  getDatasetDetails:
    "Get dataset details by exact tdei_dataset_id (status/release + metadata). Includes an incline note: incline presence is not in metadata — download the ZIP via tdei_download_dataset and inspect edges for an incline tag; tag via tdei_tag_incline. Always beautify dataset details for the user as a markdown table instead of raw JSON.",
  downloadDataset:
    "Download a TDEI dataset ZIP to the user's machine. The MCP server never writes files, never touches bytes, and never resolves client filesystem paths — it resolves the dataset id + data type and returns a ready-to-run curl command with the SSO bearer already embedded. A UUID in tdeiDatasetId downloads immediately (pasting a full match-table row works too — the UUID is extracted from it). A dataset NAME does not download at once: the tool first returns the match table and asks for consent — for one match, repeat the call with confirm:true (or paste its UUID); for several matches, reply with the UUID or re-run with tdeiDatasetId set to the name plus selection:<1-based row number>. outputDir is an optional absolute folder on the CLIENT machine and defaults to the client-side expression $HOME/Downloads (your Downloads folder on macOS/Linux, and in PowerShell on Windows; substitute the absolute path on Windows cmd.exe). The LLM runs the returned curlCommand on the CLIENT machine; no manual token export needed when the session is authenticated.",
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
    "Generate a quality report for an OSW dataset. Returns a job_id; download output via job-download.",
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
  regenerateApiKey: "Regenerate the TDEI API key (invalidates the old key). Requires confirm:true.",
} as const;
