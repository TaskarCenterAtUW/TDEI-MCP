import { lookupToolInstruction } from "../tdei-shared/register-openapi-tools.js";
import { TDEI_USER_TOOL_INSTRUCTIONS } from "../tdei-user/tool-instructions.js";

/**
 * Extra LLM-facing usage guidance appended to discovered TDEI OpenAPI tool
 * descriptions. The generated spec descriptions explain what an operation
 * does, but not the multi-step client-side runbooks this connector requires
 * (ask for missing ids, run file transfers via curl, poll the job, then fetch
 * the result). Keep entries keyed by the registered operation name.
 */
export const TDEI_TOOL_INSTRUCTIONS: Readonly<Record<string, string>> = {
  validateOswFile:
    "OSW validation accepts one ZIP file containing nodes/edges/points GeoJSON. MCP never accepts file bytes: ask the user for the absolute path of the .zip on the CLIENT machine, then execute this yourself with your shell tool on that machine (no human step): " +
    'curl -X POST "<apiUrl>/api/v1/osw/validate" -H "Authorization: Bearer $TDEI_TOKEN" -F "dataset=@/path/to/file.zip" -sS --fail-with-body with the caller bearer already embedded in the returned curlCommand (else $TDEI_TOKEN). File bytes flow directly to the TDEI backend; the gateway is not a relay. ' +
    "The response returns a job_id; poll it with tdei_list_jobs (jobId) until status is COMPLETED, then fetch the result with job_download (GET /api/v1/job/download/<job_id>). " +
    "Prefer tdei_validate_dataset, which asks for the missing file/data type and builds this hand-off automatically.",
  validateGtfsFlexFile:
    "GTFS Flex validation accepts one ZIP file. MCP never accepts file bytes: ask the user for the absolute path of the .zip on the CLIENT machine, then execute this yourself with your shell tool on that machine: " +
    'curl -X POST "<apiUrl>/api/v1/gtfs-flex/validate" -H "Authorization: Bearer $TDEI_TOKEN" -F "dataset=@/path/to/file.zip" -sS --fail-with-body with the caller bearer already embedded in the returned curlCommand. ' +
    "The response returns a job_id; poll it with tdei_list_jobs (jobId) and fetch the completed result with job_download. Prefer tdei_validate_dataset for the full hand-off.",
  validateGtfsPathwaysFile:
    "GTFS Pathways validation accepts one ZIP file. MCP never accepts file bytes: ask the user for the absolute path of the .zip on the CLIENT machine, then execute this yourself with your shell tool on that machine: " +
    'curl -X POST "<apiUrl>/api/v1/gtfs-pathways/validate" -H "Authorization: Bearer $TDEI_TOKEN" -F "dataset=@/path/to/file.zip" -sS --fail-with-body with the caller bearer already embedded in the returned curlCommand. ' +
    "The response returns a job_id; poll it with tdei_list_jobs (jobId) and fetch the completed result with job_download. Prefer tdei_validate_dataset for the full hand-off.",
  oswQualityReportGenerate:
    "Generate a quality report for exactly one OSW dataset (POST /api/v1/osw/quality-report/{tdei_dataset_id}). " +
    'The tdei_dataset_id is required: if the caller has not supplied one, ask "Which TDEI dataset id should get a quality report?" before calling; do not guess or substitute a dataset name. ' +
    "The response returns a job_id. Poll it with tdei_list_jobs (jobId) until status is COMPLETED, then get the report with job_download: GET /api/v1/job/download/<job_id>.",
  oswConfidenceCalculate:
    "Calculate confidence for one OSW dataset. Requires tdei_dataset_id (ask for it if missing). The response returns a job_id; poll with tdei_list_jobs and fetch the completed result with job_download (GET /api/v1/job/download/<job_id>).",
  oswQualityCalculate:
    "Calculate intersection quality for one OSW dataset. Requires tdei_dataset_id (ask for it if missing). The response returns a job_id; poll with tdei_list_jobs and fetch the completed result with job_download (GET /api/v1/job/download/<job_id>).",
  qualityMetricTag:
    "Tag quality metrics on an OSW dataset. Requires tdei_dataset_id and a tag-quality file. The response returns a job_id; poll with tdei_list_jobs and fetch the completed result with job_download (GET /api/v1/job/download/<job_id>).",
  sanitizeOswFile:
    "Sanitize an OSW ZIP. MCP never accepts file bytes: ask for the absolute path of the .zip on the CLIENT machine and run the upload via curl from that machine. The response returns a job_id; poll with tdei_list_jobs and fetch the completed result with job_download (GET /api/v1/job/download/<job_id>).",
  uploadOswFile:
    "Multipart upload (POST /api/v1/osw/upload/{tdei_project_group_id}/{tdei_service_id}): parts dataset (zip) and metadata (metadata.json) are required, changeset is optional; derived_from_dataset_id is an optional query parameter. Ask for the absolute paths on the CLIENT machine. The response is 202 with a job id; when the job is COMPLETED the new dataset id is response_props.tdei_dataset_id. Publishing later needs valid_from and valid_to set in the metadata.",
  editMetadata:
    "PUT /api/v1/metadata/{tdei_dataset_id} with one multipart part file (metadata.json). Returns 200. Set valid_from and valid_to here before publishing, or publish returns 400.",
  cloneDataset:
    "POST /api/v1/dataset/clone/{tdei_dataset_id}/{tdei_project_group_id}/{tdei_service_id} with one multipart part file (metadata.json). All three ids are required; resolve them first rather than guessing.",
  oswOnDemandFormat:
    "Multipart parts file, source_format and target_format are all required (osw to osm, or osm to osw). Returns 202 with a job id; poll, then fetch with job_download.",
  datasetTagRoad:
    "Query parameters source_dataset_id and target_dataset_id are both required. The target must be a pre-release dataset (a published target returns 400). Returns 202 with a job id.",
  "osw-union":
    "JSON body tdei_dataset_id_one and tdei_dataset_id_two (both required, OSW datasets the user can access). Returns 202 with a job id; 404 for an unknown id.",
  "osw-spatial-join":
    "JSON body: required target_dataset_id, source_dataset_id, target_dimension, source_dimension, join_condition (for example ST_Contains(ST_Buffer(geometry_target, 5), geometry_source)); optional join_filter_target, join_filter_source, aggregate, assignment_method. 400 for empty or invalid values or non-OSW datasets, 404 for unknown ids. Returns 202 with a job id.",
  job_download:
    "Download the result/output file for a completed job (GET /api/v1/job/download/{job_id}). " +
    "job_id is required: if missing, ask which job to download or look it up with tdei_list_jobs. " +
    "Check tdei_list_jobs first and only download after the job status is COMPLETED (FAILED jobs have no useful output). " +
    "Pass file to fetch a non-output artifact, such as the Pathways-Convert job's per-level reference data. " +
    "Returns a hands-free client-side curl command with the caller's bearer already embedded; execute it yourself with your shell tool on the CLIENT machine.",
};

/** Append the matching TDEI instruction to a discovered tool description. */
export function augmentTdeiToolDescription(operationName: string, description: string | undefined): string | undefined {
  return lookupToolInstruction(
    { ...TDEI_TOOL_INSTRUCTIONS, ...TDEI_USER_TOOL_INSTRUCTIONS },
    operationName,
    description,
  );
}
