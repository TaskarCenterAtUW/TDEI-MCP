import type { McpServer } from "@modelcontextprotocol/server";

import { openApiMcpClient } from "../tdei-shared/openapi-provider.js";
import type { EndpointFilter } from "../config-file.js";
import {
  ALLOW_ALL_ENDPOINTS,
  registerOpenApiToolsForProfile,
  sanitizeJsonSchema,
  type TdeiOpenApiToolCall,
  type TdeiOpenApiToolClient,
  type TdeiOpenApiToolRegistrationResult,
} from "../tdei-shared/register-openapi-tools.js";
import { augmentTdeiToolDescription } from "./tool-instructions.js";
import { exposeAllRawTools, SEMANTIC_COVERED_RAW_OPERATIONS } from "./raw-tool-coverage.js";

export type { TdeiOpenApiToolCall, TdeiOpenApiToolClient, TdeiOpenApiToolRegistrationResult };
export { sanitizeJsonSchema };

/** Register the TDEI core (api.tdei.us) OpenAPI operations. */
export async function registerTdeiOpenApiTools(
  server: McpServer,
  client: TdeiOpenApiToolClient = openApiMcpClient,
  filter: EndpointFilter = ALLOW_ALL_ENDPOINTS,
  onCall?: TdeiOpenApiToolCall,
): Promise<TdeiOpenApiToolRegistrationResult> {
  // Semantic tools cover most raw operations; keep the duplicates out of the
  // catalog unless the operator opted in or explicitly allow-listed them.
  const hideCovered = !exposeAllRawTools();
  return registerOpenApiToolsForProfile(server, client, filter, onCall, {
    label: "core",
    augmentDescription: augmentTdeiToolDescription,
    catalogHidden: (name, f) =>
      hideCovered && SEMANTIC_COVERED_RAW_OPERATIONS.has(name) && !new Set(f.mode === "allow" ? f.allow : []).has(name),
  });
}
