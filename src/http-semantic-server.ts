import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { HttpTdeiOperations } from "./adapters/http-tdei-operations.js";
import { BUILD } from "./build-info.js";
import type { AuthManager } from "./auth/auth-manager.js";
import { getConfig } from "./config.js";
import { TDEI_LLM_CACHE_INSTRUCTIONS } from "./intents/descriptions.js";
import { registerSemanticTools } from "./intents/register-tools.js";
import { SemanticIntentModule } from "./intents/semantic-intent-module.js";
import type { PlaceResolver } from "./intents/place-resolver.js";
import { errorResult } from "./mcp/responses.js";
import { signInText } from "./mcp/errors.js";
import type { OpenApiMcpClient } from "./openapi/openapi-mcp-client.js";
import { OpenApiToolsLifecycle } from "./openapi/openapi-tools-lifecycle.js";
import type { DatasetAsset } from "./intents/types.js";
import { REGISTERED_SSO_REDIRECT_URI } from "./sso-public-callback.js";
import { registerTdeiOpenApiTools } from "./tdei/register-openapi-tools.js";

export interface HttpSemanticServerOptions {
  accessToken?: string;
  authManager?: AuthManager;
  openApiMcpClient?: OpenApiMcpClient;
  preloadOpenApiTools?: boolean;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  places?: PlaceResolver;
  publicBaseUrl?: string;
  /**
   * Gateway child slug. When set, SSO redirects the browser to the
   * Keycloak-registered loopback callback and does not bind a listener
   * inside the container. A local relay forwards that hit to /auth/callback.
   */
  gatewaySlug?: string | undefined;
  /**
   * Bind the loopback SSO callback listener on login/logout (default true).
   * The Streamable HTTP server already serves /auth/callback on its own
   * port, so it passes false and SSO never holds a second port.
   */
  ssoCallbackListener?: boolean | undefined;
}

function normalizeCallbackUrlForComplete(input: string, configuredCallbackUrl: string): string {
  const trimmed = input.trim();
  const configured = new URL(configuredCallbackUrl);
  if (trimmed.startsWith("?") || trimmed.startsWith("code=") || trimmed.startsWith("state=")) {
    const query = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    configured.search = query;
    return configured.toString();
  }
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.pathname === "/auth/callback" ||
        parsed.pathname === "/callback" ||
        parsed.pathname.endsWith("/auth/callback")) &&
      (parsed.searchParams.has("code") || parsed.searchParams.has("error"))
    ) {
      configured.search = parsed.search;
      return configured.toString();
    }
  } catch {
    // Fall through and let AuthManager.completeSsoLogin validate as-is.
  }
  return trimmed;
}

