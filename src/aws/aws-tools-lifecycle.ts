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

type AuthSession = Pick<AuthManager, "logout">;
type AwsSession = Pick<
  AwsMcpClient,
  "close" | "listTools" | "callTool"
>;
type AwsToolRegistrar = typeof registerAwsTools;
type RegistrarClient = Parameters<AwsToolRegistrar>[1];

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
  private loaded = false;
  private operationQueue: Promise<void> =
    Promise.resolve();
  private allToolSchemas = new Map<
    string,
    { description?: string; inputSchema: unknown }
  >();

  constructor(
    private readonly server: McpServer,
    private readonly authSession: AuthSession,
    private readonly awsSession: AwsSession,
    private readonly registrar: AwsToolRegistrar,
  ) {}

  load(): Promise<"loaded" | "already-loaded"> {
    return this.serialize(async () => {
      if (this.loaded) {
        return "already-loaded";
      }

      await this.discoverAndRegister();
      this.loaded = true;

      return "loaded";
    });
  }

  reload(): Promise<"reloaded"> {
    return this.serialize<"reloaded">(async () => {
      await this.discoverAndRegister();
      this.loaded = true;

      return "reloaded";
    });
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
    );

    // Per-call toolSchemas cover newly registered tools only,
    // so accumulate across calls for workflow step validation.
    for (const [name, schema] of reg.toolSchemas) {
      if (!this.allToolSchemas.has(name)) {
        this.allToolSchemas.set(name, schema);
      }
    }

    const denied = deniedFor(effectiveFilter, discoveredNames);
    const callTool = (tool: string, input: Record<string, unknown>) =>
      this.awsSession.callTool(tool, input);

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
        this.loaded = false;
      }
    });
  }

  isLoaded(): boolean {
    return this.loaded;
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
