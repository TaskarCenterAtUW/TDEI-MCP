import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { getConfig, TdeiConfigError, TDEI_SSO_CLIENT_ID } from "./config.js";
import { AuthManager, injectAccessToken, sanitizeAuthErrorDetail } from "./auth/auth-manager.js";
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
import {
  dispatchOAuth,
  matchesOAuthPath,
  oauthCallbackResult,
  oauthChallengeHeader,
  oauthEndpoints,
  type OAuthHttpResult,
} from "./oauth/mcp-oauth.js";
import { createConfiguredPlaceResolver } from "./adapters/configured-place-resolver.js";
import { BUILD } from "./build-info.js";
import { setSignInMode, signInText, tokenExpiredText } from "./mcp/errors.js";
import type { PlaceResolver } from "./intents/place-resolver.js";
import { OpenApiMcpClient } from "./openapi/openapi-mcp-client.js";

export interface HttpServeOptions {
  fetchImpl?: typeof fetch;
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
  sessionOpenApiClient: OpenApiMcpClient;
}

function buildLoginUrl(): string {
  const loginUrl = new URL("/api/v1/sso-redirect", `${getConfig().apiUrl}/`);
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
  nodeResponse.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    for (;;) {
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

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolvedHttpOptions,
  host: string,
  publicBaseUrl: string,
  mcpPath: string,
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
  let server;
  if (authHeader.length > 0) {
    const match = /^Bearer (.+)$/.exec(authHeader);
    if (!match || !match[1]?.trim()) {
      unauthorized(response, "TDEI_SSO_REQUIRED", `TDEI SSO login is required. ${signInText()}`, { retryable: false });
      return;
    }
    const bearer = match[1].trim();

    const ephemeralAuth = injectAccessToken(bearer);
    try {
      await ephemeralAuth.validateToken({
        fetchImpl: options.fetchImpl,
        cache: options.tokenValidationCache,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      places: options.places,
      ssoCallbackListener: options.ssoCallbackListener,
      ...(options.gatewaySlug ? { gatewaySlug: options.gatewaySlug } : {}),
    });
  } else if (options.gatewaySlug && !options.sessionAuth.getStatus().authenticated) {
    const endpoints = oauthEndpoints(publicBaseUrl, options.gatewaySlug, mcpPath);
    sendJson(
      response,
      401,
      {
        code: "TDEI_SSO_REQUIRED",
        message:
          "TDEI sign-in is required. Reconnect this MCP server and approve the browser login. The client then sends the access token on every tool call.",
      },
      {
        "WWW-Authenticate": oauthChallengeHeader(endpoints),
        "Cache-Control": "no-store",
      },
    );
    return;
  } else if (options.requireBearerAuth) {
    unauthorized(response, "TDEI_SSO_REQUIRED", `TDEI SSO login is required. ${signInText()}`, { retryable: false });
    return;
  } else {
    server = await createReadyHttpSemanticServer({
      authManager: options.sessionAuth,
      openApiMcpClient: options.sessionOpenApiClient,
      apiUrl: getConfig().apiUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      places: options.places,
      publicBaseUrl,
      ssoCallbackListener: options.ssoCallbackListener,
      ...(options.gatewaySlug ? { gatewaySlug: options.gatewaySlug } : {}),
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    const bodyText =
      request.method === "GET" || request.method === "HEAD" || request.method === "DELETE"
        ? ""
        : await readBody(request);
    let parsed: unknown;
    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        sendJson(response, 400, { code: "TDEI_BAD_REQUEST", message: "Request body must be JSON." });
        return;
      }
    }
    const webResponse = await transport.handleRequest(
      toWebRequest(request, bodyText, host),
      parsed === undefined ? undefined : { parsedBody: parsed },
    );
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
  const mcpName = clientMcpName(process.env.TDEI_MCP_NAME?.trim() || gatewaySlug);
  const sessionAuth = new AuthManager();
  const sessionOpenApiClient = new OpenApiMcpClient({
    apiUrl: httpConfig.apiUrl,
    specUrl: httpConfig.specUrl,
    headersProvider: async () => ({
      Authorization: `Bearer ${await sessionAuth.getAccessToken()}`,
    }),
    allowLocalFileUploads: false,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
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

        if (request.method === "GET" && url.pathname === "/") {
          const html = renderStatusPage(publicBaseUrl, basePath, mcpName);
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
          const text = renderSetupOverview(publicBaseUrl, basePath, mcpName);
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
          const client = clientSlug !== undefined ? normalizeSetupClientTarget(clientSlug) : undefined;
          if (!client) {
            sendJson(response, 404, {
              code: "TDEI_SETUP_CLIENT_UNKNOWN",
              message: `Unknown setup client "${rawClient}". Supported clients: codex, opencode, claude-cli, claude-desktop, vscode, cursor (append .ps1 for the Windows PowerShell installer). Prefix with update/ to reinstall or uninstall/ to remove the ${mcpName} entry, e.g. update/codex.`,
            });
            return;
          }
          const script = wantsPowershell
            ? renderClientSetupPowershell(client, publicBaseUrl, callbackPort, action, basePath, mcpName)
            : renderClientSetupScript(client, publicBaseUrl, callbackPort, action, basePath, mcpName);
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
            apiUrl: httpConfig.apiUrl,
            cookieHeader: request.headers.cookie,
            body,
            exchangeCode: (code, state) => sessionAuth.exchangeSsoCode(code, state),
            refreshToken: (refreshToken) => sessionAuth.refreshExternalToken(refreshToken),
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
              apiUrl: httpConfig.apiUrl,
              cookieHeader: request.headers.cookie,
              exchangeCode: (code, state) => sessionAuth.exchangeSsoCode(code, state),
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
            response.writeHead(404, {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end("No TDEI SSO login is pending on this server");
            return;
          }
          if (!loginReturn && authState !== "logout_pending") {
            response.writeHead(404, {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end("No TDEI SSO logout is pending on this server");
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
            const title = loggingOut ? "TDEI logout complete" : "TDEI login complete";
            const heading = loggingOut ? "Logout complete" : "Login complete";
            response.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end(
              `<!doctype html><title>${title}</title><h1>${heading}</h1><p>You may close this window and return to your agent.</p>`,
            );
          } catch (error) {
            const detail = sanitizeAuthErrorDetail(error instanceof Error ? error.message : String(error));
            response.writeHead(401, {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            response.end(detail);
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
        await handleMcpRequest(request, response, resolved, host, publicBaseUrl, basePath);
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

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const close = async (): Promise<void> => {
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
