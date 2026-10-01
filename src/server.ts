import { McpServer } from "@modelcontextprotocol/server";
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
import { log } from "./mcp/log.js";
import { registerAwsTools } from "./aws/register-aws-tools.js";
import { AwsToolsLifecycle } from "./aws/aws-tools-lifecycle.js";
import { config } from "./config.js";
import { loadConfigFile } from "./config-file.js";

export interface HealthProbes {
  fetchImpl?: typeof fetch;
  runUvx?: () => Promise<string>;
  canBind?: (port: number, host: string) => Promise<boolean>;
}

export interface HealthReport {
  ok: boolean;
  auth: { state: string; expiresAt?: number };
  child: { connected: boolean; mode: string };
  spec: { url: string; reachable: boolean; latencyMs?: number; hint?: string };
  uvx: { found: boolean; version?: string; hint?: string };
  callback: { url: string; portFree: boolean | "n/a"; hint?: string };
  config: { transport: string; mode: string };
}

async function defaultRunUvx(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("uvx", ["--version"], { timeout: 10_000 });
  return stdout;
}

async function defaultCanBind(port: number, host: string): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

export async function checkHealth(
  deps: {
    auth: Pick<AuthManager, "getStatus">;
    aws: { isConnected(): boolean };
  },
  probes: HealthProbes = {},
): Promise<HealthReport> {
  const fetchImpl = probes.fetchImpl ?? fetch;
  const status = deps.auth.getStatus();
  let spec: HealthReport["spec"];
  const specStart = Date.now();
  try {
    const response = await Promise.race([
      fetchImpl(config.specUrl, { method: "GET" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    await response.body?.cancel().catch(() => undefined);
    spec = { url: config.specUrl, reachable: response.ok, latencyMs: Date.now() - specStart };
  } catch {
    spec = { url: config.specUrl, reachable: false, hint: "Spec URL unreachable; check network and TDEI_SPEC_URL." };
  }

  let uvx: HealthReport["uvx"];
  try {
    const version = await (probes.runUvx ?? defaultRunUvx)();
    uvx = { found: true, version: version.trim() };
  } catch {
    uvx = { found: false, hint: "uvx not found on PATH; install uv (https://docs.astral.sh/uv/getting-started/installation/)." };
  }

  let callback: HealthReport["callback"];
  try {
    const url = new URL(config.ssoCallbackUrl);
    if (url.protocol === "https:") {
      callback = { url: config.ssoCallbackUrl, portFree: "n/a", hint: "https callback terminates remotely; no local bind applies." };
    } else {
      const port = Number(url.port);
      const free = await (probes.canBind ?? defaultCanBind)(port, url.hostname);
      callback = free
        ? { url: config.ssoCallbackUrl, portFree: true }
        : { url: config.ssoCallbackUrl, portFree: false, hint: `Port ${port} is in use; stop the occupying process before SSO login.` };
    }
  } catch {
    callback = { url: config.ssoCallbackUrl, portFree: false, hint: "Callback URL is invalid; check TDEI_SSO_CALLBACK_URL." };
  }

  const ok = spec.reachable && uvx.found && callback.portFree !== false;
  return {
    ok,
    auth: { state: status.state, ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}) },
    child: { connected: deps.aws.isConnected(), mode: status.authenticated ? "authenticated" : "discovery" },
    spec,
    uvx,
    callback,
    config: { transport: config.transport, mode: loadConfigFile().filter.mode },
  };
}

export interface ServerDependencies {
  authManager: Pick<
    AuthManager,
    "getAccessToken" | "getStatus" | "logout" | "startSsoLogin" | "getTokenVersion"
  >;
  awsMcpClient: Pick<
    AwsMcpClient,
    "callTool" | "close" | "listTools" | "isConnected"
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
    "tdei_sso_login",
    {
      description:
        "Start TDEI browser SSO login. Open the returned URL, complete login, then check tdei_auth_status.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        if (auth.getStatus().authenticated) {
          return {
            content: [{
              type: "text",
              text: "TDEI SSO session is already authenticated.",
            }],
          };
        }

        const login = await auth.startSsoLogin();

        void login.completion
          .then(async () => {
            console.error("[auth] SSO login successful");
            await awsToolsLifecycle.load();
          })
          .catch((error) => {
            console.error(
              "[auth] SSO login did not complete:",
              error instanceof Error ? error.message : String(error),
            );
          });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "login_pending",
                loginUrl: login.loginUrl,
                callbackUrl: login.callbackUrl,
                message: "Open loginUrl in your browser to sign in to TDEI.",
              }, null, 2),
            },
          ],
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
    "tdei_health",
    {
      description:
        "Report connector health: auth state, AWS child, spec reachability, uvx, callback port, and config. Read-only, safe signed-out, never emits tokens.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      log("info", "health check", { tool: "tdei_health" });
      const report = await checkHealth({ auth, aws: awsClient });
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
      description:
        "Check whether the connector currently has a usable TDEI SSO access token.",
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

        if (message === "TDEI_SSO_REQUIRED") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "TDEI SSO login is required. Call tdei_sso_login and open the returned URL.",
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
        const logout = await awsToolsLifecycle.logout();

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
              text: JSON.stringify({
                status: "logout_pending",
                logoutUrl: logout.logoutUrl,
                callbackUrl: logout.callbackUrl,
                message: "Open logoutUrl in your browser to complete TDEI SSO logout. Local tokens and the AWS API tool session have already been cleared.",
              }, null, 2),
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

  server.registerTool(
    "tdei_reload_config",
    {
      description:
        "Re-read tdei.config.json and register new endpoint tools and workflow_* tools. Removals require restart in v1.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await awsToolsLifecycle.reload();

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
  // still require SSO and restart the child with the real access token.
  try {
    await awsToolsLifecycle.load();
  } catch (error) {
    console.error(
      "[aws-tools] initial discovery failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  return server;
}
