import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { authManager, type AuthManager } from "./auth/auth-manager.js";
import { BUILD } from "./build-info.js";
import type { OpenApiMcpClient } from "./openapi/openapi-mcp-client.js";
import { openApiMcpClient } from "./tdei/openapi-provider.js";
import { errorResult } from "./mcp/responses.js";
import { signInText } from "./mcp/errors.js";
import { log } from "./mcp/log.js";
import { registerTdeiOpenApiTools } from "./tdei/register-openapi-tools.js";
import { OpenApiToolsLifecycle } from "./openapi/openapi-tools-lifecycle.js";
import { getConfig } from "./config.js";
import { loadConfigFile } from "./config-file.js";
import { BinaryTdeiDownloads } from "./adapters/binary-tdei-downloads.js";
import { HttpTdeiOperations } from "./adapters/http-tdei-operations.js";
import { registerSemanticTools } from "./intents/register-tools.js";
import { TDEI_LLM_CACHE_INSTRUCTIONS } from "./intents/descriptions.js";
import { SemanticIntentModule } from "./intents/semantic-intent-module.js";
import { createConfiguredPlaceResolver } from "./adapters/configured-place-resolver.js";

export interface HealthProbes {
  fetchImpl?: typeof fetch;
  canBind?: (port: number, host: string) => Promise<boolean>;
}

export interface HealthReport {
  ok: boolean;
  auth: { state: string; expiresAt?: number };
  openapi: { loaded: boolean };
  spec: { url: string; reachable: boolean; latencyMs?: number; hint?: string };
  callback: { url: string; portFree: boolean | "n/a"; hint?: string };
  config: { transport: string; mode: string };
}

