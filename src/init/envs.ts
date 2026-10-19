const SPEC_REPO = "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs";
const SPEC_FILE = "tdei-api-gateway.json";

export const ENVS = {
  dev: { apiUrl: "https://api-dev.tdei.us", specBranch: "dev", label: "Development (api-dev.tdei.us)" },
  stage: { apiUrl: "https://api-stage.tdei.us", specBranch: "stage", label: "Stage (api-stage.tdei.us)" },
  prod: { apiUrl: "https://api.tdei.us", specBranch: "main", label: "Production (api.tdei.us)" },
} as const;
export type EnvName = keyof typeof ENVS;

export function specUrlForBranch(branch: string): string {
  return `${SPEC_REPO}/${branch}/${SPEC_FILE}`;
}

/** OpenAPI spec for a known TDEI API origin; unknown hosts use the dev spec. */
export function specUrlForApiUrl(apiUrl: string): string {
  try {
    const origin = new URL(apiUrl).origin;
    for (const env of Object.values(ENVS)) {
      if (env.apiUrl === origin) return specUrlForBranch(env.specBranch);
    }
  } catch {
    // Invalid URL — caller validates TDEI_API_URL separately.
  }
  return specUrlForBranch("dev");
}

export const DEFAULT_SPEC_URL = specUrlForBranch("dev");

export function assertHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function buildCallbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export function assertCallbackUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/callback") {
    throw new Error("TDEI_SSO_CALLBACK_URL must use http://127.0.0.1:<port>/callback");
  }
  return url.toString();
}

export function resolveApiUrl(opts: { env?: string | undefined; url?: string | undefined }): string {
  if (opts.env && opts.url) {
    throw new Error("--env and --url are mutually exclusive: pick one environment per run");
  }
  if (opts.url) return normalizeToOrigin(opts.url, "TDEI_API_URL");
  if (!opts.env) {
    throw new Error("no environment given: pass --env dev|stage|prod or --url <https-url>");
  }
  const entry = (ENVS as Record<string, { apiUrl: string }>)[opts.env];
  if (!entry) {
    throw new Error(`unknown environment "${opts.env}" (expected one of: dev, stage, prod, or pass --url)`);
  }
  return entry.apiUrl;
}

// Users paste what they have — often a portal page or a full endpoint path
// (e.g. https://api-dev.tdei.us/api/v1/authenticate). The server derives all
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
