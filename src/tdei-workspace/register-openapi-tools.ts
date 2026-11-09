import type { McpServer } from "@modelcontextprotocol/server";

import { openApiMcpClient } from "../tdei-shared/openapi-provider.js";
import type { EndpointFilter } from "../config-file.js";
import {
  ALLOW_ALL_ENDPOINTS,
  registerOpenApiToolsForProfile,
  type TdeiOpenApiToolCall,
  type TdeiOpenApiToolClient,
  type TdeiOpenApiToolRegistrationResult,
} from "../tdei-shared/register-openapi-tools.js";
import { isToolAllowed } from "../config-file.js";
import { EXPORT_WORKSPACE_TOOL, registerExportWorkspaceTool } from "./export-tool.js";
import { augmentWorkspaceToolDescription } from "./tool-instructions.js";

/** Operations that are protocol plumbing, not user capabilities (health, OSM capabilities, catch-all proxy). */
export const WORKSPACE_PLUMBING_OPERATIONS = /^(health_check_|root__get|capabilities_|catch_all_)/;

/** Register the TDEI Workspace (ws-backend) OpenAPI operations. There are no semantic tools to dedupe against. */
export async function registerTdeiWorkspaceOpenApiTools(
  server: McpServer,
  client: TdeiOpenApiToolClient = openApiMcpClient,
  filter: EndpointFilter = ALLOW_ALL_ENDPOINTS,
  onCall?: TdeiOpenApiToolCall,
): Promise<TdeiOpenApiToolRegistrationResult> {
  const result = await registerOpenApiToolsForProfile(server, client, filter, onCall, {
    label: "workspace",
    augmentDescription: augmentWorkspaceToolDescription,
    catalogHidden: (name, f) =>
      WORKSPACE_PLUMBING_OPERATIONS.test(name) && !(f.mode === "allow" && f.allow.includes(name)),
  });
  // Export has no backend operation, so it is not in the OpenAPI spec; a real tool makes it discoverable by name.
  if (isToolAllowed(EXPORT_WORKSPACE_TOOL, filter, [])) {
    registerExportWorkspaceTool(server);
    return { ...result, registered: result.registered + 1 };
  }
  return result;
}
