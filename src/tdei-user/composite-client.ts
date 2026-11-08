import type { OpenApiMcpClient } from "../openapi/openapi-mcp-client.js";

/** The surface the lifecycle, HTTP server and health check use from an OpenAPI client. */
export type OpenApiClientLike = Pick<OpenApiMcpClient, "listTools" | "callTool" | "close" | "isConnected" | "refresh">;

/**
 * One OpenAPI "client" backed by two specs: the primary (TDEI core gateway) and a secondary (User Management
 * API). Tool names must be unique, so a secondary tool whose name is already taken by the primary is dropped.
 * The secondary is optional: when its spec cannot be loaded, the primary keeps working and the failure is
 * logged, so a User API outage never takes the core tools down.
 */
export class CompositeOpenApiClient implements OpenApiClientLike {
  private secondaryNames = new Set<string>();
  private listed = false;

  constructor(
    private readonly primary: OpenApiClientLike,
    private readonly secondary: OpenApiClientLike,
    private readonly log: (message: string) => void = (message) => console.error(message),
  ) {}

  async listTools(): ReturnType<OpenApiClientLike["listTools"]> {
    const primary = await this.primary.listTools();
    let extra: Awaited<ReturnType<OpenApiClientLike["listTools"]>>["tools"] = [];
    try {
      extra = (await this.secondary.listTools()).tools;
    } catch (error) {
      this.log(
        `[openapi] User Management API tools unavailable (${error instanceof Error ? error.message : String(error)}); continuing with core tools only`,
      );
    }
    const taken = new Set(primary.tools.map((tool) => tool.name));
    const kept = extra.filter((tool) => !taken.has(tool.name));
    this.secondaryNames = new Set(kept.map((tool) => tool.name));
    this.listed = true;
    return { tools: [...primary.tools, ...kept] };
  }

  async callTool(name: string, args: Record<string, unknown>): ReturnType<OpenApiClientLike["callTool"]> {
    if (!this.listed) await this.listTools();
    return this.secondaryNames.has(name) ? this.secondary.callTool(name, args) : this.primary.callTool(name, args);
  }

  isConnected(): boolean {
    return this.primary.isConnected();
  }

  async refresh(): Promise<boolean> {
    const primaryChanged = await this.primary.refresh();
    const secondaryChanged = await this.secondary.refresh().catch(() => false);
    if (primaryChanged || secondaryChanged) this.listed = false;
    return primaryChanged || secondaryChanged;
  }

  async close(): Promise<void> {
    this.listed = false;
    this.secondaryNames = new Set();
    await Promise.allSettled([this.primary.close(), this.secondary.close()]);
  }
}
