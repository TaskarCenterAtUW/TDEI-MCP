import type { McpServer } from "@modelcontextprotocol/server";

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

export type TdeiOpenApiToolClient = OpenApiToolClient;
export type TdeiOpenApiToolCall = OpenApiToolCall;
export type TdeiOpenApiToolRegistrationResult = OpenApiToolRegistrationResult;
export { sanitizeJsonSchema };

/** Auth operations the connector owns (tdei_sso_login etc.); never exposed as raw tools. */
export const CONNECTOR_MANAGED_AUTH_TOOLS = new Set([
  "authenticate",
  "refreshToken",
  "ssoRedirect",
  "ssoLogin",
  "ssoLogout",
]);

export const ALLOW_ALL_ENDPOINTS: EndpointFilter = { mode: "all", allow: [], deny: [], allowTags: [], denyTags: [] };

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

/** What differs between the core and workspace OpenAPI surfaces. */
export interface OpenApiProfileOptions {
  /** Short label used in log lines, e.g. "core" or "workspace". */
  label: string;
  /** Appends connector runbooks to a discovered tool description. */
  augmentDescription: (operationName: string, description: string | undefined) => string | undefined;
  /** Raw operations to keep out of the tool catalog (e.g. covered by semantic tools). */
  catalogHidden?: (name: string, filter: EndpointFilter) => boolean;
}

/** Register one backend's OpenAPI operations as MCP tools, with the shared auth/filter/result handling. */
export async function registerOpenApiToolsForProfile(
  server: McpServer,
  client: TdeiOpenApiToolClient,
  filter: EndpointFilter,
  onCall: TdeiOpenApiToolCall | undefined,
  profile: OpenApiProfileOptions,
): Promise<TdeiOpenApiToolRegistrationResult> {
  console.error(`[openapi-tools] discovering TDEI ${profile.label} OpenAPI tools`);
  const result = await registerOpenApiTools(server, client, {
    hiddenOperations: CONNECTOR_MANAGED_AUTH_TOOLS,
    isAllowed: (name, tags) => isToolAllowed(name, filter, tags ?? []),
    ...(profile.catalogHidden ? { catalogHidden: (name: string) => profile.catalogHidden!(name, filter) } : {}),
    augmentDescription: profile.augmentDescription,
    ...(onCall ? { onCall } : {}),
    mapResult: (toolResult) => truncateResult(normalizeOpenApiToolResult(toolResult)),
    mapError: formatError,
    logger: (message) => console.error(message),
  });
  console.error(`[openapi-tools] discovered ${result.discovered} tools`);
  console.error(`[openapi-tools] registered ${result.registered} OpenAPI tools total`);
  return result;
}

/** Look up `operationName` (or its snake_case form) in a per-profile instruction map. */
export function lookupToolInstruction(
  instructions: Readonly<Record<string, string>>,
  operationName: string,
  description: string | undefined,
): string | undefined {
  const instruction = instructions[operationName] ?? instructions[operationName.replace(/-/g, "_")];
  if (!instruction) return description;
  return description ? `${description}\n\n${instruction}` : instruction;
}
