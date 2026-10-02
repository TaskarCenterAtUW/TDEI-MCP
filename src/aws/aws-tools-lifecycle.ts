import type { McpServer } from "@modelcontextprotocol/server";

import type { AuthManager } from "../auth/auth-manager.js";
import type { SsoLogoutStart } from "../auth/types.js";
import type { AwsMcpClient } from "./aws-mcp-client.js";
import type { registerAwsTools } from "./register-aws-tools.js";
import {
  BUILTIN_TOOL_PREFIX,
  CONNECTOR_AUTH_TOOLS,
  ensureDefaultConfig,
  loadConfigFile,
  type EndpointFilter,
} from "../config-file.js";
import { registerWorkflows } from "../workflows/register.js";
import { BinaryTdeiDownloads } from "../adapters/binary-tdei-downloads.js";
import { getConfig } from "../config.js";

type AuthSession = Pick<AuthManager, "logout" | "getTokenVersion"> & {
  getAccessToken?: () => Promise<string>;
};
type AwsSession = Pick<
  AwsMcpClient,
  "close" | "listTools" | "callTool"
>;
type AwsToolRegistrar = typeof registerAwsTools;
type RegistrarClient = Parameters<AwsToolRegistrar>[1];
type DownloadHandler = Pick<BinaryTdeiDownloads, "download">;

const ALLOW_ALL: EndpointFilter = { mode: "all", allow: [], deny: [] };

interface UnknownFilterId {
  section: "allow" | "deny";
  index: number;
  id: string;
}

function unknownFilterIds(
  filter: EndpointFilter,
  discoveredNames: string[],
): UnknownFilterId[] {
  const known = new Set(discoveredNames);
  const check = (
    section: "allow" | "deny",
    ids: string[],
  ): UnknownFilterId[] =>
    ids.flatMap((id, index) =>
      known.has(id) ? [] : [{ section, index, id }],
    );

  if (filter.mode === "allow") {
    return check("allow", filter.allow);
  }

  if (filter.mode === "deny") {
    return check("deny", filter.deny);
  }

  return [];
}

type McpCallResult = Awaited<ReturnType<AwsSession["callTool"]>>;

