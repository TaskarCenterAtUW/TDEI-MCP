/**
 *
get token
↓
start AWS OpenAPI MCP
↓
connect MCP client
↓
list AWS tools
↓
call AWS tools
↓
restart when token changes
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { authManager } from "../auth/auth-manager.js";
import { config } from "../config.js";

export class AwsMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connectedTokenVersion?: number;

  async connect(): Promise<void> {
    const accessToken =
      await authManager.getAccessToken();

    const currentTokenVersion =
      authManager.getTokenVersion();

    // Existing AWS MCP child is using the current token.
    if (
      this.client &&
      this.connectedTokenVersion === currentTokenVersion
    ) {
      return;
    }

    // AWS MCP exists, but AuthManager now has a newer token.
    if (this.client) {
      console.error(
        "[aws-mcp] access token changed; restarting AWS MCP server",
      );

      await this.close();
    }

    console.error(
      "[aws-mcp] starting AWS OpenAPI MCP server",
    );

    const transport =
      new StdioClientTransport({
        command: "uvx",
        args: [
         config.awsMcpPackage,
          "--api-name",
          "tdei-gateway-dev",
          "--api-url",
          config.apiUrl,
          "--spec-url",
          config.specUrl,
          "--auth-type",
          "bearer",
          "--auth-token",
          accessToken,
          "--no-validate-output",
        ],
        stderr: "inherit",
      });

    const client = new Client({
      name: "tdei-aws-client",
      version: "0.1.0",
    });

    this.transport = transport;
    this.client = client;

    try {
      await client.connect(transport);
    } catch (error) {
      await this.close();
      throw error;
    }

    // Only mark the token version after the connection succeeds.
    this.connectedTokenVersion =
      currentTokenVersion;

    console.error(
      "[aws-mcp] connected successfully",
    );
  }

  async listTools() {
    await this.connect();

    return this.client!.listTools();
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ) {
    await this.connect();

    return this.client!.callTool({
      name,
      arguments: args,
    });
  }

  isConnected(): boolean {
    return Boolean(this.client);
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connectedTokenVersion = undefined;

    if (client) {
      await client.close();
    } else if (transport) {
      await transport.close();
    }
  }
}

export const awsMcpClient =
  new AwsMcpClient();
