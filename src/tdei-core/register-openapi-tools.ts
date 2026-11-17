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
import {
  exposeAllRawTools,
  ALWAYS_HIDDEN_RAW_OPERATIONS,
  SEMANTIC_COVERED_RAW_OPERATIONS,
} from "./raw-tool-coverage.js";
import { isUserApiHidden, USER_API_NEVER_EXPOSED } from "../tdei-user/operation-names.js";

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
  // Confirm-gated destructive operations (union, delete, clone, edit-metadata,
  // API-key regeneration) stay hidden even under TDEI_EXPOSE_ALL_RAW_TOOLS=1:
  // the raw form bypasses the semantic confirm:true gate, so only an explicit
  // endpoints.allow entry exposes them.
  const hideCovered = !exposeAllRawTools();
  return registerOpenApiToolsForProfile(server, client, filter, onCall, {
    label: "core",
    augmentDescription: augmentTdeiToolDescription,
    neverExposed: USER_API_NEVER_EXPOSED,
    catalogHidden: (name, f) => {
      if (!SEMANTIC_COVERED_RAW_OPERATIONS.has(name) && !isUserApiHidden(name)) return false;
      // Explicit allow-listing is deliberate operator intent: it wins.
      if (new Set(f.mode === "allow" ? f.allow : []).has(name)) return false;
      if (ALWAYS_HIDDEN_RAW_OPERATIONS.has(name)) return true;
      return hideCovered;
    },
  });
}
