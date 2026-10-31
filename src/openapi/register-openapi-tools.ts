import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";

import type { OpenApiToolDefinition } from "./openapi-mcp-client.js";

export interface OpenApiToolClient {
  listTools(): Promise<{ tools: OpenApiToolDefinition[] }>;
  callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ content: Array<Record<string, unknown>>; [key: string]: unknown }>;
}

export type OpenApiToolCall = (
  tool: string,
  input: Record<string, unknown>,
) => ReturnType<OpenApiToolClient["callTool"]>;

export interface RegisterOpenApiToolsOptions {
  hiddenOperations?: ReadonlySet<string>;
  isAllowed?: (operationName: string, tags?: string[]) => boolean;
  onCall?: OpenApiToolCall;
  mapResult?: (result: Awaited<ReturnType<OpenApiToolCall>>) => unknown;
  mapError?: (error: unknown) => unknown;
  logger?: (message: string) => void;
}

export interface OpenApiToolRegistrationResult {
  discovered: number;
  registered: number;
  skipped: number;
  toolSchemas: Map<string, { description?: string | undefined; inputSchema: unknown; tags?: string[] }>;
}

const registeredToolsByServer = new WeakMap<McpServer, Set<string>>();
const compiledInputSchemas = new WeakMap<object, ReturnType<typeof fromJsonSchema<Record<string, unknown>>>>();

export function sanitizeJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      node[index] = sanitizeJsonSchema(node[index]);
    }
    return node;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.exclusiveMinimum === true) {
      record.exclusiveMinimum = typeof record.minimum === "number" ? record.minimum : undefined;
      if (record.exclusiveMinimum === undefined) delete record.exclusiveMinimum;
    }
    if (record.exclusiveMaximum === true) {
      record.exclusiveMaximum = typeof record.maximum === "number" ? record.maximum : undefined;
      if (record.exclusiveMaximum === undefined) delete record.exclusiveMaximum;
    }
    for (const key of Object.keys(record)) {
      record[key] = sanitizeJsonSchema(record[key]);
    }
    return record;
  }
  return node;
}

function defaultError(error: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          code: "OPENAPI_TOOL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        }),
      },
    ],
  };
}

export async function registerOpenApiTools(
  server: McpServer,
  client: OpenApiToolClient,
  options: RegisterOpenApiToolsOptions = {},
): Promise<OpenApiToolRegistrationResult> {
  const logger = options.logger ?? (() => undefined);
  const hidden = options.hiddenOperations ?? new Set<string>();
  const isAllowed = options.isAllowed ?? (() => true);
  const listed = await client.listTools();
  let registered = registeredToolsByServer.get(server);
  if (!registered) {
    registered = new Set<string>();
    registeredToolsByServer.set(server, registered);
  }

  const toolSchemas = new Map<string, { description?: string | undefined; inputSchema: unknown; tags?: string[] }>();
  let skipped = 0;
  for (const tool of listed.tools) {
    const toolTags = Array.isArray((tool as { tags?: unknown }).tags)
      ? (tool as { tags: unknown[] }).tags.filter((t): t is string => typeof t === "string")
      : [];
    if (hidden.has(tool.name) || !isAllowed(tool.name, toolTags)) {
      skipped += 1;
      continue;
    }
    if (registered.has(tool.name)) continue;

    let inputSchema: ReturnType<typeof fromJsonSchema<Record<string, unknown>>> | undefined;
    if (tool.inputSchema !== null && typeof tool.inputSchema === "object") {
      inputSchema = compiledInputSchemas.get(tool.inputSchema);
      if (!inputSchema) {
        inputSchema = fromJsonSchema<Record<string, unknown>>(
          sanitizeJsonSchema(structuredClone(tool.inputSchema)) as Record<string, unknown>,
        );
        compiledInputSchemas.set(tool.inputSchema, inputSchema);
      }
    } else {
      inputSchema = fromJsonSchema<Record<string, unknown>>(
        sanitizeJsonSchema(structuredClone(tool.inputSchema)) as Record<string, unknown>,
      );
    }
    // Ensure tag label survives even when the provider omitted it from description
    // (e.g. fake clients in tests). OpenApiMcpClient already prefixes, so skip if present.
    let description = tool.description;
    if (toolTags.length > 0) {
      const prefix = `[${toolTags.join(", ")}]`;
      if (!description) {
        description = prefix;
      } else if (!description.startsWith(prefix)) {
        description = `${prefix} ${description}`;
      }
    }
    server.registerTool(
      tool.name,
      {
        ...(description !== undefined ? { description } : {}),
        inputSchema,
      },
      async (args) => {
        try {
          const result = await (options.onCall ? options.onCall(tool.name, args) : client.callTool(tool.name, args));
          return (options.mapResult ? options.mapResult(result) : result) as never;
        } catch (error) {
          return (options.mapError ? options.mapError(error) : defaultError(error)) as never;
        }
      },
    );
    registered.add(tool.name);
    toolSchemas.set(tool.name, {
      description,
      inputSchema: tool.inputSchema,
      ...(toolTags.length > 0 ? { tags: toolTags } : {}),
    });
    logger(`[openapi-tools] registered ${tool.name}${toolTags.length > 0 ? ` [${toolTags.join(", ")}]` : ""}`);
  }

  return {
    discovered: listed.tools.length,
    registered: registered.size,
    skipped,
    toolSchemas,
  };
}
