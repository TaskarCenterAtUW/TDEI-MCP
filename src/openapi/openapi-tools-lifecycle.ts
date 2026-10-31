import type { McpServer } from "@modelcontextprotocol/server";

import type { AuthManager } from "../auth/auth-manager.js";
import type { SsoLogoutOptions, SsoLogoutStart } from "../auth/types.js";
import type { OpenApiMcpClient } from "../openapi/openapi-mcp-client.js";
import type { registerTdeiOpenApiTools } from "../tdei/register-openapi-tools.js";
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
type OpenApiSession = Pick<OpenApiMcpClient, "close" | "listTools" | "callTool">;
type OpenApiToolRegistrar = typeof registerTdeiOpenApiTools;
type RegistrarClient = Parameters<OpenApiToolRegistrar>[1];
type DownloadHandler = Pick<BinaryTdeiDownloads, "download">;

const ALLOW_ALL: EndpointFilter = { mode: "all", allow: [], deny: [], allowTags: [], denyTags: [] };

interface UnknownFilterId {
  section: "allow" | "deny";
  index: number;
  id: string;
}

function unknownFilterIds(filter: EndpointFilter, discoveredNames: string[]): UnknownFilterId[] {
  const known = new Set(discoveredNames);
  const check = (section: "allow" | "deny", ids: string[]): UnknownFilterId[] =>
    ids.flatMap((id, index) => (known.has(id) ? [] : [{ section, index, id }]));

  if (filter.mode === "allow") {
    return check("allow", filter.allow);
  }

  if (filter.mode === "deny") {
    return check("deny", filter.deny);
  }

  return [];
}

type McpCallResult = Awaited<ReturnType<OpenApiSession["callTool"]>>;

