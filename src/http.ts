import { resolveTdeiEnvironment } from "./tdei-shared/web-ui-handoffs.js";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport, type McpServer } from "@modelcontextprotocol/server";

import { getConfig, TdeiConfigError, TDEI_SSO_CLIENT_ID } from "./config.js";
import { AuthManager, injectAccessToken } from "./auth/auth-manager.js";
import { createHttpSemanticServer, createReadyHttpSemanticServer } from "./http-semantic-server.js";
import { renderStatusPage } from "./http-status-page.js";
import { checkHealth } from "./server.js";
import {
  clientMcpName,
  isSetupScriptAction,
  normalizeSetupClientTarget,
  renderClientSetupPowershell,
  renderClientSetupScript,
  renderSetupOverview,
  type SetupScriptAction,
} from "./http-setup-script.js";
import { isAuthCallbackPath, REGISTERED_SSO_REDIRECT_URI } from "./sso-public-callback.js";
import { RELAY_TRY_PARAM } from "./setup/relay.js";
import { expiresAtForTokens, saveSharedSession } from "./auth/shared-session.js";
import { sharedSessionAllowed } from "./auth/session-sharing.js";
import {
  oauthSecretIsConfigured,
  dispatchOAuth,
  matchesOAuthPath,
  oauthCallbackResult,
  oauthChallengeHeader,
  oauthEndpoints,
  type OAuthHttpResult,
} from "./oauth/mcp-oauth.js";
import { createConfiguredPlaceResolver } from "./adapters/configured-place-resolver.js";
import {
  resolveTdeiServerProfile,
  tdeiServerInstructions,
  type TdeiServerProfile,
} from "./intents/server-instructions.js";
import { BUILD } from "./build-info.js";
import { requestBearer } from "./auth/request-bearer.js";
import { loadConfigFile } from "./config-file.js";
import {
  renderSsoErrorPage,
  renderSsoFailurePage,
  renderSsoRelayRetryPage,
  renderSsoResultPage,
} from "./auth/sso-callback-page.js";
import { withGatewaySignIn } from "./intents/instructions/tdei-shared-instructions.js";
import { registerTdeiWorkspaceOpenApiTools } from "./tdei-workspace/register-openapi-tools.js";
import { registerTdeiOpenApiTools } from "./tdei-core/register-openapi-tools.js";
import { setSignInMode, signInText, tokenExpiredText } from "./mcp/errors.js";
import type { PlaceResolver } from "./intents/place-resolver.js";
import { createOpenApiClient } from "./tdei-user/client.js";
import type { OpenApiClientLike } from "./tdei-user/composite-client.js";

export interface HttpServeOptions {
  fetchImpl?: typeof fetch;
  /** Test hook: supplies OpenAPI spec documents instead of downloading them. */
  loadOpenApiSpec?: (specUrl: string) => Promise<Record<string, unknown>>;
  requireBearerAuth?: boolean;
  /**
   * Bind the loopback SSO callback listener on tdei_sso_login/logout
   * (default true). Tests pass false: the server already serves
   * /auth/callback on its own (ephemeral) port, so SSO never holds a
   * second fixed port and parallel test processes cannot EADDRINUSE.
   */
  ssoCallbackListener?: boolean | undefined;
  /**
   * Gateway child slug. Production children receive this from
   * `TDEI_GATEWAY_SLUG`. Tests pass it directly.
   */
  gatewaySlug?: string | undefined;
}

export interface HttpServeOverrides {
  port?: number;
  host?: string;
}

interface ResolvedHttpOptions {
  fetchImpl: typeof fetch | undefined;
  places: PlaceResolver;
  tokenValidationCache: Map<string, number>;
  requireBearerAuth: boolean;
  ssoCallbackListener: boolean;
  gatewaySlug: string | undefined;
  sessionAuth: AuthManager;
  sessionOpenApiClient: OpenApiClientLike;
  serverInstructions: string;
  serverProfile: TdeiServerProfile;
}

