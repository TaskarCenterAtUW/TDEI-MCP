import { lookupToolInstruction } from "../tdei-shared/register-openapi-tools.js";

/**
 * Extra LLM-facing usage guidance appended to discovered TDEI OpenAPI tool
 * descriptions. The generated spec descriptions explain what an operation
 * does, but not the multi-step client-side runbooks this connector requires
 * (ask for missing ids, run file transfers via curl, poll the job, then fetch
 * the result). Keep entries keyed by the registered operation name.
 */
export const TDEI_TOOL_INSTRUCTIONS: Readonly<Record<string, string>> = {
  validateOswFile:
    "OSW validation accepts one ZIP file containing nodes/edges/points GeoJSON. MCP never accepts file bytes: ask the user for the absolute path of the .zip on the CLIENT machine, then run this on that machine: " +
    'curl -X POST "<apiUrl>/api/v1/osw/validate" -H "Authorization: Bearer <SSO bearer from tdei_sso_login>" -F "dataset=@/path/to/file.zip" -sS --fail-with-body. ' +
    "The response returns a job_id; poll it with tdei_list_jobs (jobId) until status is COMPLETED, then fetch the result with job_download (GET /api/v1/job/download/<job_id>). " +
    "Prefer tdei_validate_dataset, which asks for the missing file/data type and builds this hand-off automatically.",
  validateGtfsFlexFile:
    "GTFS Flex validation accepts one ZIP file. MCP never accepts file bytes: ask the user for the absolute path of the .zip on the CLIENT machine, then run this on that machine: " +
    'curl -X POST "<apiUrl>/api/v1/gtfs-flex/validate" -H "Authorization: Bearer <SSO bearer from tdei_sso_login>" -F "dataset=@/path/to/file.zip" -sS --fail-with-body. ' +
    "The response returns a job_id; poll it with tdei_list_jobs (jobId) and fetch the completed result with job_download. Prefer tdei_validate_dataset for the full hand-off.",
  validateGtfsPathwaysFile:
    "GTFS Pathways validation accepts one ZIP file. MCP never accepts file bytes: ask the user for the absolute path of the .zip on the CLIENT machine, then run this on that machine: " +
    'curl -X POST "<apiUrl>/api/v1/gtfs-pathways/validate" -H "Authorization: Bearer <SSO bearer from tdei_sso_login>" -F "dataset=@/path/to/file.zip" -sS --fail-with-body. ' +
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
  job_download:
    "Download the result/output file for a completed job (GET /api/v1/job/download/{job_id}). " +
    "job_id is required: if missing, ask which job to download or look it up with tdei_list_jobs. " +
    "Check tdei_list_jobs first and only download after the job status is COMPLETED (FAILED jobs have no useful output). " +
    "Pass file to fetch a non-output artifact, such as the Pathways-Convert job's per-level reference data. " +
    "Returns a client-side curl command with the SSO bearer already embedded; run it on the CLIENT machine into the user-connected folder.",
};

/** Append the matching TDEI instruction to a discovered tool description. */
export function augmentTdeiToolDescription(operationName: string, description: string | undefined): string | undefined {
  return lookupToolInstruction(TDEI_TOOL_INSTRUCTIONS, operationName, description);
}
