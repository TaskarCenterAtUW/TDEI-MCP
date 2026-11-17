/**
 * Raw OpenAPI operations that a semantic `tdei_*` tool already covers.
 *
 * Exposing both versions of the same capability doubles the tools/list payload
 * and gives the model two overlapping ways to do one thing. These operations
 * are therefore left out of the tool catalog by default. They stay callable
 * from configured workflows (their schemas are still collected), and can be
 * exposed again with `TDEI_EXPOSE_ALL_RAW_TOOLS=1` or by naming them in an
 * `endpoints.allow` list. The confirm-gated destructive subset
 * (`ALWAYS_HIDDEN_RAW_OPERATIONS`: union, delete, clone, edit-metadata,
 * API-key regeneration) stays hidden even under `TDEI_EXPOSE_ALL_RAW_TOOLS=1`
 * because the raw form bypasses the semantic `confirm:true` gate; only an
 * explicit `endpoints.allow` entry exposes those.
 *
 * Deliberately NOT listed (no semantic equivalent): `job-download`,
 * `listApiVersions`.
 */
export const SEMANTIC_COVERED_RAW_OPERATIONS: ReadonlySet<string> = new Set([
  // tdei_find_datasets / tdei_get_dataset_details / tdei_download_dataset
  "listDatasetFiles",
  "getOswFile",
  "getGtfsFlexFile",
  "getGtfsPathwaysFile",
  // tdei_list_my_project_groups / tdei_list_services / tdei_list_jobs
  "listProjectGroups",
  "listServices",
  "listJobs",
  // tdei_validate_dataset / tdei_upload_dataset / tdei_publish_dataset
  "validateOswFile",
  "validateGtfsFlexFile",
  "validateGtfsPathwaysFile",
  "uploadOswFile",
  "uploadGtfsFlexFile",
  "uploadGtfsPathwaysFile",
  "publishOswFile",
  "publishGtfsFlexFile",
  "publishGtfsPathwaysFile",
  // tdei_delete_dataset / tdei_clone_dataset / tdei_edit_metadata
  "deleteDataset",
  "cloneDataset",
  "editMetadata",
  // quality, conversion and OSW processing
  "oswConfidenceCalculate",
  "oswQualityCalculate",
  "oswQualityReportGenerate",
  "qualityMetricTag",
  "sanitizeOswFile",
  "oswOnDemandFormat",
  "convertGtfsPathways",
  "osw-self-merge",
  "osw-spatial-join",
  "osw-union",
  "datasetBbox",
  "datasetTagRoad",
  "datasetTagIncline",
  // dataset viewer and feedback
  "oswDatasetViewer",
  "oswDatasetViewerPMTiles",
  "oswDatasetViewerFeedback",
  "oswDatasetViewerFeedbackStatusUpdate",
  "oswDatasetViewerFeedbacks",
  "oswDatasetViewerFeedbacksDownload",
  "oswDatasetViewerFeedbacksMetadata",
  // tdei_list_versions / tdei_get_metrics / tdei_get_system_info
  "listOswVersions",
  "listGtfsFlexVersions",
  "listGtfsPathwaysVersions",
  "system-metrics",
  "data-metrics",
  "service-metrics",
  "system-capabilities",
  // tdei_verify_email / tdei_recover_password / tdei_regenerate_api_key
  "verifyEmail",
  "recoverPassword",
  "regenerateApiKey",
]);

export function exposeAllRawTools(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test((env.TDEI_EXPOSE_ALL_RAW_TOOLS ?? "").trim());
}

/**
 * Confirm-gated destructive operations that stay out of the tool catalog even
 * when `TDEI_EXPOSE_ALL_RAW_TOOLS=1` is set. Their semantic `tdei_*` wrappers
 * enforce `confirm:true` (see `confirmGuard` in the semantic intent module);
 * the raw operations would let the model merge, overwrite, delete or
 * invalidate without that gate, and would duplicate the union capability the
 * colleague report flagged (`tdei_union_datasets` vs `osw-union`). Naming one
 * of these in an `endpoints.allow` list still exposes it (explicit operator
 * intent); schemas are always collected so workflows can call them.
 */
export const ALWAYS_HIDDEN_RAW_OPERATIONS: ReadonlySet<string> = new Set([
  "osw-union",
  "deleteDataset",
  "cloneDataset",
  "editMetadata",
  "regenerateApiKey",
]);