function buildLoginUrl(): string {
  const loginUrl = new URL("/api/v1/sso-redirect", `${getConfig().authApiUrl}/`);
  loginUrl.searchParams.set("redirect_uri", getConfig().ssoCallbackUrl);
  loginUrl.searchParams.set("client_id", TDEI_SSO_CLIENT_ID);
  return loginUrl.toString();
}

function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    // Responses can carry user data or auth challenges; never let a cache keep them.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function unauthorized(response: ServerResponse, code: string, message: string, extra?: Record<string, unknown>): void {
  const loginUrl = buildLoginUrl();
  const oauthError = code === "TDEI_SSO_REQUIRED" ? "invalid_request" : "invalid_token";
  const safeDesc = message.replace(/"/g, "'");
  const wwwAuthenticate = `Bearer realm="tdei-mcp", error="${oauthError}", error_description="${safeDesc}", authorization_uri="${loginUrl}"`;
  sendJson(
    response,
    401,
    {
      code,
      message,
      loginUrl,
      ...extra,
    },
    { "WWW-Authenticate": wwwAuthenticate },
  );
}

function checkCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (getConfig().corsOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    response.setHeader("Vary", "Origin");
    return true;
  }
  return false;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Public origin clients should use for this server (status page, setup
 * catalogue, installer scripts). The container usually receives plain HTTP
 * from a TLS-terminating proxy (e.g. Azure Container Apps), so the scheme
 * cannot be assumed. Precedence:
 *   1. `TDEI_PUBLIC_BASE_URL` env override (canonical public origin).
 *   2. `X-Forwarded-Proto` request header set by the proxy.
 *   3. Plain `http://` (direct local requests).
 */
export function resolvePublicBaseUrl(input: {
  hostHeader?: string | undefined;
  forwardedProto?: string | string[] | undefined;
  envOverride?: string | undefined;
  fallbackHost: string;
}): string {
  const override = (input.envOverride ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(override)) return override;
  const rawProto = Array.isArray(input.forwardedProto) ? (input.forwardedProto[0] ?? "") : (input.forwardedProto ?? "");
  const proto = rawProto.split(",")[0]?.trim().toLowerCase();
  const scheme = proto === "https" || proto === "http" ? proto : "http";
  const host = (input.hostHeader ?? "").trim() || input.fallbackHost;
  return `${scheme}://${host}`;
}

function toWebRequest(request: IncomingMessage, bodyText: string, host: string): Request {
  const url = new URL(request.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  return new Request(url, {
    method: request.method ?? "GET",
    headers,
    ...(request.method === "GET" || request.method === "HEAD" || request.method === "DELETE" ? {} : { body: bodyText }),
  });
}

async function sendWebResponse(nodeResponse: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // Tool results carry user data. The transport's own "no-cache" still lets a
  // shared cache store the body; force no-store (no-transform keeps streams intact).
  headers["cache-control"] = "no-store, no-transform";
  headers["x-content-type-options"] = "nosniff";
  nodeResponse.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- chunks must be written in order with backpressure; reading them in parallel is not possible
      const { done, value } = await reader.read();
      if (done) break;
      nodeResponse.write(value);
    }
    nodeResponse.end();
  } finally {
    reader.releaseLock();
  }
}

function sendOAuth(response: ServerResponse, result: OAuthHttpResult): void {
  response.writeHead(result.status, {
    ...result.headers,
    "Content-Length": Buffer.byteLength(result.body),
  });
  response.end(result.body);
}

/**
 * Tools that never trigger an OAuth/Bearer challenge. They bootstrap or
 * report auth state (login, status, health) or load local specs, so the
 * client can discover tools and sign in without already holding a token.
 * Every other `tools/call` requires auth and gets a 401 challenge when
 * signed out — handshake methods (`initialize`, `tools/list`, notifications,
 * GET/DELETE) never do, so merely adding the MCP never pops a login.
 */