export function createHttpSemanticServer(options: HttpSemanticServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "tdei-mcp",
      version: BUILD.serverVersion,
    },
    {
      instructions: TDEI_LLM_CACHE_INSTRUCTIONS,
    },
  );
  const auth = options.authManager;
  const module = new SemanticIntentModule({
    operations: new HttpTdeiOperations(
      options.apiUrl,
      options.fetchImpl,
      15_000,
      auth
        ? {
            tokenProvider: () => auth.getAccessToken(),
            allowedAssetKinds: new Set<DatasetAsset["kind"]>(),
          }
        : undefined,
    ),
    places: options.places ?? {
      async forwardGeocode() {
        return [];
      },
    },
    apiUrl: options.apiUrl,
    ...(auth ? { identityProvider: () => auth.getIdentity() } : {}),
  });
  const accessToken = options.accessToken;
  registerSemanticTools(server, module, accessToken !== undefined ? () => ({ accessToken }) : undefined);

  if (auth) {
    const gatewaySlug = options.gatewaySlug?.trim() || undefined;
    const bindCallbackListener = gatewaySlug ? false : (options.ssoCallbackListener ?? true);
    const browserRedirectUri = gatewaySlug ? REGISTERED_SSO_REDIRECT_URI : undefined;
    const ssoBrowserOptions = {
      bindCallbackListener,
      ...(browserRedirectUri ? { redirectUri: browserRedirectUri } : {}),
    };
    const openApiLifecycle = options.openApiMcpClient
      ? new OpenApiToolsLifecycle(server, auth, options.openApiMcpClient, registerTdeiOpenApiTools)
      : undefined;

    server.registerTool(
      "tdei_sso_login",
      {
        description:
          "Start TDEI browser SSO login to fetch and store the TDEI access token for this MCP server session. Open the returned loginUrl in your browser to sign in.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          if (auth.getStatus().authenticated) {
            if (openApiLifecycle && !openApiLifecycle.isLoaded()) {
              await openApiLifecycle.load().catch(() => undefined);
            }
            return {
              content: [
                {
                  type: "text",
                  text: "TDEI SSO session is already authenticated.",
                },
              ],
            };
          }

          const login = await auth.startSsoLogin(ssoBrowserOptions);
          void login.completion
            .then(async () => {
              if (openApiLifecycle) {
                await openApiLifecycle.load().catch(() => undefined);
              }
            })
            .catch(() => undefined);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "login_pending",
                    loginUrl: login.loginUrl,
                    callbackUrl: browserRedirectUri ?? login.callbackUrl,
                    message:
                      "Open loginUrl in your browser to sign in to TDEI. Keycloak returns the browser to http://127.0.0.1:8765/callback. The client installer runs a local relay there that forwards the login to this gateway. When the page says login complete, return here.",
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
          "Complete a pending TDEI SSO login using the final callback URL (or ?code=...&state=... query string) from the browser address bar.",
        inputSchema: z.object({
          callbackUrl: z
            .string()
            .min(1)
            .describe(
              "The final callback URL (e.g. http://127.0.0.1:8765/callback?code=...&state=...) from the browser address bar.",
            ),
        }),
      },
      async ({ callbackUrl }) => {
        try {
          const normalized = normalizeCallbackUrlForComplete(callbackUrl, getConfig().ssoCallbackUrl);
          await auth.completeSsoLogin(normalized);
          if (openApiLifecycle) {
            await openApiLifecycle.load().catch(() => undefined);
          }
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
      async () => {
        const status = auth.getStatus();
        const identity = auth.getIdentity();
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
      "tdei_test_authentication",
      {
        description: "Check whether the connector currently has a usable TDEI SSO access token.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          await auth.getAccessToken();
          return {
            content: [{ type: "text", text: "TDEI authentication is valid." }],
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
            content: [{ type: "text", text: message }],
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
      async () => {
        try {
          const logout = openApiLifecycle
            ? await openApiLifecycle.logout(ssoBrowserOptions)
            : await auth.logout(ssoBrowserOptions);
          void logout.completion.catch(() => undefined);
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
                      "Open logoutUrl in your browser to complete TDEI SSO logout. Local tokens have been cleared.",
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

    if (openApiLifecycle) {
      server.registerTool(
        "tdei_load_api_tools",
        {
          description: "Load all OpenAPI-generated TDEI API tools into this MCP server.",
          inputSchema: z.object({}),
        },
        async () => {
          try {
            const loadResult = await openApiLifecycle.load();
            return {
              content: [
                {
                  type: "text",
                  text:
                    loadResult === "already-loaded"
                      ? "TDEI API tools are already loaded."
                      : "TDEI API tools loaded successfully.",
                },
              ],
            };
          } catch (error) {
            return errorResult(error);
          }
        },
      );
      if (options.preloadOpenApiTools || options.openApiMcpClient?.isConnected()) {
        (server as McpServer & { __openApiInit?: Promise<unknown> }).__openApiInit = openApiLifecycle
          .load()
          .catch(() => undefined);
      }
    }
  }

  return server;
}

export async function createReadyHttpSemanticServer(options: HttpSemanticServerOptions): Promise<McpServer> {
  const server = createHttpSemanticServer(options) as McpServer & {
    __openApiInit?: Promise<unknown>;
  };
  if (server.__openApiInit) {
    await server.__openApiInit;
  }
  return server;
}
