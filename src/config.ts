const DEFAULT_API_URL = "https://api-dev.tdei.us";

const DEFAULT_SPEC_URL =
  "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json";

const DEFAULT_AWS_MCP_PACKAGE =
  "awslabs.openapi-mcp-server@1.1.2";

const DEFAULT_SSO_CALLBACK_URL = "http://127.0.0.1:8765/callback";

function readHttpsUrl(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }

  return url.toString().replace(/\/+$/, "");
}

export type Transport = "stdio" | "http";

export function resolveTransport(): Transport {
  const raw = process.env.TDEI_TRANSPORT?.trim().toLowerCase();
  if (raw === "http") return "http";
  if (!raw || raw === "stdio") return "stdio";
  throw new Error('TDEI_TRANSPORT must be "stdio" or "http"');
}

export function validateSsoCallbackUrl(value: string, transport: Transport): string {
  const url = new URL(value);
  const isLoopback =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Boolean(url.port) &&
    url.pathname === "/callback";
  if (transport === "stdio") {
    if (!isLoopback) {
      throw new Error("TDEI_SSO_CALLBACK_URL must use http://127.0.0.1:<port>/callback");
    }
    return url.toString();
  }
  const isHttps = url.protocol === "https:";
  if (!isHttps && !isLoopback) {
    throw new Error("TDEI_SSO_CALLBACK_URL must use https:// in http mode (http://127.0.0.1:<port>/callback allowed for local dev)");
  }
  return url.toString();
}

function readHttpPort(): number {
  const raw = process.env.TDEI_HTTP_PORT?.trim() || "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TDEI_HTTP_PORT must be an integer 1-65535");
  }
  return port;
}

function readBasePath(): string {
  const raw = process.env.TDEI_HTTP_BASE_PATH?.trim() || "/mcp";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.replace(/\/+$/, "") || "/";
}

const transport = resolveTransport();

export const config = {
  apiUrl: readHttpsUrl(
    "TDEI_API_URL",
    DEFAULT_API_URL,
  ),

  specUrl: readHttpsUrl(
    "TDEI_SPEC_URL",
    DEFAULT_SPEC_URL,
  ),

  ssoClientId: process.env.TDEI_SSO_CLIENT_ID?.trim() || "tdei-mcp",

  ssoCallbackUrl: validateSsoCallbackUrl(
    process.env.TDEI_SSO_CALLBACK_URL?.trim() || DEFAULT_SSO_CALLBACK_URL,
    transport,
  ),

  transport,

  httpHost: process.env.TDEI_HTTP_HOST?.trim() || "127.0.0.1",

  httpPort: readHttpPort(),

  httpBasePath: readBasePath(),

  corsOrigins: (process.env.TDEI_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),

  tlsCert: process.env.TDEI_TLS_CERT?.trim() || undefined,

  tlsKey: process.env.TDEI_TLS_KEY?.trim() || undefined,

  awsMcpPackage:
    process.env.TDEI_AWS_MCP_PACKAGE?.trim() ||
    DEFAULT_AWS_MCP_PACKAGE,
};