function toMcpResult(value: unknown): McpCallResult {
  if (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
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
  tagsByName: Map<string, string[]> = new Map(),
): Set<string> {
  const denied = new Set<string>();
  const allowTags = filter.allowTags ?? [];
  const denyTags = filter.denyTags ?? [];
  for (const name of discoveredNames) {
    if (CONNECTOR_AUTH_TOOLS.has(name) || name.startsWith(BUILTIN_TOOL_PREFIX)) continue;
    const tags = tagsByName.get(name) ?? [];
    if (denyTags.length > 0 && tags.some((t) => denyTags.includes(t))) {
      denied.add(name);
      continue;
    }
    if (allowTags.length > 0 && !tags.some((t) => allowTags.includes(t))) {
      denied.add(name);
      continue;
    }
  }

  if (filter.mode === "deny") {
    for (const id of filter.deny) denied.add(id);
    return denied;
  }

  if (filter.mode === "allow") {
    const allowed = new Set(filter.allow);
    for (const name of discoveredNames) {
      if (!allowed.has(name) && !CONNECTOR_AUTH_TOOLS.has(name) && !name.startsWith(BUILTIN_TOOL_PREFIX)) {
        denied.add(name);
      }
    }
    return denied;
  }

  return denied;
}

export class OpenApiToolsLifecycle {
  private state: "unloaded" | "loading" | "loaded" | "reloading" = "unloaded";
  private operationQueue: Promise<void> = Promise.resolve();
  private allToolSchemas = new Map<
    string,
    { description?: string | undefined; inputSchema: unknown; tags?: string[] }
  >();
  private denied = new Set<string>();

  constructor(
    private readonly server: McpServer,
    private readonly authSession: AuthSession,
    private readonly openApiSession: OpenApiSession,
    private readonly registrar: OpenApiToolRegistrar,
    private readonly downloads?: DownloadHandler,
  ) {}

  load(): Promise<"loaded" | "already-loaded"> {
    return this.serialize(async () => {
      if (this.state === "loaded") {
        return "already-loaded";
      }
      await this.ensureLoadedLocked();
      return "loaded";
    });
  }

  reload(): Promise<"reloaded"> {
    return this.serialize<"reloaded">(async () => {
      this.state = "reloading";
      await this.openApiSession.close();
      await this.discoverAndRegister();
      this.state = "loaded";
      return "reloaded";
    });
  }

  callTool(tool: string, input: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      await this.ensureLoadedLocked();
      // Binary downloads never touch server bytes or disk. They resolve to a
      // client-side curl instruction which the LLM runs on the CLIENT machine,
      // keeping them out of the generic text-oriented OpenAPI executor.
      if (BinaryTdeiDownloads.isDownloadTool(tool)) {
        const downloads =
          this.downloads ??
          new BinaryTdeiDownloads({
            baseUrl: getConfig().apiUrl,
            ...(this.authSession.getAccessToken ? { tokenProvider: () => this.authSession.getAccessToken!() } : {}),
          });
        return downloads.download(tool, input, {});
      }
      return this.openApiSession.callTool(tool, input);
    });
  }

  private async ensureLoadedLocked(): Promise<void> {
    if (this.state === "loaded") return;
    this.state = "loading";
    await this.discoverAndRegister();
    this.state = "loaded";
  }

  private async discoverAndRegister(): Promise<void> {
    ensureDefaultConfig();
    const cfg = loadConfigFile();

    // Single listTools per load/reload: the registrar reuses this
    // already-discovered list via a stub client (no second child spawn).
    const listed = await this.openApiSession.listTools();
    const discoveredNames = listed.tools.map((tool) => tool.name);
    const tagsByName = new Map<string, string[]>(
      listed.tools.map((tool) => [
        tool.name,
        Array.isArray((tool as { tags?: unknown }).tags)
          ? (tool as { tags: unknown[] }).tags.filter((t): t is string => typeof t === "string")
          : [],
      ]),
    );
    const knownTags = new Set<string>([...tagsByName.values()].flat());

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
    // Unknown tags also fall back to allow-all to avoid silently loading nothing.
    const unknownTags = [...(cfg.filter.allowTags ?? []), ...(cfg.filter.denyTags ?? [])].filter(
      (t) => !knownTags.has(t),
    );
    if (unknownTags.length > 0) {
      console.error(
        `[tdei-config] unknown tags in ${cfg.path}: ${[...new Set(unknownTags)].join(", ")} do not match any discovered OpenAPI tags (${[...knownTags].join(", ") || "none"}) — using allow-all`,
      );
      effectiveFilter = { ...ALLOW_ALL };
    }

    const discoveryClient: RegistrarClient = {
      listTools: async () => listed,
      callTool: (name: string, args: Record<string, unknown>) => this.openApiSession.callTool(name, args),
    };
    const reg = await this.registrar(this.server, discoveryClient, effectiveFilter, async (tool, input) =>
      toMcpResult(await this.callTool(tool, input)),
    );

    // Per-call toolSchemas cover newly registered tools only,
    // so accumulate across calls for workflow step validation.
    for (const [name, schema] of reg.toolSchemas) {
      if (!this.allToolSchemas.has(name)) {
        this.allToolSchemas.set(name, schema);
      }
    }

    const denied = deniedFor(effectiveFilter, discoveredNames, tagsByName);
    this.denied = denied;
    // Workflow steps route through the version gate too. This closure only
    // fires post-load (when MCP clients invoke workflow tools and the
    // serialize() queue is idle), so it cannot self-deadlock.
    // Download results are wrapped as MCP text content so template refs
    // (e.g. {{steps.fetch_osw.output.curlCommand}}) resolve against the client-side instruction.
    const callTool = async (tool: string, input: Record<string, unknown>) =>
      toMcpResult(await this.callTool(tool, input));

    // Offending workflows are skipped one by one; the rest register.
    for (const workflow of cfg.workflows) {
      try {
        registerWorkflows(this.server, [workflow], {
          callTool,
          toolSchemas: this.allToolSchemas,
          denied,
          configPath: cfg.path,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  logout(options?: SsoLogoutOptions): Promise<SsoLogoutStart> {
    return this.serialize(async () => {
      try {
        return await this.authSession.logout(options);
      } finally {
        await this.openApiSession.close();
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
    const result = this.operationQueue.then(operation, operation);

    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}
