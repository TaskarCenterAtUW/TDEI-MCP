import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  createOpenApiMcpServer,
  type OpenApiMcpServerOptions,
} from "./create-openapi-mcp-server.js";
import { loadOpenApiDocument } from "./openapi-mcp-client.js";

export interface OpenApiHttpOptions {
  host?: string;
  port?: number;
  basePath?: string;
  corsOrigins?: readonly string[];
  maxRequestBytes?: number;
  headersForRequest?: (request: Request) => Promise<HeadersInit>;
}

export class OpenApiAuthenticationError extends Error {
  constructor(message = "Authentication is required.") {
    super(message);
    this.name = "OpenApiAuthenticationError";
  }
}

export async function bearerHeadersForRequest(request: Request): Promise<HeadersInit> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new OpenApiAuthenticationError("A Bearer access token is required.");
  }
  return { Authorization: authorization };
}

export async function serveOpenApiStdio(
  options: OpenApiMcpServerOptions,
): Promise<void> {
  await serveStdio(async () => (await createOpenApiMcpServer(options)).server);
}

function normalizeBasePath(value: string | undefined): string {
  const path = value?.trim() || "/mcp";
  const leading = path.startsWith("/") ? path : `/${path}`;
  return leading.replace(/\/+$/, "") || "/";
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  response.setHeader("Vary", "Origin");
  return true;
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) throw new RangeError("MCP request body exceeds the configured limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toWebRequest(request: IncomingMessage, body: string, host: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(new URL(request.url ?? "/", `http://${host}`), {
    method: request.method ?? "GET",
    headers,
    ...(["GET", "HEAD", "DELETE"].includes(request.method ?? "GET") ? {} : { body }),
  });
}

async function sendWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => { headers[key] = value; });
  response.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

export async function serveOpenApiHttp(
  serverOptions: OpenApiMcpServerOptions,
  httpOptions: OpenApiHttpOptions = {},
): Promise<{ close(): Promise<void>; url: string }> {
  const host = httpOptions.host ?? "127.0.0.1";
  const port = httpOptions.port ?? 3000;
  const basePath = normalizeBasePath(httpOptions.basePath);
  const allowedOrigins = new Set(httpOptions.corsOrigins ?? []);
  const maximum = httpOptions.maxRequestBytes ?? 1024 * 1024;
  let documentPromise: Promise<Record<string, unknown>> | undefined;
  const loadSpec = async (): Promise<Record<string, unknown>> => {
    documentPromise ??= serverOptions.loadSpec
      ? serverOptions.loadSpec()
      : loadOpenApiDocument(serverOptions.specUrl!);
    return await documentPromise;
  };

  const nodeServer = createNodeServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
        if (url.pathname !== basePath) {
          sendJson(response, 404, { code: "MCP_NOT_FOUND", message: `Unknown path ${url.pathname}.` });
          return;
        }
        if (!applyCors(request, response, allowedOrigins)) {
          sendJson(response, 403, { code: "MCP_ORIGIN_FORBIDDEN", message: "Origin not allowed." });
          return;
        }
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "Access-Control-Allow-Origin": request.headers.origin ?? "",
            "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
            "Vary": "Origin",
          });
          response.end();
          return;
        }
        if (!request.method || !["GET", "POST", "DELETE"].includes(request.method)) {
          sendJson(response, 405, { code: "MCP_METHOD_NOT_ALLOWED", message: "Use POST, GET, or DELETE." });
          return;
        }

        const body = ["GET", "HEAD", "DELETE"].includes(request.method)
          ? ""
          : await readBody(request, maximum);
        const webRequest = toWebRequest(request, body, request.headers.host ?? host);
        let requestHeaders: HeadersInit | undefined;
        if (httpOptions.headersForRequest) {
          try {
            requestHeaders = await httpOptions.headersForRequest(webRequest);
          } catch (error) {
            if (error instanceof OpenApiAuthenticationError) {
              const safeDesc = error.message.replace(/"/g, "'");
              sendJson(
                response,
                401,
                { code: "MCP_UNAUTHORIZED", message: error.message },
                {
                  "WWW-Authenticate": `Bearer realm="openapi-mcp", error="invalid_token", error_description="${safeDesc}"`,
                },
              );
              return;
            }
            throw error;
          }
        }

        let parsedBody: unknown;
        if (body) {
          try {
            parsedBody = JSON.parse(body) as unknown;
          } catch {
            sendJson(response, 400, { code: "MCP_BAD_REQUEST", message: "Request body must be JSON." });
            return;
          }
        }
        const context = await createOpenApiMcpServer({
          ...serverOptions,
          loadSpec,
          ...(requestHeaders
            ? { headersProvider: async () => requestHeaders }
            : {}),
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        try {
          await context.server.connect(transport);
          const webResponse = await transport.handleRequest(
            webRequest,
            parsedBody === undefined ? undefined : { parsedBody },
          );
          await sendWebResponse(response, webResponse);
        } finally {
          await transport.close().catch(() => undefined);
          await context.server.close().catch(() => undefined);
          await context.provider.close().catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof RangeError) {
          sendJson(response, 413, { code: "MCP_REQUEST_TOO_LARGE", message: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          sendJson(response, 500, { code: "MCP_INTERNAL", message });
        } else {
          response.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    nodeServer.once("error", reject);
    nodeServer.once("listening", resolve);
    nodeServer.listen(port, host);
  });
  const address = nodeServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    close: async () => await new Promise<void>((resolve) => nodeServer.close(() => resolve())),
    url: `http://${host}:${actualPort}${basePath}`,
  };
}
