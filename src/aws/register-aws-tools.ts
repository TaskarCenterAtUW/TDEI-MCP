/**
awsMcpClient.listTools()
        ↓
get all AWS-generated tools
        ↓
register each tool on outer McpServer
        ↓
forward each call to awsMcpClient.callTool()
 */

import {
  fromJsonSchema,
  type McpServer,
} from "@modelcontextprotocol/server";

import { awsMcpClient } from "./aws-mcp-client.js";
import { formatError, truncateText } from "../mcp/errors.js";
import { isToolAllowed, type EndpointFilter } from "../config-file.js";

export interface AwsToolClient {
  listTools: typeof awsMcpClient.listTools;
  callTool: typeof awsMcpClient.callTool;
}

export type AwsToolCall = (
  tool: string,
  input: Record<string, unknown>,
) => ReturnType<AwsToolClient["callTool"]>;

export interface AwsToolRegistrationResult {
  discovered: number;
  registered: number;
  skipped: number;
  toolSchemas: Map<string, { description?: string | undefined; inputSchema: unknown }>;
}

const registeredToolsByServer = new WeakMap<
  McpServer,
  Set<string>
>();

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
    // Shape-preserving: only text payloads are shortened in place.
    return { ...(result as Record<string, unknown>), content } as T;
  }
  return result;
}

// The live TDEI spec uses draft-04 boolean exclusiveMinimum/Maximum
// (e.g. {minimum: 0, exclusiveMinimum: true}), but fromJsonSchema expects
// draft 2020-12 numeric form. Rewrite in place before conversion; without
// this the whole load() fails on the first such schema.
export function sanitizeJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = sanitizeJsonSchema(node[i]);
    return node;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record["exclusiveMinimum"] === true) {
      record["exclusiveMinimum"] = typeof record["minimum"] === "number" ? record["minimum"] : undefined;
      if (record["exclusiveMinimum"] === undefined) delete record["exclusiveMinimum"];
    }
    if (record["exclusiveMaximum"] === true) {
      record["exclusiveMaximum"] = typeof record["maximum"] === "number" ? record["maximum"] : undefined;
      if (record["exclusiveMaximum"] === undefined) delete record["exclusiveMaximum"];
    }
    for (const key of Object.keys(record)) record[key] = sanitizeJsonSchema(record[key]);
    return record;
  }
  return node;
}

// Authentication is owned by the outer connector. Exposing these generated
// operations would give agents a second, conflicting way to manage tokens.
const CONNECTOR_MANAGED_AUTH_TOOLS = new Set([
  "authenticate",
  "refreshToken",
  "ssoRedirect",
  "ssoLogin",
  "ssoLogout",
]);

export async function registerAwsTools(
  server: McpServer,
  client: AwsToolClient = awsMcpClient,
  filter: EndpointFilter = { mode: "all", allow: [], deny: [] },
  onCall?: AwsToolCall,
): Promise<AwsToolRegistrationResult> {
  console.error(
    "[aws-tools] discovering AWS OpenAPI tools",
  );

  const result = await client.listTools();
  let registeredTools =
    registeredToolsByServer.get(server);

  if (!registeredTools) {
    registeredTools = new Set<string>();
    registeredToolsByServer.set(server, registeredTools);
  }

  console.error(
    `[aws-tools] discovered ${result.tools.length} tools`,
  );

  let skipped = 0;
  // Contract: this map covers only tools newly registered by THIS call
  // (early-continue above skips already-registered tools). AwsToolsLifecycle
  // accumulates across calls in allToolSchemas for workflow step validation.
  const toolSchemas = new Map<string, { description?: string | undefined; inputSchema: unknown }>();

  for (const awsTool of result.tools) {
    if (CONNECTOR_MANAGED_AUTH_TOOLS.has(awsTool.name)) {
      console.error(
        `[aws-tools] skipped connector-managed auth tool ${awsTool.name}`,
      );
      skipped += 1;
      continue;
    }

    if (!isToolAllowed(awsTool.name, filter)) {
      console.error(`[aws-tools] skipped ${awsTool.name} (disabled by config)`);
      skipped += 1;
      continue;
    }

    if (registeredTools.has(awsTool.name)) {
      continue;
    }

    const inputSchema =
      fromJsonSchema<Record<string, unknown>>(
        sanitizeJsonSchema(structuredClone(awsTool.inputSchema)) as Record<string, unknown>,
      );

    server.registerTool(
      awsTool.name,
      {
        ...(awsTool.description !== undefined ? { description: awsTool.description } : {}),
        inputSchema,
      },
      async (args) => {
        try {
          const raw = await (onCall
            ? onCall(awsTool.name, args)
            : client.callTool(
              awsTool.name,
              args,
            ));
          return truncateResult(raw);
        } catch (error) {
          return formatError(error);
        }
      },
    );

    registeredTools.add(awsTool.name);
    toolSchemas.set(awsTool.name, { description: awsTool.description, inputSchema: awsTool.inputSchema });

    console.error(
      `[aws-tools] registered ${awsTool.name}`,
    );
  }

  console.error(
    `[aws-tools] registered ${registeredTools.size} AWS tools total`,
  );

  return {
    discovered: result.tools.length,
    registered: registeredTools.size,
    skipped,
    toolSchemas,
  };
}
