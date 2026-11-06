/**
 * How each semantic `tdei_*` tool maps onto TDEI OpenAPI operations.
 *
 * The OpenAPI spec is the source of truth for which inputs are mandatory.
 * `scripts/generate-tool-fields.ts` reads the spec, follows these bindings,
 * and writes `generated/tool-fields.generated.ts`. Tools with several
 * operations (OSW / Flex / Pathways) require only what EVERY operation
 * requires.
 */
export interface ToolSpecBinding {
  /** Backing OpenAPI operationIds. */
  ops: string[];
  /** Spec field -> semantic field(s), where the generic snake_case->camelCase rule is not enough. */
  rename?: Record<string, string | string[]>;
  /** Required by the semantic tool although the spec encodes it differently (for example in the URL path). */
  extraRequired?: string[];
  /** Spec-required fields the semantic tool deliberately handles itself. */
  waive?: string[];
  /** The semantic tool needs at least one of these. */
  oneOf?: string[];
}

const SHARED_NAMES: Record<string, string> = {
  tdei_dataset_id: "tdeiDatasetId",
  tdei_project_group_id: "projectGroupId",
  tdei_service_id: "serviceId",
  page_no: "page",
  page_size: "pageSize",
};

/** Generic spec-field -> semantic-field naming. */
export function semanticFieldNames(specField: string, binding: ToolSpecBinding): string[] {
  const renamed = binding.rename?.[specField];
  if (renamed !== undefined) return Array.isArray(renamed) ? renamed : [renamed];
  const shared = SHARED_NAMES[specField];
  if (shared) return [shared];
  return [specField.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())];
}

const THREE = (osw: string, flex: string, pathways: string): string[] => [osw, flex, pathways];

export const TOOL_SPEC_BINDINGS: Readonly<Record<string, ToolSpecBinding>> = {
  tdei_find_datasets: { ops: ["listDatasetFiles"], oneOf: ["place", "bbox", "projectGroupId", "tdeiDatasetId"] },
  tdei_list_my_project_groups: { ops: ["listProjectGroups"] },
  tdei_list_services: { ops: ["listServices"] },
  tdei_validate_dataset: {
    ops: THREE("validateOswFile", "validateGtfsFlexFile", "validateGtfsPathwaysFile"),
    rename: { dataset: "asset" },
    extraRequired: ["dataType"],
  },
  tdei_upload_dataset: {
    ops: THREE("uploadOswFile", "uploadGtfsFlexFile", "uploadGtfsPathwaysFile"),
    rename: { dataset: "asset" },
    extraRequired: ["dataType"],
  },
  tdei_get_my_identity: { ops: [] },
  // The spec requires a project group. The tool takes an id or a name (resolved against the caller's
  // groups), and only fans out across every group when told "all".
  tdei_list_jobs: {
    ops: ["listJobs"],
    waive: ["projectGroupId"],
    oneOf: ["projectGroupName", "projectGroupId", "allGroups"],
  },
  tdei_get_dataset_details: { ops: ["listDatasetFiles"], extraRequired: ["tdeiDatasetId"] },
  tdei_download_dataset: { ops: THREE("getOswFile", "getGtfsFlexFile", "getGtfsPathwaysFile") },
  tdei_publish_dataset: {
    ops: THREE("publishOswFile", "publishGtfsFlexFile", "publishGtfsPathwaysFile"),
    extraRequired: ["dataType"],
  },
  tdei_delete_dataset: { ops: ["deleteDataset"], extraRequired: ["confirm"] },
  tdei_clone_dataset: { ops: ["cloneDataset"], rename: { file: "metadata" }, extraRequired: ["confirm"] },
  tdei_edit_metadata: { ops: ["editMetadata"], rename: { file: "metadata" }, extraRequired: ["confirm"] },
  tdei_calculate_confidence: { ops: ["oswConfidenceCalculate"], rename: { file: "subRegionAsset" } },
  tdei_calculate_quality_intersection: { ops: ["oswQualityCalculate"], rename: { file: "polygonAsset" } },
  tdei_tag_quality_metric: { ops: ["qualityMetricTag"], rename: { file: "tagQualityAsset" } },
  tdei_generate_quality_report: { ops: ["oswQualityReportGenerate"] },
  tdei_sanitize_dataset: { ops: ["sanitizeOswFile"], rename: { dataset: "asset" } },
  tdei_convert_osw: { ops: ["oswOnDemandFormat"], rename: { file: "asset" } },
  tdei_convert_pathways: { ops: ["convertGtfsPathways"], rename: { dataset: "datasetAsset" } },
  tdei_self_merge: { ops: ["osw-self-merge"] },
  tdei_spatial_join: { ops: ["osw-spatial-join"] },
  tdei_union_datasets: { ops: ["osw-union"], extraRequired: ["confirm"] },
  tdei_cut_dataset_bbox: { ops: ["datasetBbox"] },
  tdei_tag_road: { ops: ["datasetTagRoad"] },
  tdei_tag_incline: { ops: ["datasetTagIncline"] },
  tdei_check_dataset_incline: { ops: ["datasetTagIncline"] },
  tdei_list_feedbacks: { ops: ["oswDatasetViewerFeedbacks"] },
  tdei_get_feedback_summary: { ops: ["oswDatasetViewerFeedbacksMetadata"] },
  tdei_download_feedbacks: { ops: ["oswDatasetViewerFeedbacksDownload"] },
  tdei_submit_feedback: {
    ops: ["oswDatasetViewerFeedback"],
    rename: { location: ["locationLatitude", "locationLongitude"] },
  },
  tdei_update_feedback_status: { ops: ["oswDatasetViewerFeedbackStatusUpdate"], extraRequired: ["updates"] },
  tdei_get_pm_tiles_url: { ops: ["oswDatasetViewerPMTiles"] },
  tdei_set_viewer_access: { ops: ["oswDatasetViewer"] },
  tdei_get_metrics: { ops: ["system-metrics", "data-metrics", "service-metrics"] },
  tdei_list_versions: { ops: THREE("listOswVersions", "listGtfsFlexVersions", "listGtfsPathwaysVersions") },
  tdei_get_system_info: { ops: ["system-capabilities"] },
  tdei_verify_email: { ops: ["verifyEmail"], extraRequired: ["email"] },
  tdei_recover_password: { ops: ["recoverPassword"], extraRequired: ["email"] },
  tdei_regenerate_api_key: { ops: ["regenerateApiKey"], extraRequired: ["confirm"] },
};
