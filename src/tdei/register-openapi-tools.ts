import type { McpServer } from "@modelcontextprotocol/server";

import { openApiMcpClient } from "../tdei/openapi-provider.js";
import { normalizeOpenApiToolResult } from "../adapters/openapi-result-decoder.js";
import { formatError, truncateText } from "../mcp/errors.js";
import { isToolAllowed, type EndpointFilter } from "../config-file.js";
import {
  registerOpenApiTools,
  sanitizeJsonSchema,
  type OpenApiToolCall,
  type OpenApiToolClient,
  type OpenApiToolRegistrationResult,
} from "../openapi/register-openapi-tools.js";
import { augmentTdeiToolDescription } from "./tool-instructions.js";
import { exposeAllRawTools, SEMANTIC_COVERED_RAW_OPERATIONS } from "./raw-tool-coverage.js";

export type TdeiOpenApiToolClient = OpenApiToolClient;
export type TdeiOpenApiToolCall = OpenApiToolCall;
export type TdeiOpenApiToolRegistrationResult = OpenApiToolRegistrationResult;
export { sanitizeJsonSchema };

const CONNECTOR_MANAGED_AUTH_TOOLS = new Set(["authenticate", "refreshToken", "ssoRedirect", "ssoLogin", "ssoLogout"]);

function truncateResult<T>(result: T): T {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const content = (result as { content: Array<Record<string, unknown>> }).content.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        const { text } = truncateText(block.text);
        return { ...block, text };
      }
      return block;
    });
    return { ...(result as Record<string, unknown>), content } as T;
  }
  return result;
}

export async function registerTdeiOpenApiTools(
  server: McpServer,
  client: TdeiOpenApiToolClient = openApiMcpClient,
  filter: EndpointFilter = { mode: "all", allow: [], deny: [], allowTags: [], denyTags: [] },
  onCall?: TdeiOpenApiToolCall,
): Promise<TdeiOpenApiToolRegistrationResult> {
  console.error("[openapi-tools] discovering TDEI OpenAPI tools");
  // Semantic tools cover most raw operations; keep the duplicates out of the
  // catalog unless the operator opted in or explicitly allow-listed them.
  const explicitlyAllowed = new Set(filter.mode === "allow" ? filter.allow : []);
  const hideCovered = !exposeAllRawTools();
  const result = await registerOpenApiTools(server, client, {
    hiddenOperations: CONNECTOR_MANAGED_AUTH_TOOLS,
    isAllowed: (name, tags) => isToolAllowed(name, filter, tags ?? []),
    catalogHidden: (name) => hideCovered && SEMANTIC_COVERED_RAW_OPERATIONS.has(name) && !explicitlyAllowed.has(name),
    augmentDescription: augmentTdeiToolDescription,
    ...(onCall ? { onCall } : {}),
    mapResult: (toolResult) => truncateResult(normalizeOpenApiToolResult(toolResult)),
    mapError: formatError,
    logger: (message) => console.error(message),
  });
  console.error(`[openapi-tools] discovered ${result.discovered} tools`);
  console.error(`[openapi-tools] registered ${result.registered} OpenAPI tools total`);
  return result;
}
