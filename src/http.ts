import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { config } from "./config.js";
import { injectAccessToken } from "./auth/auth-manager.js";
import { AwsMcpClient } from "./aws/aws-mcp-client.js";
import { createServer, type ServerDependencies } from "./index.js";

export interface HttpServeOptions {
  createAwsClient?: (token: string) => AwsMcpClient;
  fetchImpl?: typeof fetch;
}

export interface HttpServeOverrides {
  port?: number;
  host?: string;
}

interface ResolvedHttpOptions {
  createAwsClient: (token: string) => AwsMcpClient;
  fetchImpl?: typeof fetch;
}

function buildLoginUrl(): string {
  const loginUrl = new URL("/api/v1/sso-redirect", `${config.apiUrl}/`);
  loginUrl.searchParams.set("redirect_uri", config.ssoCallbackUrl);
  loginUrl.searchParams.set("client_id", config.ssoClientId);
  return loginUrl.toString();
}

function buildLogoutUrl(): string {
  const logoutUrl = new URL("/api/v1/sso-logout", `${config.apiUrl}/`);
  logoutUrl.searchParams.set("redirect_uri", config.ssoCallbackUrl);
  logoutUrl.searchParams.set("client_id", config.ssoClientId);
  return logoutUrl.toString();
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
  if (config.corsOrigins.includes(origin)) {
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
    body: request.method === "GET" || request.method === "HEAD" ? undefined : bodyText,
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
    unauthorized(response, "TDEI_SSO_REQUIRED", "TDEI SSO login is required. Call tdei_sso_login and open the returned URL.");
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
      unauthorized(response, message, "TDEI access token expired. Refresh via POST /api/v1/refresh-token or call tdei_sso_login.", { refresh_hint: true });
    } else {
      unauthorized(response, "TDEI_TOKEN_INVALID", "TDEI access token is invalid. Call tdei_sso_login and open the returned URL.", { refresh_hint: true });
    }
    return;
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Stateless adapters: same tool surface, but never open a loopback
  // listener in HTTP mode. getAccessToken() on the ephemeral manager returns
  // the injected Bearer while unexpired, else throws TDEI_SSO_REQUIRED (it
  // holds no refresh token, so it never refreshes — correct statelessly).
  const httpAuth: ServerDependencies["authManager"] = {
    getStatus: () => ephemeralAuth.getStatus(),
    getAccessToken: () => ephemeralAuth.getAccessToken(),
    startSsoLogin: async () => ({
      loginUrl: buildLoginUrl(),
      callbackUrl: config.ssoCallbackUrl,
      completion: Promise.resolve(),
    }),
    logout: async () => ({
      logoutUrl: buildLogoutUrl(),
      callbackUrl: config.ssoCallbackUrl,
      completion: Promise.resolve(),
    }),
  };
  const awsClient = options.createAwsClient(bearer);
  try {
    const server = await createServer({
      authManager: httpAuth,
      awsMcpClient: awsClient,
      registerAwsTools: (await import("./aws/register-aws-tools.js")).registerAwsTools,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
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
    }
    await server.close().catch(() => undefined);
  } finally {
    await awsClient.close().catch(() => undefined);
  }
}

export async function serveHttp(
  options: HttpServeOptions = {},
  overrides: HttpServeOverrides = {},
): Promise<{ close(): Promise<void>; url: string }> {
  const resolved: ResolvedHttpOptions = {
    createAwsClient: options.createAwsClient ?? ((token: string) => new AwsMcpClient(async () => token)),
    fetchImpl: options.fetchImpl,
  };
  const host = overrides.host ?? config.httpHost;
  const port = overrides.port ?? config.httpPort;
  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
        if (url.pathname !== config.httpBasePath) {
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

  console.error(`[tdei-mcp] Serving MCP (http) on ${host}:${port}${config.httpBasePath}`);

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