export const AUTH_FREE_TOOL_NAMES = new Set([
  "tdei_sso_login",
  "tdei_sso_complete",
  "tdei_auth_status",
  "tdei_health",
  "tdei_test_authentication",
  "tdei_logout",
  "tdei_load_api_tools",
  "tdei_reload_config",
]);

function isProtectedToolCallEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  if (record.method !== "tools/call") return false;
  const params = record.params as Record<string, unknown> | undefined;
  const name = params?.name;
  if (typeof name === "string" && AUTH_FREE_TOOL_NAMES.has(name)) return false;
  return true;
}

/**
 * True only when the MCP payload contains at least one protected
 * `tools/call` (any real tool execution outside the auth-bootstrap allowlist).
 * All other traffic — initialize, tools/list, notifications, GET/DELETE —
 * must not authenticate, so clients can set up silently and only sign in
 * when a tool is actually invoked.
 */
export function mcpRequestNeedsAuth(parsed: unknown): boolean {
  if (parsed === undefined || parsed === null) return false;
  if (Array.isArray(parsed)) return parsed.some(isProtectedToolCallEntry);
  return isProtectedToolCallEntry(parsed);
}

function sendGatewayChallenge(
  response: ServerResponse,
  publicBaseUrl: string,
  gatewaySlug: string,
  mcpPath: string,
): void {
  sendJson(
    response,
    401,
    {
      code: "TDEI_SSO_REQUIRED",
      message:
        "TDEI sign-in is required. Reconnect this MCP server and approve the browser login. The client then sends the access token on every tool call.",
    },
    {
      "WWW-Authenticate": oauthChallengeHeader(oauthEndpoints(publicBaseUrl, gatewaySlug, mcpPath)),
      "Cache-Control": "no-store",
    },
  );
}

/**
 * A multi-user server builds a fresh MCP server per request, so the OpenAPI
 * tools are registered on each one from the shared, cached client. The caller's
 * own token is bound per call through `requestBearer`. Core registers the raw
 * operations its semantic tools do not cover (for example the portal_* ones);
 * workspace registers all of its operations. A spec that cannot be loaded leaves
 * the server with the tools it already has instead of failing the request.
 */
