import type { McpServer } from "@modelcontextprotocol/server";

import { openApiMcpClient } from "../tdei/openapi-provider.js";
import { formatError, truncateText } from "../mcp/errors.js";
import { isToolAllowed, type EndpointFilter } from "../config-file.js";
import {
  registerOpenApiTools,
  sanitizeJsonSchema,
  type OpenApiToolCall,
  type OpenApiToolClient,
  type OpenApiToolRegistrationResult,
} from "../openapi/register-openapi-tools.js";

export type AwsToolClient = OpenApiToolClient;
export type AwsToolCall = OpenApiToolCall;
export type AwsToolRegistrationResult = OpenApiToolRegistrationResult;
export { sanitizeJsonSchema };

const CONNECTOR_MANAGED_AUTH_TOOLS = new Set([
  "authenticate",
  "refreshToken",
  "ssoRedirect",
  "ssoLogin",
  "ssoLogout",
]);

function truncateResult<T>(result: T): T {
  if (
    typeof result === "object" && result !== null &&
    "content" in result && Array.isArray((result as { content: unknown }).content)
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

export async function registerAwsTools(
  server: McpServer,
  client: AwsToolClient = openApiMcpClient,
  filter: EndpointFilter = { mode: "all", allow: [], deny: [] },
  onCall?: AwsToolCall,
): Promise<AwsToolRegistrationResult> {
  console.error("[openapi-tools] discovering TDEI OpenAPI tools");
  const result = await registerOpenApiTools(server, client, {
    hiddenOperations: CONNECTOR_MANAGED_AUTH_TOOLS,
    isAllowed: (name) => isToolAllowed(name, filter),
    ...(onCall ? { onCall } : {}),
    mapResult: truncateResult,
    mapError: formatError,
    logger: (message) => console.error(message),
  });
  console.error(`[openapi-tools] discovered ${result.discovered} tools`);
  console.error(`[openapi-tools] registered ${result.registered} OpenAPI tools total`);
  return result;
}
