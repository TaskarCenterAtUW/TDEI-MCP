export const ENVS = {
  stage: { apiUrl: "https://api-stage.tdei.us", label: "Stage (api-stage.tdei.us)" },
  prod: { apiUrl: "https://api.tdei.us", label: "Production (api.tdei.us)" },
} as const;
export type EnvName = keyof typeof ENVS;

export const DEFAULT_SPEC_URL =
  "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json";

export function assertHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be a valid absolute URL such as https://api.tdei.us (got "${value}"). This is the same rule as readHttpsUrl in src/config.ts.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS (got "${url.protocol}//"). This is the same rule as readHttpsUrl in src/config.ts.`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function buildCallbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export function assertCallbackUrl(value: string): string {
  const rule = `TDEI_SSO_CALLBACK_URL must use http://127.0.0.1:<port>/callback (got "${value}"). This is the same rule as ssoCallbackUrl in src/config.ts; use 127.0.0.1, not localhost.`;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(rule);
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/callback") {
    throw new Error(rule);
  }
  return url.toString();
}

export function resolveApiUrl(opts: { env?: string; url?: string }): string {
  if (opts.env && opts.url) {
    throw new Error("--env and --url are mutually exclusive: pick one environment per run");
  }
  if (opts.url) return normalizeToOrigin(opts.url, "TDEI_API_URL");
  if (!opts.env) {
    throw new Error("no environment given: pass --env stage|prod or --url <https-url> (e.g. --url https://api.tdei.us)");
  }
  const entry = (ENVS as Record<string, { apiUrl: string }>)[opts.env];
  if (!entry) {
    throw new Error(`unknown environment "${opts.env}" (expected one of: ${Object.keys(ENVS).join(", ")}; or pass --url <https-url>)`);
  }
  return entry.apiUrl;
}

// Users paste what they have — often a portal page or a full endpoint path
// (e.g. https://api.tdei.us/api/v1/authenticate). The server derives all
// paths from the base URL (auth-manager.ts builds {API_URL}/api/v1/...), so
// reduce any input to its https origin and warn when something was stripped.
export function normalizeToOrigin(value: string, name: string): string {
  const cleaned = assertHttpsUrl(value, name);
  const origin = new URL(cleaned).origin;
  if (origin !== cleaned) {
    console.error(`[${name}] using base URL ${origin} (trimmed path from ${cleaned})`);
  }
  return origin;
}