async function attachOpenApiTools(server: McpServer, options: ResolvedHttpOptions): Promise<void> {
  const register = options.serverProfile === "workspace" ? registerTdeiWorkspaceOpenApiTools : registerTdeiOpenApiTools;
  try {
    await register(server, options.sessionOpenApiClient, loadConfigFile().filter);
  } catch (error) {
    console.error(
      `[openapi-tools] could not register ${options.serverProfile} OpenAPI tools: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolvedHttpOptions,
  host: string,
  publicBaseUrl: string,
  mcpPath: string,
  /**
   * True only for a direct loopback caller on a non-gateway server. Otherwise no
   * process-wide login is read, written or handed out: the request must carry
   * its own bearer token.
   */
  sharedSession: boolean,
): Promise<void> {
  if (!checkCors(request, response)) {
    sendJson(response, 403, { code: "TDEI_ORIGIN_FORBIDDEN", message: "Origin not allowed." });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": request.headers.origin ?? "",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
      Vary: "Origin",
    });
    response.end();
    return;
  }

  const authHeader = (request.headers.authorization ?? "").trim();

  // Lazy auth: read + parse the JSON-RPC payload first so handshake traffic
  // (initialize, tools/list, notifications, GET/DELETE) never authenticates.
  // Only a protected tools/call (any tool outside AUTH_FREE_TOOL_NAMES)
  // triggers bearer validation or a 401 OAuth/Bearer challenge.
  const bodyText =
    request.method === "GET" || request.method === "HEAD" || request.method === "DELETE" ? "" : await readBody(request);
  let parsed: unknown;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      sendJson(response, 400, { code: "TDEI_BAD_REQUEST", message: "Request body must be JSON." });
      return;
    }
  }
  const needsAuth = mcpRequestNeedsAuth(parsed);

  let server;
  let callerBearer: string | undefined;
  if (!needsAuth && !sharedSession) {
    // Handshake on a multi-user server: list tools, but attach no login. Tool
    // calls arrive with their own bearer token and are handled below.
    server = createHttpSemanticServer({
      apiUrl: getConfig().apiUrl,
      userApiUrl: options.serverProfile === "core" ? getConfig().userApiUrl : undefined,
      instructions: options.serverInstructions,
      profile: options.serverProfile,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      places: options.places,
      ssoCallbackListener: false,
      ...(options.gatewaySlug ? { gatewaySlug: options.gatewaySlug } : {}),
    });
  } else if (!needsAuth) {
    server = await createReadyHttpSemanticServer({
      authManager: options.sessionAuth,
      openApiMcpClient: options.sessionOpenApiClient,
      apiUrl: getConfig().apiUrl,
      userApiUrl: options.serverProfile === "core" ? getConfig().userApiUrl : undefined,
      instructions: options.serverInstructions,
      profile: options.serverProfile,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      places: options.places,
      publicBaseUrl,
      ssoCallbackListener: options.ssoCallbackListener,
      ...(options.gatewaySlug ? { gatewaySlug: options.gatewaySlug } : {}),
    });
  } else if (authHeader.length > 0) {
    const match = /^Bearer (.+)$/.exec(authHeader);
    if (!match || !match[1]?.trim()) {
      unauthorized(response, "TDEI_SSO_REQUIRED", `TDEI SSO login is required. ${signInText()}`, { retryable: false });
      return;
    }
    const bearer = match[1].trim();
    callerBearer = bearer;

    const ephemeralAuth = injectAccessToken(bearer);
    try {
      await ephemeralAuth.validateToken({
        fetchImpl: options.fetchImpl,
        cache: options.tokenValidationCache,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "TDEI_UPSTREAM_UNAVAILABLE") {
        sendJson(
          response,
          503,
          {
            code: "TDEI_UPSTREAM_UNAVAILABLE",
            message: "The TDEI API could not confirm this token right now. Retry shortly.",
            retryable: true,
          },
          { "Retry-After": "5" },
        );
        return;
      }
      if (message === "TDEI_TOKEN_EXPIRED") {
        unauthorized(response, message, `TDEI access token expired. ${tokenExpiredText()}`, {
          refresh_hint: true,
          retryable: true,
        });
      } else {
        unauthorized(response, "TDEI_TOKEN_INVALID", `TDEI access token is invalid. ${signInText()}`, {
          refresh_hint: true,
          retryable: false,
        });
      }
      return;
    }

    server = createHttpSemanticServer({
      accessToken: bearer,
      apiUrl: getConfig().apiUrl,
      userApiUrl: options.serverProfile === "core" ? getConfig().userApiUrl : undefined,
      instructions: options.serverInstructions,
      profile: options.serverProfile,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      places: options.places,
      ssoCallbackListener: options.ssoCallbackListener,
      ...(options.gatewaySlug ? { gatewaySlug: options.gatewaySlug } : {}),
    });
  } else if (!sharedSession && !options.gatewaySlug) {
    // Multi-user server, no gateway: a tool call without a token is never served.
    unauthorized(response, "TDEI_SSO_REQUIRED", `TDEI SSO login is required. ${signInText()}`, { retryable: false });
    return;
  } else if (options.gatewaySlug && (!sharedSession || !options.sessionAuth.getStatus().authenticated)) {
    sendGatewayChallenge(response, publicBaseUrl, options.gatewaySlug, mcpPath);
    return;
  } else if (options.requireBearerAuth) {
    unauthorized(response, "TDEI_SSO_REQUIRED", `TDEI SSO login is required. ${signInText()}`, { retryable: false });
    return;
  } else {
    server = await createReadyHttpSemanticServer({
      authManager: options.sessionAuth,
      openApiMcpClient: options.sessionOpenApiClient,
      apiUrl: getConfig().apiUrl,
      userApiUrl: options.serverProfile === "core" ? getConfig().userApiUrl : undefined,
      instructions: options.serverInstructions,
      profile: options.serverProfile,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      places: options.places,
      publicBaseUrl,
      ssoCallbackListener: options.ssoCallbackListener,
      ...(options.gatewaySlug ? { gatewaySlug: options.gatewaySlug } : {}),
    });
  }

  // Multi-user requests (handshake or bearer) get the OpenAPI tools; the
  // single-user paths register their own through the OpenAPI lifecycle.
  if (!sharedSession) await attachOpenApiTools(server, options);

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    const handle = () =>
      transport.handleRequest(
        toWebRequest(request, bodyText, host),
        parsed === undefined ? undefined : { parsedBody: parsed },
      );
    const webResponse = await (callerBearer === undefined ? handle() : requestBearer.run(callerBearer, handle));
    await sendWebResponse(response, webResponse);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export async function serveHttp(
  options: HttpServeOptions = {},
  overrides: HttpServeOverrides = {},
): Promise<{ close(): Promise<void>; url: string }> {
  let httpConfig;
  try {
    httpConfig = getConfig();
  } catch (error) {
    console.error(
      JSON.stringify({
        code: "TDEI_CONFIG_INVALID",
        errors:
          error instanceof TdeiConfigError ? error.errors : [{ var: "unknown", rule: String(error), example: "" }],
      }),
    );
    process.exit(1);
  }
  const gatewaySlug = options.gatewaySlug?.trim() || process.env.TDEI_GATEWAY_SLUG?.trim() || undefined;
  setSignInMode(gatewaySlug ? "gateway" : options.requireBearerAuth ? "bearer" : "tool");
  const serverProfile = resolveTdeiServerProfile({
    name: process.env.TDEI_MCP_NAME || gatewaySlug,
    explicit: process.env.TDEI_MCP_PROFILE,
    apiUrl: httpConfig.apiUrl,
  });
  const serverEnvironment = resolveTdeiEnvironment({
    ...process.env,
    TDEI_MCP_NAME: process.env.TDEI_MCP_NAME || gatewaySlug,
    TDEI_API_URL: httpConfig.apiUrl,
  });
  const mcpName = clientMcpName(process.env.TDEI_MCP_NAME?.trim() || gatewaySlug);
  const sessionAuth = new AuthManager();
  const sessionOpenApiClient = createOpenApiClient({
    config: httpConfig,
    profile: serverProfile,
    headersProvider: async () => ({
      // A multi-user request carries its own validated token; only the
      // single-user path falls back to the process login.
      Authorization: `Bearer ${requestBearer.getStore() ?? (await sessionAuth.getAccessToken())}`,
    }),
    fetchImpl: options.fetchImpl,
    loadSpec: options.loadOpenApiSpec,
  });
  const resolved: ResolvedHttpOptions = {
    fetchImpl: options.fetchImpl,
    places: createConfiguredPlaceResolver(httpConfig, options.fetchImpl),
    tokenValidationCache: new Map<string, number>(),
    requireBearerAuth: options.requireBearerAuth ?? false,
    ssoCallbackListener: gatewaySlug ? false : (options.ssoCallbackListener ?? true),
    gatewaySlug,
    sessionAuth,
    sessionOpenApiClient,
    serverInstructions: gatewaySlug
      ? withGatewaySignIn(tdeiServerInstructions(serverProfile, serverEnvironment))
      : tdeiServerInstructions(serverProfile, serverEnvironment),
    serverProfile,
  };
  const host = overrides.host ?? httpConfig.httpHost;
  const port = overrides.port ?? httpConfig.httpPort;
  const basePath = httpConfig.httpBasePath;
  const callbackPort = gatewaySlug
    ? Number(new URL(REGISTERED_SSO_REDIRECT_URI).port)
    : Number(new URL(httpConfig.ssoCallbackUrl).port) || 8765;

  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const reqHost = request.headers.host ?? `${host}:${port}`;
        const publicBaseUrl = resolvePublicBaseUrl({
          hostHeader: reqHost,
          forwardedProto: request.headers["x-forwarded-proto"],
          envOverride: process.env.TDEI_PUBLIC_BASE_URL,
          fallbackHost: `${host}:${port}`,
        });
        const url = new URL(request.url ?? "/", publicBaseUrl);
        const sharedSession = sharedSessionAllowed({
          gatewaySlug,
          remoteAddress: request.socket.remoteAddress,
          headers: request.headers,
        });
        if (publicBaseUrl.startsWith("https://")) {
          response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        }
        // A proxy that says the client used plain HTTP means credentials would
        // cross the network unencrypted. Refuse any request that can carry them:
        // an Authorization header, a write method, or the OAuth and callback
        // paths. Token-free pages (status, health, setup scripts) stay open.
        const clientProto = String(request.headers["x-forwarded-proto"] ?? "")
          .split(",")[0]
          ?.trim()
          .toLowerCase();
        const carriesCredentials =
          request.headers.authorization !== undefined ||
          (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") ||
          url.pathname.includes("/oauth/") ||
          isAuthCallbackPath(url.pathname, gatewaySlug);
        const isStatusRequest = !carriesCredentials;
        if (!sharedSession && clientProto === "http" && !isStatusRequest) {
          sendJson(response, 400, {
            code: "TDEI_HTTPS_REQUIRED",
            message: "Use https. Access tokens must not be sent over plain HTTP.",
          });
          return;
        }

        if (request.method === "GET" && url.pathname === "/") {
          const html = renderStatusPage(publicBaseUrl, basePath, mcpName, serverProfile);
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          response.end(html);
          return;
        }

        if (request.method === "GET" && url.pathname === "/health") {
          try {
            const report = await checkHealth(
              { auth: sessionAuth, openapi: sessionOpenApiClient },
              options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
            );
            sendJson(
              response,
              200,
              { ...report, build: { version: BUILD.version, sha: BUILD.sha } },
              { "Cache-Control": "no-store" },
            );
          } catch (error) {
            sendJson(response, 500, {
              code: "TDEI_HEALTH_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }

        if (request.method === "GET" && (url.pathname === `${basePath}/setup` || url.pathname === "/setup")) {
          const text = renderSetupOverview(publicBaseUrl, basePath, mcpName, serverProfile);
          response.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(text);
          return;
        }

        const setupMatch = url.pathname.startsWith(`${basePath}/setup/`)
          ? url.pathname.slice(`${basePath}/setup/`.length)
          : url.pathname.startsWith("/setup/")
            ? url.pathname.slice("/setup/".length)
            : undefined;
        if (request.method === "GET" && setupMatch !== undefined) {
          const rawClient = setupMatch.replace(/\/+$/, "").toLowerCase();
          const wantsPowershell = rawClient.endsWith(".ps1");
          const slug = wantsPowershell ? rawClient.slice(0, -".ps1".length) : rawClient;
          const parts = slug.split("/").filter((part) => part.length > 0);
          let action: SetupScriptAction = "install";
          let clientSlug: string | undefined;
          if (parts.length === 1) {
            clientSlug = parts[0];
          } else if (parts.length === 2 && parts[0] !== undefined && isSetupScriptAction(parts[0])) {
            action = parts[0];
            clientSlug = parts[1];
          }
          const client =
            clientSlug === "all" && action === "cleanup"
              ? ("all" as const)
              : clientSlug !== undefined
                ? normalizeSetupClientTarget(clientSlug)
                : undefined;
          if (!client) {
            sendJson(response, 404, {
              code: "TDEI_SETUP_CLIENT_UNKNOWN",
              message: `Unknown setup client "${rawClient}". Supported clients: codex, opencode, claude-cli, claude-desktop, vscode, cursor (append .ps1 for the Windows PowerShell installer). Prefix with update/ to reinstall, uninstall/ to remove the ${mcpName} entry, or cleanup/ to remove every tdei / tdei-* entry (cleanup/all covers every client), e.g. update/codex.`,
            });
            return;
          }
          // ?with=<name>[,<name>] adds more entries on this gateway (the combined core + workspace install).
          const withNames = (url.searchParams.get("with") ?? "").split(",");
          const script = wantsPowershell
            ? renderClientSetupPowershell(
                client,
                publicBaseUrl,
                callbackPort,
                action,
                basePath,
                mcpName,
                serverProfile,
                withNames,
              )
            : renderClientSetupScript(
                client,
                publicBaseUrl,
                callbackPort,
                action,
                basePath,
                mcpName,
                serverProfile,
                withNames,
              );
          response.writeHead(200, {
            "Content-Type": wantsPowershell ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(script);
          return;
        }

        if (gatewaySlug && matchesOAuthPath(url.pathname, oauthEndpoints(publicBaseUrl, gatewaySlug, basePath))) {
          const body = request.method === "POST" ? await readBody(request) : "";
          const result = await dispatchOAuth({
            method: request.method ?? "GET",
            url,
            origin: publicBaseUrl,
            slug: gatewaySlug,
            mcpPath: basePath,
            apiUrl: httpConfig.authApiUrl,
            cookieHeader: request.headers.cookie,
            body,
            exchangeCode: async (code, state) => {
              const tokens = await sessionAuth.exchangeSsoCode(code, state);
              // Only a single-user server keeps the login for reuse. A shared
              // server hands the tokens to the caller who logged in and keeps nothing.
              if (sharedSession) saveSharedSession(httpConfig.authApiUrl, tokens, expiresAtForTokens(tokens));
              return tokens;
            },
            refreshToken: (refreshToken) => sessionAuth.refreshExternalToken(refreshToken),
            // Validity-first: reuse this auth server's validated login
            // (own session or a sibling MCP's shared session) instead of
            // forcing another explicit browser SSO roundtrip per MCP.
            getValidSessionTokens: async () => {
              // Never answer one person's login with another person's session.
              if (!sharedSession) return undefined;
              try {
                await sessionAuth.getAccessToken();
              } catch {
                const restored = await sessionAuth.restoreSharedSession(options.fetchImpl).catch(() => false);
                if (!restored) return undefined;
              }
              try {
                await sessionAuth.validateToken({
                  ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                  cache: resolved.tokenValidationCache,
                });
              } catch {
                return undefined;
              }
              return sessionAuth.exportSessionTokens();
            },
          });
          if (result) {
            sendOAuth(response, result);
            return;
          }
        }

        if (request.method === "GET" && isAuthCallbackPath(url.pathname, resolved.gatewaySlug)) {
          if (gatewaySlug) {
            const oauthResult = await oauthCallbackResult({
              url,
              origin: publicBaseUrl,
              slug: gatewaySlug,
              apiUrl: httpConfig.authApiUrl,
              cookieHeader: request.headers.cookie,
              exchangeCode: async (code, state) => {
                const tokens = await sessionAuth.exchangeSsoCode(code, state);
                if (sharedSession) saveSharedSession(httpConfig.authApiUrl, tokens, expiresAtForTokens(tokens));
                return tokens;
              },
            });
            if (oauthResult) {
              sendOAuth(response, oauthResult);
              return;
            }
          }
          const secFetchSite = request.headers["sec-fetch-site"];
          const secFetchMode = request.headers["sec-fetch-mode"];
          if (secFetchSite === "cross-site" && secFetchMode && secFetchMode !== "navigate") {
            response.writeHead(403, {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end("Forbidden cross-site callback request");
            return;
          }
          const authState = sessionAuth.getStatus().state;
          const loginReturn =
            url.searchParams.has("code") || (url.searchParams.has("error") && authState === "login_pending");
          // 404 means "not this child". The gateway retries the other
          // children. A real exchange failure stays 401 so nginx stops.
          if (loginReturn && authState !== "login_pending") {
            // A callback that came through the loopback relay carries the
            // relay's try marker. Bounce it back so the relay can offer the
            // callback to the next installed gateway instead of dead-ending
            // here. The response stays 404 so nginx can try sibling
            // connectors first; only the last child's page reaches the user.
            let body = renderSsoFailurePage("expired");
            if (url.searchParams.has(RELAY_TRY_PARAM)) {
              const next = new URL(REGISTERED_SSO_REDIRECT_URI);
              next.search = url.search;
              body = renderSsoRelayRetryPage(next.toString());
            }
            response.writeHead(404, {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end(body);
            return;
          }
          if (!loginReturn && authState !== "logout_pending") {
            response.writeHead(404, {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end(
              renderSsoErrorPage(
                "No sign-out in progress",
                "This server has no TDEI logout waiting for that callback.",
              ),
            );
            return;
          }
          try {
            const expectedCallback = new URL(getConfig().ssoCallbackUrl);
            expectedCallback.search = url.search;
            const loggingOut = !loginReturn;
            if (loggingOut) {
              sessionAuth.completeSsoLogout(expectedCallback.toString());
            } else {
              await sessionAuth.completeSsoLogin(expectedCallback.toString());
              void sessionOpenApiClient.listTools().catch(() => undefined);
            }
            response.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end(renderSsoResultPage(loggingOut ? "logout" : "login"));
          } catch {
            response.writeHead(401, {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end(renderSsoFailurePage("failed"));
          }
          return;
        }

        if (url.pathname !== basePath) {
          sendJson(response, 404, { code: "TDEI_NOT_FOUND", message: `Unknown path ${url.pathname}.` });
          return;
        }
        if (
          request.method !== "POST" &&
          request.method !== "GET" &&
          request.method !== "DELETE" &&
          request.method !== "OPTIONS"
        ) {
          sendJson(response, 405, {
            code: "TDEI_METHOD_NOT_ALLOWED",
            message: "Use POST for JSON-RPC, GET for SSE, or DELETE.",
          });
          return;
        }
        await handleMcpRequest(request, response, resolved, host, publicBaseUrl, basePath, sharedSession);
      } catch (error) {
        console.error("[http] request failed:", error instanceof Error ? error.message : String(error));
        if (!response.headersSent) {
          sendJson(response, 500, { code: "TDEI_INTERNAL", message: "MCP request failed." });
        } else {
          response.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(port, host);
  });

  console.error(`[tdei-mcp] Serving MCP (http) on ${host}:${port}${basePath}`);
  if (gatewaySlug && !oauthSecretIsConfigured()) {
    console.error(
      "[tdei-mcp] TDEI_OAUTH_SECRET is not set: using a random per-process secret for sign-in codes and cookies. Set the same TDEI_OAUTH_SECRET on every replica so a sign-in can finish on any of them.",
    );
  }
  console.error(
    "[tdei-mcp] Shared login: only for direct loopback callers on a non-gateway server; every other caller must send its own bearer token.",
  );

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  // Pick up API changes without a restart. Each request re-registers tools from
  // this client, so a refreshed spec reaches clients on their next connection.
  const refreshMinutes = Number(process.env.TDEI_SPEC_REFRESH_MINUTES ?? 15);
  const specRefreshTimer =
    Number.isFinite(refreshMinutes) && refreshMinutes > 0
      ? setInterval(() => {
          sessionOpenApiClient.refresh().catch((error: unknown) => {
            console.error("[openapi] spec refresh failed:", error instanceof Error ? error.message : String(error));
          });
        }, refreshMinutes * 60_000)
      : undefined;
  specRefreshTimer?.unref();
  const close = async (): Promise<void> => {
    if (specRefreshTimer) clearInterval(specRefreshTimer);
    await sessionOpenApiClient.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return { close, url: `http://${host}:${actualPort}` };
}
