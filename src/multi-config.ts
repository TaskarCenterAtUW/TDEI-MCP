import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { specUrlForApiUrl } from "./init/envs.js";

export interface MultiMcpServerEntry {
  name: string;
  apiUrl: string;
  specUrl?: string;
  port?: number;
  basePath?: string;
  ssoCallbackUrl?: string;
}

export interface MultiMcpFile {
  host?: string;
  basePort?: number;
  basePath?: string;
  ssoCallbackPort?: number;
  servers: MultiMcpServerEntry[];
}

export interface ResolvedMultiMcpServer {
  name: string;
  slug: string;
  apiUrl: string;
  specUrl: string;
  host: string;
  port: number;
  basePath: string;
  ssoCallbackUrl: string;
  url: string;
}

export function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "mcp";
}

function assertHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be a valid absolute URL (got ${JSON.stringify(value)})`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS (got ${JSON.stringify(value)})`);
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeBasePath(value: string, name: string): string {
  const path = value.trim();
  if (!path.startsWith("/")) throw new Error(`${name} must start with "/" (got ${JSON.stringify(value)})`);
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error(`${name} must be a plain path (got ${JSON.stringify(value)})`);
  }
  return normalized;
}

function assertPort(value: unknown, name: string): number {
  const port = typeof value === "string" ? Number(value.trim()) : (value as number);
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error(`${name} must be an integer 1-65535 (got ${JSON.stringify(value)})`);
  }
  return port as number;
}

export function resolveMultiMcpFilePath(explicit?: string): string {
  const fromEnv = process.env.TDEI_MCPS_FILE?.trim();
  const candidate = explicit?.trim() || fromEnv || "mcps.json";
  return resolve(process.cwd(), candidate);
}

export function loadMultiMcpFile(path: string): MultiMcpFile {
  if (!existsSync(path)) {
    throw new Error(`Multi-MCP file not found: ${path}. Copy mcps.example.json to mcps.json and edit names/apiUrls.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid multi-MCP file ${path}: expected {"servers":[{name,apiUrl,...}]}`);
  }
  const record = parsed as Record<string, unknown>;
  const servers = record.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error(`Invalid multi-MCP file ${path}: "servers" must be a non-empty array`);
  }
  return {
    ...(typeof record.host === "string" ? { host: record.host } : {}),
    ...(typeof record.basePort === "number" || typeof record.basePort === "string"
      ? { basePort: record.basePort as number }
      : {}),
    ...(typeof record.basePath === "string" ? { basePath: record.basePath } : {}),
    ...(typeof record.ssoCallbackPort === "number" || typeof record.ssoCallbackPort === "string"
      ? { ssoCallbackPort: record.ssoCallbackPort as number }
      : {}),
    servers: servers as MultiMcpServerEntry[],
  };
}

export function resolveMultiMcp(
  file: MultiMcpFile,
  overrides: { host?: string; basePort?: number } = {},
): ResolvedMultiMcpServer[] {
  const host = (overrides.host ?? file.host ?? process.env.TDEI_HTTP_HOST?.trim() ?? "127.0.0.1").trim() || "127.0.0.1";
  const basePortRaw = overrides.basePort ?? file.basePort ?? Number(process.env.TDEI_HTTP_PORT?.trim() || "3000");
  const basePort = assertPort(basePortRaw, "basePort");
  const baseSsoPortRaw = file.ssoCallbackPort ?? 8765;
  const baseSsoPort = assertPort(baseSsoPortRaw, "ssoCallbackPort");
  const sharedBasePath = typeof file.basePath === "string" && file.basePath.trim() ? file.basePath.trim() : undefined;
  if (sharedBasePath !== undefined) normalizeBasePath(sharedBasePath, "basePath");

  if (file.servers.length > 20) {
    throw new Error(`Refusing to launch ${file.servers.length} MCP servers (max 20)`);
  }

  const seenNames = new Set<string>();
  const seenPorts = new Set<number>();
  const resolved: ResolvedMultiMcpServer[] = [];

  file.servers.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`servers[${index}] must be an object {name, apiUrl}`);
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) throw new Error(`servers[${index}].name is required`);
    const slug = slugifyName(name);
    if (seenNames.has(slug)) throw new Error(`Duplicate server name/slug ${JSON.stringify(name)} (slug "${slug}")`);
    seenNames.add(slug);

    if (typeof entry.apiUrl !== "string" || !entry.apiUrl.trim()) {
      throw new Error(`servers[${index}] (${name}): apiUrl is required`);
    }
    const apiUrl = assertHttpsUrl(entry.apiUrl, `servers[${index}].apiUrl`);
    const specUrl =
      typeof entry.specUrl === "string" && entry.specUrl.trim()
        ? assertHttpsUrl(entry.specUrl, `servers[${index}].specUrl`)
        : specUrlForApiUrl(apiUrl);

    const port = entry.port !== undefined ? assertPort(entry.port, `servers[${index}].port`) : basePort + index;
    if (seenPorts.has(port)) throw new Error(`Port collision: ${port} assigned twice (servers[${index}] "${name}")`);
    seenPorts.add(port);

    const basePath =
      typeof entry.basePath === "string" && entry.basePath.trim()
        ? normalizeBasePath(entry.basePath, `servers[${index}].basePath`)
        : sharedBasePath
          ? normalizeBasePath(
              sharedBasePath.includes("{name}")
                ? sharedBasePath.replaceAll("{name}", slug)
                : `${sharedBasePath}/${slug}`,
              `basePath for "${name}"`,
            )
          : `/${slug}/mcp`;

    const ssoCallbackUrl =
      typeof entry.ssoCallbackUrl === "string" && entry.ssoCallbackUrl.trim()
        ? entry.ssoCallbackUrl.trim()
        : `http://127.0.0.1:${baseSsoPort + index}/callback`;

    resolved.push({
      name,
      slug,
      apiUrl,
      specUrl,
      host,
      port,
      basePath,
      ssoCallbackUrl,
      url: `http://${host}:${port}${basePath}`,
    });
  });

  return resolved;
}

export function defaultMultiMcpExample(): string {
  return JSON.stringify(
    {
      $schema: "./mcps.schema.json",
      host: "127.0.0.1",
      basePort: 3000,
      servers: [
        { name: "tdei-core", apiUrl: "https://api-dev.tdei.us" },
        { name: "tdei-workspace", apiUrl: "https://api-stage.tdei.us" },
      ],
    },
    null,
    2,
  );
}