function toMcpResult(value: unknown): McpCallResult {
  if (
    typeof value === "object" && value !== null && "content" in value &&
    Array.isArray((value as { content: unknown }).content)
  ) {
    return value as McpCallResult;
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function deniedFor(
  filter: EndpointFilter,
  discoveredNames: string[],
): Set<string> {
  if (filter.mode === "deny") {
    return new Set(filter.deny);
  }

  if (filter.mode === "allow") {
    const allowed = new Set(filter.allow);
    return new Set(
      discoveredNames.filter(
        (name) =>
          !allowed.has(name) &&
          !CONNECTOR_AUTH_TOOLS.has(name) &&
          !name.startsWith(BUILTIN_TOOL_PREFIX),
      ),
    );
  }

  return new Set<string>();
}

export class AwsToolsLifecycle {
  private state: "unloaded" | "loading" | "loaded" | "reloading" = "unloaded";
  private lastTokenVersion: number | undefined;
  private operationQueue: Promise<void> =
    Promise.resolve();
  private allToolSchemas = new Map<
    string,
    { description?: string | undefined; inputSchema: unknown }
  >();
  private denied = new Set<string>();

  constructor(
    private readonly server: McpServer,
    private readonly authSession: AuthSession,
    private readonly awsSession: AwsSession,
    private readonly registrar: AwsToolRegistrar,
    private readonly downloads?: DownloadHandler,
  ) {}

  load(): Promise<"loaded" | "already-loaded"> {
    return this.serialize(async () => {
      const current = this.authSession.getTokenVersion();
      if (this.state === "loaded" && this.lastTokenVersion === current) {
        return "already-loaded";
      }
      await this.ensureFreshLocked(current);
      return "loaded";
    });
  }

  reload(): Promise<"reloaded"> {
    return this.serialize<"reloaded">(async () => {
      this.lastTokenVersion = undefined;
      await this.ensureFreshLocked(this.authSession.getTokenVersion());
      return "reloaded";
    });
  }

  callTool(tool: string, input: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      await this.ensureFreshLocked(this.authSession.getTokenVersion());
      // Binary downloads bypass the AWS child: FastMCP decodes every
      // response body as UTF-8 (response.json() catching only
      // JSONDecodeError), so octet-stream ZIPs crash it with
      // "'utf-8' codec can't decode byte 0x83". Route those locally.
      if (BinaryTdeiDownloads.isDownloadTool(tool)) {
        const downloads = this.downloads ?? new BinaryTdeiDownloads({
          baseUrl: getConfig().apiUrl,
          ...(this.authSession.getAccessToken
            ? { tokenProvider: () => this.authSession.getAccessToken!() }
            : {}),
        });
        return downloads.download(tool, input, {});
      }
      return this.awsSession.callTool(tool, input);
    });
  }

  private async ensureFreshLocked(currentVersion: number): Promise<void> {
    if (this.state === "loaded" && this.lastTokenVersion === currentVersion) {
      return;
    }
    const firstLoad = this.lastTokenVersion === undefined;
    this.state = firstLoad ? "loading" : "reloading";
    if (!firstLoad) {
      console.error("[aws-mcp] token changed; restarting AWS MCP server");
      await this.awsSession.close();
    }
    await this.discoverAndRegister();
    this.lastTokenVersion = currentVersion;
    this.state = "loaded";
  }

  private async discoverAndRegister(): Promise<void> {
    ensureDefaultConfig();
    const cfg = loadConfigFile();

    // Single listTools per load/reload: the registrar reuses this
    // already-discovered list via a stub client (no second child spawn).
    const listed = await this.awsSession.listTools();
    const discoveredNames = listed.tools.map((tool) => tool.name);

    // Unknown allow/deny IDs fall back to allow-all in memory —
    // the single registrar call below runs with the effective filter.
    let effectiveFilter = cfg.filter;
    const unknownIds = unknownFilterIds(cfg.filter, discoveredNames);
    if (unknownIds.length > 0) {
      for (const { section, index, id } of unknownIds) {
        console.error(
          `[tdei-config] unknown operationId in ${cfg.path}: endpoints.${section}[${index}] "${id}" does not match any discovered tool — using allow-all`,
        );
      }
      effectiveFilter = { ...ALLOW_ALL };
    }

    const discoveryClient: RegistrarClient = {
      listTools: async () => listed,
      callTool: (name: string, args: Record<string, unknown>) =>
        this.awsSession.callTool(name, args),
    };
    const reg = await this.registrar(
      this.server,
      discoveryClient,
      effectiveFilter,
      async (tool, input) => toMcpResult(await this.callTool(tool, input)),
    );

    // Per-call toolSchemas cover newly registered tools only,
    // so accumulate across calls for workflow step validation.
    for (const [name, schema] of reg.toolSchemas) {
      if (!this.allToolSchemas.has(name)) {
        this.allToolSchemas.set(name, schema);
      }
    }

    const denied = deniedFor(effectiveFilter, discoveredNames);
    this.denied = denied;
    // Workflow steps route through the version gate too. This closure only
    // fires post-load (when MCP clients invoke workflow tools and the
    // serialize() queue is idle), so it cannot self-deadlock.
    // Download results are wrapped as MCP text content so template refs
    // (e.g. {{steps.fetch_osw.output.path}}) resolve against the file path.
    const callTool = async (tool: string, input: Record<string, unknown>) =>
      toMcpResult(await this.callTool(tool, input));

    // Offending workflows are skipped one by one; the rest register.
    for (const workflow of cfg.workflows) {
      try {
        registerWorkflows(
          this.server,
          [workflow],
          {
            callTool,
            toolSchemas: this.allToolSchemas,
            denied,
            configPath: cfg.path,
          },
        );
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  logout(): Promise<SsoLogoutStart> {
    return this.serialize(async () => {
      try {
        return await this.authSession.logout();
      } finally {
        await this.awsSession.close();
        this.lastTokenVersion = undefined;
        this.state = "unloaded";
      }
    });
  }

  isLoaded(): boolean {
    return this.state === "loaded";
  }

  isDenied(tool: string): boolean {
    return this.denied.has(tool);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(
      operation,
      operation,
    );

    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}
