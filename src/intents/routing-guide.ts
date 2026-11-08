/**
 * Tool-routing guide shipped in the MCP server `instructions`.
 *
 * Choosing a tool from a plain-language request is the model's job, and it does
 * that better than a keyword matcher: it handles paraphrases, follows context,
 * and asks when a request is genuinely unclear. This guide gives it the
 * TDEI-specific knowledge it cannot infer: domain aliases and the few places
 * where two tools look alike.
 *
 * One row per semantic tool. A test asserts the guide and the registered tools
 * stay in sync, so adding a tool without a routing line fails CI.
 */
export interface ToolRoute {
  tool: string;
  /** Requests this tool handles, in the words users actually use. */
  use: string;
}

export const TOOL_ROUTING: readonly ToolRoute[] = [
  // Discover
  {
    tool: "tdei_list_my_project_groups",
    use: "projects, project groups, organizations/orgs, groups the login can see",
  },
  { tool: "tdei_list_services", use: "services, optionally for a project group or data type" },
  { tool: "tdei_find_datasets", use: "find/list/search datasets by place, city, name, bbox, project group or recency" },
  { tool: "tdei_get_dataset_details", use: "details, release status or metadata of one dataset id" },
  { tool: "tdei_get_my_identity", use: "who am I, my email/username, token roles" },
  {
    tool: "tdei_my_project_group_roles",
    use: "my project groups with my roles in each, my role in a project group, am I a poc / member of <project group>",
  },
  {
    tool: "tdei_list_jobs",
    use: "jobs and their progress: recent uploads, upload history, validation status, failed jobs",
  },
  { tool: "tdei_list_versions", use: "supported OSW/Flex/Pathways data-standard versions" },
  { tool: "tdei_get_metrics", use: "data, service or system metrics" },
  { tool: "tdei_get_system_info", use: "system capabilities, upload limits, API versions" },
  // Transfer
  { tool: "tdei_download_dataset", use: "download/save/pull a dataset ZIP (not feedbacks)" },
  { tool: "tdei_validate_dataset", use: "validate/check a dataset ZIP before upload" },
  { tool: "tdei_upload_dataset", use: "upload/submit/ingest a dataset ZIP" },
  // Manage
  { tool: "tdei_publish_dataset", use: "publish a dataset as an official release" },
  { tool: "tdei_delete_dataset", use: "delete a dataset (destructive, needs confirm)" },
  { tool: "tdei_clone_dataset", use: "clone a dataset into another project group/service" },
  { tool: "tdei_edit_metadata", use: "replace a dataset's metadata document" },
  // Process OSW
  { tool: "tdei_calculate_confidence", use: "confidence score for an OSW dataset" },
  { tool: "tdei_calculate_quality_intersection", use: "intersection quality metric for an OSW dataset" },
  { tool: "tdei_tag_quality_metric", use: "tag quality metrics from a tag-quality JSON" },
  { tool: "tdei_generate_quality_report", use: "quality report for one OSW dataset" },
  { tool: "tdei_sanitize_dataset", use: "fix invalid values in an OSW ZIP" },
  { tool: "tdei_convert_osw", use: "convert between OSW and OSM" },
  { tool: "tdei_convert_pathways", use: "build a first-draft GTFS Pathways dataset from CAD or ArcGIS" },
  { tool: "tdei_self_merge", use: "merge nearby entities inside one OSW dataset" },
  { tool: "tdei_spatial_join", use: "spatial join between two OSW datasets" },
  { tool: "tdei_union_datasets", use: "union two OSW datasets (needs confirm)" },
  { tool: "tdei_cut_dataset_bbox", use: "cut an OSW dataset down to a bounding box" },
  { tool: "tdei_tag_road", use: "tag sidewalks with a road network from another dataset" },
  { tool: "tdei_tag_incline", use: "add incline tags to an OSW dataset" },
  { tool: "tdei_check_dataset_incline", use: "does this dataset have inclines (run before tagging)" },
  // Feedback and viewer
  { tool: "tdei_list_feedbacks", use: "list viewer feedbacks" },
  { tool: "tdei_get_feedback_summary", use: "feedback counts and overdue summary" },
  { tool: "tdei_download_feedbacks", use: "download feedbacks as CSV/GeoJSON" },
  { tool: "tdei_submit_feedback", use: "submit feedback on a dataset element" },
  { tool: "tdei_update_feedback_status", use: "resolve or triage feedbacks" },
  { tool: "tdei_get_pm_tiles_url", use: "PMTiles URL to view a dataset" },
  { tool: "tdei_set_viewer_access", use: "dataset-viewer visibility for a dataset" },
  // Account
  { tool: "tdei_verify_email", use: "send an email-verification link" },
  { tool: "tdei_recover_password", use: "send a password-recovery link" },
  { tool: "tdei_regenerate_api_key", use: "regenerate the API key (invalidates the old one, needs confirm)" },
];

/** Cases where two tools look alike and a wrong pick is easy. */
const ROUTING_DISAMBIGUATION: readonly string[] = [
  'Jobs vs actions: "upload status", "validation status", "recent uploads" or "did my upload finish" ask about a job, so use tdei_list_jobs. Only "upload this" or "validate this" with a file is an action.',
  'Dataset vs feedback: "download feedbacks" is tdei_download_feedbacks, never tdei_download_dataset. "Download the dataset" is tdei_download_dataset.',
  "Identity vs project groups: tdei_list_my_project_groups lists groups visible to the login, not membership. Use tdei_my_project_group_roles for 'my roles in <project group>' or which groups the user belongs to, and tdei_get_my_identity for the user's own email or token roles.",
  "Details vs search: with an exact dataset id use tdei_get_dataset_details; with a place, name or filter use tdei_find_datasets.",
  "Inclines: check with tdei_check_dataset_incline first, then tag with tdei_tag_incline only if the user wants it added.",
  "Destructive tools (delete, clone, edit metadata, union, regenerate API key) need an explicit user confirmation before you pass confirm:true.",
];

export function renderToolRoutingGuide(): string {
  return [
    "## Choosing a tool",
    "Pick the tool from the user's intent; there is no separate intent-resolver tool. Project groups are also called projects, organizations or orgs. Prefer a semantic tdei_* tool over a raw API operation when both exist.",
    ...TOOL_ROUTING.map((route) => `- ${route.tool}: ${route.use}`),
    "",
    "Disambiguation:",
    ...ROUTING_DISAMBIGUATION.map((line) => `- ${line}`),
    "",
    "If a request clearly names several actions (for example validate and then upload), run them in order and carry results forward. If it is genuinely unclear which action is meant, ask one short clarifying question instead of guessing. A tool that needs missing input replies with status needs_input and the exact question to ask.",
  ].join("\n");
}
