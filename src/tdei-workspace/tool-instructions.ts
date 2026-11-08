import { lookupToolInstruction } from "../tdei-shared/register-openapi-tools.js";

/**
 * Extra LLM-facing guidance appended to discovered Workspace OpenAPI tool
 * descriptions, keyed by the discovered operation name (FastAPI operationIds
 * are long, so entries match by prefix of the operation name).
 */
const FILE_UPLOAD_HINT =
  "MCP never accepts file bytes: ask the user for the absolute path of the file on the CLIENT machine, then run the multipart curl from that machine with the SSO bearer from tdei_sso_login.";
const JOB_HINT =
  "Poll the job with get_jobs_by_workspace_id / get_job_by_id until it completes, and reuse cached workspace_id values from get_my_workspaces.";

export const TDEI_WORKSPACE_TOOL_INSTRUCTIONS: Readonly<Record<string, string>> = {
  create_workspace_from_file_api_v1_workspaces_from_file_post: `${FILE_UPLOAD_HINT} ${JOB_HINT}`,
  upload_project_aoi_api_v1_workspaces__workspace_id__tasking_projects__project_id__aoi_post: FILE_UPLOAD_HINT,
  get_my_workspaces_api_v1_workspaces_mine_get:
    "Call this first and cache every workspace_id and name; almost every other workspace tool is scoped by workspace_id. Never guess one.",
  reset_task_api_v1_workspaces__workspace_id__tasking_projects__project_id__tasks__task_number__reset_post:
    "Destructive: reset only when the user explicitly asks.",
  reset_project_api_v1_workspaces__workspace_id__tasking_projects__project_id__reset_post:
    "Destructive: reset only when the user explicitly asks.",
  delete_workspace_api_v1_workspaces__workspace_id__delete:
    "Destructive and irreversible: confirm the workspace name with the user first.",
};

export function augmentWorkspaceToolDescription(operationName: string, description: string | undefined) {
  return lookupToolInstruction(TDEI_WORKSPACE_TOOL_INSTRUCTIONS, operationName, description);
}