async function defaultCanBind(port: number, host: string): Promise<boolean> {
  const { createServer: createNetServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

export async function checkHealth(
  deps: {
    auth: Pick<AuthManager, "getStatus">;
    openapi: { isConnected(): boolean };
  },
  probes: HealthProbes = {},
): Promise<HealthReport> {
  const fetchImpl = probes.fetchImpl ?? fetch;
  const status = deps.auth.getStatus();
  let spec: HealthReport["spec"];
  const specStart = Date.now();
  try {
    const response = await Promise.race([
      fetchImpl(getConfig().specUrl, { method: "GET" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    await response.body?.cancel().catch(() => undefined);
    spec = { url: getConfig().specUrl, reachable: response.ok, latencyMs: Date.now() - specStart };
  } catch {
    spec = {
      url: getConfig().specUrl,
      reachable: false,
      hint: "Spec URL unreachable; check network and TDEI_SPEC_URL.",
    };
  }

  let callback: HealthReport["callback"];
  try {
    const url = new URL(getConfig().ssoCallbackUrl);
    if (url.protocol === "https:") {
      callback = {
        url: getConfig().ssoCallbackUrl,
        portFree: "n/a",
        hint: "https callback terminates remotely; no local bind applies.",
      };
    } else {
      const port = Number(url.port);
      const free = await (probes.canBind ?? defaultCanBind)(port, url.hostname);
      callback = free
        ? { url: getConfig().ssoCallbackUrl, portFree: true }
        : {
            url: getConfig().ssoCallbackUrl,
            portFree: false,
            hint: `Port ${port} is in use; stop the occupying process before SSO login.`,
          };
    }
  } catch {
    callback = {
      url: getConfig().ssoCallbackUrl,
      portFree: false,
      hint: "Callback URL is invalid; check TDEI_SSO_CALLBACK_URL.",
    };
  }

  const ok = spec.reachable && callback.portFree !== false;
  return {
    ok,
    auth: { state: status.state, ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}) },
    openapi: { loaded: deps.openapi.isConnected() },
    spec,
    callback,
    config: { transport: getConfig().transport, mode: loadConfigFile().filter.mode },
  };
}

export interface ServerDependencies {
  authManager: Pick<
    AuthManager,
    "completeSsoLogin" | "getAccessToken" | "getIdentity" | "getStatus" | "logout" | "startSsoLogin" | "getTokenVersion"
  >;
  openApiMcpClient: Pick<OpenApiMcpClient, "callTool" | "close" | "listTools" | "isConnected">;
  registerTdeiOpenApiTools: typeof registerTdeiOpenApiTools;
  binaryDownloads?: Pick<BinaryTdeiDownloads, "download">;
}

export async function createServer(
  dependencies: ServerDependencies = {
    authManager,
    openApiMcpClient,
    registerTdeiOpenApiTools,
  },
) {
  const auth = dependencies.authManager;
  const openApiClient = dependencies.openApiMcpClient;

  const server = new McpServer(
    {
      name: "tdei-mcp",
      version: BUILD.serverVersion,
    },
    {
      instructions: TDEI_LLM_CACHE_INSTRUCTIONS,
    },
  );
  const openApiToolsLifecycle = new OpenApiToolsLifecycle(
    server,
    auth,
    openApiClient,
    dependencies.registerTdeiOpenApiTools,
    dependencies.binaryDownloads ??
      new BinaryTdeiDownloads({
        baseUrl: getConfig().apiUrl,
        tokenProvider: () => auth.getAccessToken(),
      }),
  );
  // Semantic intents call TDEI over HTTP with the SSO bearer, while raw
  // generated tools use the in-process OpenAPI provider.
  // File bytes never move through this server in any mode: dataset downloads
  // run as curl on the client machine (tdei_download_dataset / raw download
  // tools return commands, never bytes), and uploads also run as client-side
  // curl, so no local_path asset is accepted here either.
  const semanticModule = new SemanticIntentModule({
    operations: new HttpTdeiOperations(getConfig().apiUrl, fetch, 15_000, {
      tokenProvider: () => auth.getAccessToken(),
      allowedAssetKinds: new Set(),
    }),
    places: createConfiguredPlaceResolver(getConfig()),
    apiUrl: getConfig().apiUrl,
    tokenProvider: () => auth.getAccessToken(),
    ...(typeof auth.getIdentity === "function" ? { identityProvider: () => (auth as AuthManager).getIdentity() } : {}),
  });
  registerSemanticTools(server, semanticModule);

  server.registerTool(
    "tdei_sso_login",
    {
      description: "Start TDEI browser SSO login. Open the returned URL, complete login, then check tdei_auth_status.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        if (auth.getStatus().authenticated) {
          return {
            content: [
              {
                type: "text",
                text: "TDEI SSO session is already authenticated.",
              },
            ],
          };
        }

        const login = await auth.startSsoLogin();

        void login.completion
          .then(async () => {
            console.error("[auth] SSO login successful");
            await openApiToolsLifecycle.load();
          })
          .catch((error) => {
            console.error("[auth] SSO login did not complete:", error instanceof Error ? error.message : String(error));
          });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "login_pending",
                  loginUrl: login.loginUrl,
                  callbackUrl: login.callbackUrl,
                  message: "Open loginUrl in your browser to sign in to TDEI.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tdei_sso_complete",
    {
      description:
        "Complete a pending TDEI SSO login using the final callback URL when the browser cannot reach the local callback listener.",
      inputSchema: z.object({
        callbackUrl: z
          .string()
          .url()
          .describe("The complete final http://127.0.0.1 callback URL from the browser address bar."),
      }),
    },
    async ({ callbackUrl }) => {
      try {
        await auth.completeSsoLogin(callbackUrl);
        await openApiToolsLifecycle.load();
        return {
          content: [{ type: "text", text: "TDEI SSO login completed." }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tdei_auth_status",
    {
      description:
        "Check whether TDEI SSO is configured and whether the current session is signed out, pending, or authenticated.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      const status = auth.getStatus();
      const identity = typeof auth.getIdentity === "function" ? auth.getIdentity() : undefined;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(identity ? { ...status, identity } : status, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "tdei_health",
    {
      description:
        "Report connector health: auth state, OpenAPI provider, specification reachability, callback port, and config. Read-only, safe signed-out, never emits tokens.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      log("info", "health check", { tool: "tdei_health" });
      const report = await checkHealth({ auth, openapi: openApiClient });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "tdei_test_authentication",
    {
      description: "Check whether the connector currently has a usable TDEI SSO access token.",
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
        const message = error instanceof Error ? error.message : String(error);

        if (message === "TDEI_SSO_REQUIRED") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `TDEI SSO login is required. ${signInText()}`,
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
        const logout = await openApiToolsLifecycle.logout();

        void logout.completion
          .then(() => console.error("[auth] SSO logout successful"))
          .catch((error) => {
            console.error(
              "[auth] SSO logout did not complete:",
              error instanceof Error ? error.message : String(error),
            );
          });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "logout_pending",
                  logoutUrl: logout.logoutUrl,
                  callbackUrl: logout.callbackUrl,
                  message:
                    "Open logoutUrl in your browser to complete TDEI SSO logout. Local tokens and the OpenAPI tool session have already been cleared.",
                },
                null,
                2,
              ),
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
      description: "Authenticate with TDEI and load all OpenAPI-generated TDEI API tools into this MCP server.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const loadResult = await openApiToolsLifecycle.load();

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

  server.registerTool(
    "tdei_reload_config",
    {
      description:
        "Re-read tdei.config.json and register new endpoint tools and workflow_* tools. Removals require restart in v1.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await openApiToolsLifecycle.reload();

        return {
          content: [
            {
              type: "text",
              text: `TDEI config reloaded: ${result}. New tools registered; removed tools require restart.`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // Discover tool definitions before MCP initialization so hosts that cache
  // the initial catalogue can see API tools before the user signs in. Calls
  // still require SSO and inject the current access token per request.
  try {
    await openApiToolsLifecycle.load();
  } catch (error) {
    console.error("[openapi-tools] initial discovery failed:", error instanceof Error ? error.message : String(error));
  }

  return server;
}
