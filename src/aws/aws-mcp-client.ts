import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { authManager } from "../auth/auth-manager.js";
import { getConfig } from "../config.js";

const DISCOVERY_TOKEN = "tdei-schema-discovery";
type ConnectionMode = "discovery" | "authenticated";

export class AwsMcpClient {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connectedMode: ConnectionMode | undefined;
  private connectedTokenVersion: number | undefined;

  constructor(private readonly tokenProvider?: () => Promise<string>) {}
  private async connectForDiscovery(): Promise<void> {
    if (this.client) return;

    console.error("[aws-mcp] starting AWS OpenAPI MCP server for tool discovery");
    await this.startChild(DISCOVERY_TOKEN, "discovery");
  }

  private async connectAuthenticated(): Promise<void> {
    if (this.tokenProvider) {
      // Stateless per-request path: always start a fresh child with the
      // request Bearer, then the caller closes it after the response.
      if (this.client) {
        await this.close();
      }
      console.error("[aws-mcp] starting per-request AWS OpenAPI MCP server");
      const accessToken = await this.tokenProvider();
      await this.startChild(accessToken, "authenticated");
      return;
    }

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

  protected async startChild(
    accessToken: string,
    mode: ConnectionMode,
    tokenVersion?: number,
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command: "uvx",
      args: [
        getConfig().awsMcpPackage,
        "--api-name",
        "tdei-gateway-dev",
        "--api-url",
        getConfig().apiUrl,
        "--spec-url",
        getConfig().specUrl,
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
    if (this.tokenProvider) {
      await this.connectAuthenticated();
      return this.client!.listTools();
    }
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
