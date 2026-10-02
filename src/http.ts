import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { getConfig, TdeiConfigError } from "./config.js";
import { injectAccessToken } from "./auth/auth-manager.js";
import { createHttpSemanticServer } from "./http-semantic-server.js";
import { createConfiguredPlaceResolver } from "./adapters/configured-place-resolver.js";
import type { PlaceResolver } from "./intents/place-resolver.js";

export interface HttpServeOptions {
  fetchImpl?: typeof fetch;
}

export interface HttpServeOverrides {
  port?: number;
  host?: string;
}

interface ResolvedHttpOptions {
  fetchImpl: typeof fetch | undefined;
  places: PlaceResolver;
}

function buildLoginUrl(): string {
  const loginUrl = new URL("/api/v1/sso-redirect", `${getConfig().apiUrl}/`);
  loginUrl.searchParams.set("redirect_uri", getConfig().ssoCallbackUrl);
  loginUrl.searchParams.set("client_id", getConfig().ssoClientId);
  return loginUrl.toString();
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function unauthorized(response: ServerResponse, code: string, message: string, extra?: Record<string, unknown>): void {
  sendJson(response, 401, {
    code,
    message,
    loginUrl: buildLoginUrl(),
    ...extra,
  });
}

function checkCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (getConfig().corsOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
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
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: bodyText }),
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

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolvedHttpOptions,
  host: string,
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
    });
    response.end();
    return;
  }

  const authHeader = request.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(authHeader.trim());
  if (!match) {
    unauthorized(response, "TDEI_SSO_REQUIRED", "TDEI SSO login is required. Call tdei_sso_login and open the returned URL.", { retryable: false });
    return;
  }
  const bearer = match[1].trim();

  const ephemeralAuth = injectAccessToken(bearer);
  // fetchImpl is test-only injection: when provided, swap it in for the
  // single validateToken() probe, then restore. Otherwise validateToken()
  // uses the ambient global fetch (which tests mock directly).
  const originalFetch = globalThis.fetch;
  if (options.fetchImpl) globalThis.fetch = options.fetchImpl;
  try {
    await ephemeralAuth.validateToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "TDEI_TOKEN_EXPIRED") {
      unauthorized(response, message, "TDEI access token expired. Refresh via POST /api/v1/refresh-token or call tdei_sso_login.", { refresh_hint: true, retryable: true });
    } else {
      unauthorized(response, "TDEI_TOKEN_INVALID", "TDEI access token is invalid. Call tdei_sso_login and open the returned URL.", { refresh_hint: true, retryable: false });
    }
    return;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const server = createHttpSemanticServer({
    accessToken: bearer,
    apiUrl: getConfig().apiUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    places: options.places,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    const bodyText = request.method === "GET" || request.method === "HEAD" ? "" : await readBody(request);
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
    console.error(JSON.stringify({
      code: "TDEI_CONFIG_INVALID",
      errors: error instanceof TdeiConfigError ? error.errors : [{ var: "unknown", rule: String(error), example: "" }],
    }));
    process.exit(1);
  }
  const resolved: ResolvedHttpOptions = {
    fetchImpl: options.fetchImpl,
    places: createConfiguredPlaceResolver(httpConfig, options.fetchImpl),
  };
  const host = overrides.host ?? httpConfig.httpHost;
  const port = overrides.port ?? httpConfig.httpPort;
  const basePath = httpConfig.httpBasePath;
  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
        if (url.pathname !== basePath) {
          sendJson(response, 404, { code: "TDEI_NOT_FOUND", message: `Unknown path ${url.pathname}.` });
          return;
        }
        if (request.method !== "POST" && request.method !== "GET" && request.method !== "OPTIONS") {
          sendJson(response, 405, { code: "TDEI_METHOD_NOT_ALLOWED", message: "Use POST for JSON-RPC or GET for SSE." });
          return;
        }
        await handleMcpRequest(request, response, resolved, host);
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return { close, url: `http://${host}:${actualPort}` };
}
