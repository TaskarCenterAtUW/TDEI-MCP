import { enforceToolNameLength } from "../openapi/openapi-mcp-client.js";

/**
 * Final MCP tool name for a Workspace API operationId.
 *
 * FastAPI generates long names such as
 * `get_project_role_api_v1_workspaces__workspace_id__tasking_projects__project_id__roles__user_id__get`
 * (75-121 chars). OpenAI/Meta reject anything over 64 chars, and Codex
 * prefixes tools as `mcp__<server>__<tool>`, so even a 64-char tool can
 * overflow. The function name before `_api_v1_` is unique per endpoint
 * (except the plumbing catch-all, which is never exposed) and short
 * (`get_project_role`, max ~33 chars exposed), so it is used as the tool
 * name. Anything still over 64 chars falls back to hash-truncated form.
 */
export function workspaceOperationName(operationId: string): string {
  const cut = operationId.indexOf("_api_v1_");
  const short = cut > 0 ? operationId.slice(0, cut) : operationId;
  const sanitized = short.replace(/[^A-Za-z0-9_]/g, "_");
  if (sanitized.length <= 64) return sanitized;
  return enforceToolNameLength(sanitized, operationId);
}

/** Short prefix used for instruction lookup (`long_name` -> `short`). */
export function shortWorkspaceOperationName(operationName: string): string {
  const cut = operationName.indexOf("_api_v1_");
  return cut > 0 ? operationName.slice(0, cut) : operationName;
}
