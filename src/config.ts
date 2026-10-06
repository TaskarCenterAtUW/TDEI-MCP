const DEFAULT_API_URL = "https://api-dev.tdei.us";

const DEFAULT_SPEC_URL =
  "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json";

const DEFAULT_AWS_MCP_PACKAGE =
  "awslabs.openapi-mcp-server@1.1.2";

const DEFAULT_SSO_CALLBACK_URL = "http://127.0.0.1:8765/callback";

/** Fixed OAuth client for this MCP connector. Not configurable — never use portal/web/API client ids. */
export const TDEI_SSO_CLIENT_ID = "tdei-mcp" as const;

export type Transport = "stdio" | "http";

export interface ConfigError {
  var: string;
  rule: string;
  example: string;
}

export interface ResolvedConfig {
  apiUrl: string;
  specUrl: string;
  ssoClientId: string;
  ssoCallbackUrl: string;
  transport: Transport;
  httpHost: string;
  httpPort: number;
  httpBasePath: string;
  corsOrigins: string[];
  tlsCert: string | undefined;
  tlsKey: string | undefined;
  awsMcpPackage: string;
  geocoderUrl: string | undefined;
  geocoderUserAgent: string;
}

export class TdeiConfigError extends Error {
  constructor(public readonly errors: ConfigError[]) {
    super(`TDEI_CONFIG_INVALID: ${errors.map((e) => `${e.var} (${e.rule})`).join("; ")}`);
    this.name = "TdeiConfigError";
  }
}

function readHttpsUrl(name: string, fallback: string, example: string): { value: string } | { error: ConfigError } {
  const value = process.env[name]?.trim() || fallback;

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return { error: { var: name, rule: "must be a valid absolute URL", example } };
  }

  if (url.protocol !== "https:") {
    return { error: { var: name, rule: "must use HTTPS", example } };
  }

  return { value: url.toString().replace(/\/+$/, "") };
}

function resolveTransport(): { value: Transport } | { error: ConfigError } {
  const raw = process.env.TDEI_TRANSPORT?.trim().toLowerCase();
  if (raw === "http") return { value: "http" };
  if (!raw || raw === "stdio") return { value: "stdio" };
  return { error: { var: "TDEI_TRANSPORT", rule: 'must be "stdio" or "http"', example: "stdio" } };
}

function checkSsoCallbackUrl(value: string, transport: Transport): ConfigError | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { var: "TDEI_SSO_CALLBACK_URL", rule: "must be a valid absolute URL", example: "http://127.0.0.1:8765/callback" };
  }
  const isLoopback =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Boolean(url.port) &&
    url.pathname === "/callback";
  if (transport === "stdio") {
    if (!isLoopback) {
      return { var: "TDEI_SSO_CALLBACK_URL", rule: "must use http://127.0.0.1:<port>/callback", example: "http://127.0.0.1:8765/callback" };
    }
    return undefined;
  }
  const isHttps = url.protocol === "https:";
  if (!isHttps && !isLoopback) {
    return { var: "TDEI_SSO_CALLBACK_URL", rule: "must use https:// in http mode (http://127.0.0.1:<port>/callback allowed for local dev)", example: "https://mcp.example.com/callback" };
  }
  return undefined;
}

export function validateSsoCallbackUrl(value: string, transport: Transport): string {
  const error = checkSsoCallbackUrl(value, transport);
  if (error) throw new Error(`TDEI_SSO_CALLBACK_URL ${error.rule}`);
  return new URL(value).toString();
}

function readHttpPort(): { value: number } | { error: ConfigError } {
  const raw = process.env.TDEI_HTTP_PORT?.trim() || "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: { var: "TDEI_HTTP_PORT", rule: "must be an integer 1-65535", example: "3000" } };
  }
  return { value: port };
}

function readBasePath(): string {
  const raw = process.env.TDEI_HTTP_BASE_PATH?.trim() || "/mcp";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.replace(/\/+$/, "") || "/";
}

export function loadConfig(): { ok: true; config: ResolvedConfig } | { ok: false; errors: ConfigError[] } {
  const errors: ConfigError[] = [];

  const apiUrl = readHttpsUrl("TDEI_API_URL", DEFAULT_API_URL, DEFAULT_API_URL);
  if ("error" in apiUrl) errors.push(apiUrl.error);

  const specUrl = readHttpsUrl("TDEI_SPEC_URL", DEFAULT_SPEC_URL, DEFAULT_SPEC_URL);
  if ("error" in specUrl) errors.push(specUrl.error);

  const transport = resolveTransport();
  if ("error" in transport) errors.push(transport.error);

  const port = readHttpPort();
  if ("error" in port) errors.push(port.error);

  let geocoderUrl: string | undefined;
  const rawGeocoderUrl = process.env.TDEI_GEOCODER_URL?.trim();
  if (rawGeocoderUrl) {
    const geocoder = readHttpsUrl(
      "TDEI_GEOCODER_URL",
      rawGeocoderUrl,
      "https://nominatim.example.org/search",
    );
    if ("error" in geocoder) errors.push(geocoder.error);
    else geocoderUrl = geocoder.value;
  }

  // Skip the callback check when transport itself is invalid (one error, not two).
  if (!("error" in transport)) {
    const callbackError = checkSsoCallbackUrl(
      process.env.TDEI_SSO_CALLBACK_URL?.trim() || DEFAULT_SSO_CALLBACK_URL,
      transport.value,
    );
    if (callbackError) errors.push(callbackError);
  }

  if (errors.length > 0) return { ok: false, errors };

  const goodTransport = (transport as { value: Transport }).value;
  return {
    ok: true,
    config: {
      apiUrl: (apiUrl as { value: string }).value,
      specUrl: (specUrl as { value: string }).value,
      ssoClientId: TDEI_SSO_CLIENT_ID,
      ssoCallbackUrl: new URL(process.env.TDEI_SSO_CALLBACK_URL?.trim() || DEFAULT_SSO_CALLBACK_URL).toString(),
      transport: goodTransport,
      httpHost: process.env.TDEI_HTTP_HOST?.trim() || "127.0.0.1",
      httpPort: (port as { value: number }).value,
      httpBasePath: readBasePath(),
      corsOrigins: (process.env.TDEI_CORS_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean),
      tlsCert: process.env.TDEI_TLS_CERT?.trim() || undefined,
      tlsKey: process.env.TDEI_TLS_KEY?.trim() || undefined,
      awsMcpPackage: process.env.TDEI_AWS_MCP_PACKAGE?.trim() || DEFAULT_AWS_MCP_PACKAGE,
      geocoderUrl,
      geocoderUserAgent: process.env.TDEI_GEOCODER_USER_AGENT?.trim() ||
        "tdei-mcp/0.1 (https://github.com/TaskarCenterAtUW/TDEI-MCP)",
    },
  };
}

let memoized: ResolvedConfig | undefined;

export function getConfig(): ResolvedConfig {
  if (memoized) return memoized;
  const result = loadConfig();
  if (!result.ok) throw new TdeiConfigError(result.errors);
  memoized = result.config;
  return memoized;
}
