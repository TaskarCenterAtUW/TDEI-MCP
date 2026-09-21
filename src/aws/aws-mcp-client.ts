import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { authManager } from "../auth/auth-manager.js";
import { config } from "../config.js";

const DISCOVERY_TOKEN = "tdei-schema-discovery";
type ConnectionMode = "discovery" | "authenticated";

export class AwsMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connectedMode?: ConnectionMode;
  private connectedTokenVersion?: number;

  private async connectForDiscovery(): Promise<void> {
    if (this.client) return;

    console.error("[aws-mcp] starting AWS OpenAPI MCP server for tool discovery");
    await this.startChild(DISCOVERY_TOKEN, "discovery");
  }

  private async connectAuthenticated(): Promise<void> {
    const accessToken = await authManager.getAccessToken();
    const tokenVersion = authManager.getTokenVersion();

    if (
      this.client &&
      this.connectedMode === "authenticated" &&
      this.connectedTokenVersion === tokenVersion
    ) {
      return;
    }

    if (this.client) {
      console.error(
        this.connectedMode === "discovery"
          ? "[aws-mcp] restarting discovery server with authenticated session"
          : "[aws-mcp] access token changed; restarting AWS MCP server",
      );
      await this.close();
    }

    console.error("[aws-mcp] starting authenticated AWS OpenAPI MCP server");
    await this.startChild(accessToken, "authenticated", tokenVersion);
  }

  private async startChild(
    accessToken: string,
    mode: ConnectionMode,
    tokenVersion?: number,
  ): Promise<void> {
    const transport = new StdioClientTransport({
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

    this.connectedMode = mode;
    this.connectedTokenVersion = tokenVersion;
    console.error(`[aws-mcp] ${mode} connection successful`);
  }

  async listTools() {
    if (authManager.getStatus().authenticated) {
      await this.connectAuthenticated();
    } else {
      await this.connectForDiscovery();
    }
    return this.client!.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>) {
    // Every API invocation must upgrade a discovery-only child to a child
    // carrying the user's current SSO access token.
    await this.connectAuthenticated();
    return this.client!.callTool({ name, arguments: args });
  }

  isConnected(): boolean {
    return Boolean(this.client);
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connectedMode = undefined;
    this.connectedTokenVersion = undefined;

    if (client) {
      await client.close();
    } else if (transport) {
      await transport.close();
    }
  }
}

export const awsMcpClient = new AwsMcpClient();
