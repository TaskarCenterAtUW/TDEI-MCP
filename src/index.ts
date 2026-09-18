import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";

import {
  authManager,
  type AuthManager,
} from "./auth/auth-manager.js";
import {
  awsMcpClient,
  type AwsMcpClient,
} from "./aws/aws-mcp-client.js";
import { errorResult } from "./mcp/responses.js";
import { registerAwsTools } from "./aws/register-aws-tools.js";
import { AwsToolsLifecycle } from "./aws/aws-tools-lifecycle.js";

export interface ServerDependencies {
  authManager: Pick<
    AuthManager,
    "getAccessToken" | "getStatus" | "logout"
  >;
  awsMcpClient: Pick<
    AwsMcpClient,
    "callTool" | "close" | "listTools"
  >;
  registerAwsTools: typeof registerAwsTools;
}

export async function createServer(
  dependencies: ServerDependencies = {
    authManager,
    awsMcpClient,
    registerAwsTools,
  },
) {
  const auth = dependencies.authManager;
  const awsClient = dependencies.awsMcpClient;

  const server = new McpServer({
    name: "tdei-mcp",
    version: "0.1.0",
  });
  const awsToolsLifecycle = new AwsToolsLifecycle(
    server,
    auth,
    awsClient,
    dependencies.registerAwsTools,
  );


  server.registerTool(
    "tdei_auth_status",
    {
      description:
        "Check whether TDEI credentials are configured and whether the current TDEI session is authenticated.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      const status = auth.getStatus();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "tdei_test_authentication",
    {
      description:
        "Authenticate with TDEI or verify that the current TDEI authentication session is valid.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      try {
        await auth.getAccessToken();

        return {
          content: [
            {
              type: "text",
              text: "TDEI authentication is valid.",
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        if (message === "TDEI_AUTH_REQUIRED") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "TDEI authentication is required. Configure TDEI_USERNAME and TDEI_PASSWORD before using protected TDEI tools.",
              },
            ],
          };
        }

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: message,
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "tdei_logout",
    {
      description: "Log out of the current TDEI session.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      try {
        await awsToolsLifecycle.logout();

        return {
          content: [
            {
              type: "text",
              text: "Logged out of TDEI session and closed the AWS API tool session.",
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    "tdei_load_api_tools",
    {
      description:
        "Authenticate with TDEI and load all AWS-generated TDEI API tools into this MCP server.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const loadResult = await awsToolsLifecycle.load();

        if (loadResult === "already-loaded") {
          return {
            content: [
              {
                type: "text",
                text: "TDEI API tools are already loaded.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: "TDEI API tools loaded successfully.",
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // Make generated tools available in the client's first tools/list response.
  // Some clients retain that first catalogue despite list-change notifications.
  try {
    await awsToolsLifecycle.load();
  } catch (error) {
    console.error(
      "[aws-tools] automatic loading failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  return server;
}

const entryPoint = process.argv[1];

if (
  entryPoint &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  console.error("[tdei-mcp] Starting MCP server");
  await serveStdio(() => createServer());
}
