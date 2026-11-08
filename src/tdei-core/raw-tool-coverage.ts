/**
 * Raw OpenAPI operations that a semantic `tdei_*` tool already covers.
 *
 * Exposing both versions of the same capability doubles the tools/list payload
 * and gives the model two overlapping ways to do one thing. These operations
 * are therefore left out of the tool catalog by default. They stay callable
 * from configured workflows (their schemas are still collected), and can be
 * exposed again with `TDEI_EXPOSE_ALL_RAW_TOOLS=1` or by naming them in an
 * `endpoints.allow` list.
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
