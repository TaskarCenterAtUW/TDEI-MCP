export const ENVS = {
  dev: { apiUrl: "https://api-dev.tdei.us", label: "Development (api-dev.tdei.us)" },
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

export function resolveApiUrl(opts: { env?: string; url?: string }): string {
  if (opts.env && opts.url) {
    throw new Error("--env and --url are mutually exclusive: pick one environment per run");
  }
  if (opts.url) return assertHttpsUrl(opts.url, "TDEI_API_URL");
  const env = opts.env ?? "dev";
  const entry = (ENVS as Record<string, { apiUrl: string }>)[env];
  if (!entry) {
    throw new Error(`unknown environment "${env}" (expected one of: dev, stage, prod, or pass --url)`);
  }
  return entry.apiUrl;
}
