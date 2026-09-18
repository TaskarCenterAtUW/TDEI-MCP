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

export interface AwsToolClient {
  listTools: typeof awsMcpClient.listTools;
  callTool: typeof awsMcpClient.callTool;
}

export interface AwsToolRegistrationResult {
  discovered: number;
  registered: number;
}

const registeredToolsByServer = new WeakMap<
  McpServer,
  Set<string>
>();

export async function registerAwsTools(
  server: McpServer,
  client: AwsToolClient = awsMcpClient,
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

  for (const awsTool of result.tools) {
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
  };
}
