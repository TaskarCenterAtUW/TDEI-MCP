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
import { errorResult } from "../mcp/responses.js";
import { isToolAllowed, type EndpointFilter } from "../config-file.js";

export interface AwsToolClient {
  listTools: typeof awsMcpClient.listTools;
  callTool: typeof awsMcpClient.callTool;
}

export interface AwsToolRegistrationResult {
  discovered: number;
  registered: number;
  skipped: number;
  toolSchemas: Map<string, { description?: string; inputSchema: unknown }>;
}

const registeredToolsByServer = new WeakMap<
  McpServer,
  Set<string>
>();

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
  const toolSchemas = new Map<string, { description?: string; inputSchema: unknown }>();

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
        awsTool.inputSchema as Record<string, unknown>,
      );

    server.registerTool(
      awsTool.name,
      {
        description: awsTool.description,
        inputSchema,
      },
      async (args) => {
        try {
          return await client.callTool(
            awsTool.name,
            args,
          );
        } catch (error) {
          return errorResult(error);
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
