import { SetupUsageError } from "./errors.js";

/**
 * Which hosted connectors `tdei-mcp setup` installs, and where they live.
 * Entry names match `mcps.json`; each is served at `<gateway>/<name>/mcp`.
 */

export const SETUP_ENVS = ["dev", "stage", "prod"] as const;
export type SetupEnv = (typeof SETUP_ENVS)[number];

export const SETUP_PROFILES = ["core", "workspace", "both"] as const;
export type SetupProfile = (typeof SETUP_PROFILES)[number];

const SERVER_NAMES: Record<SetupEnv, { core: string; workspace: string }> = {
  dev: { core: "tdei-core-dev", workspace: "tdei-workspace-dev" },
  stage: { core: "tdei-core-staging", workspace: "tdei-workspace-stage" },
  prod: { core: "tdei-core-production", workspace: "tdei-workspace-prod" },
};

/** The one hosted gateway that serves every environment's connectors. */
const DEFAULT_GATEWAY = "https://tdei-mcp-dev.proudbay-977f7717.westus.azurecontainerapps.io";

export interface SetupTarget {
  name: string;
  url: string;
}

/** Gateway origin: the shared hosted gateway unless --gateway overrides it. */
export function resolveGateway(override?: string): string {
  const raw = (override ?? DEFAULT_GATEWAY).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SetupUsageError(`--gateway must be a full URL such as https://host, got "${raw}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SetupUsageError("--gateway must start with https:// (or http:// for a local server).");
  }
  return parsed.origin;
}

export function resolveTargets(env: SetupEnv, profile: SetupProfile, gateway: string): SetupTarget[] {
  const names = SERVER_NAMES[env];
  const picked =
    profile === "both" ? [names.core, names.workspace] : [profile === "core" ? names.core : names.workspace];
  return picked.map((name) => ({ name, url: `${gateway}/${name}/mcp` }));
}

/** Display label for the combined core + workspace entry of an environment (dropdown order: dev, staging, production). */
export const SETUP_ENV_LABELS: Record<SetupEnv, string> = {
  dev: "tdei-*-dev",
  stage: "tdei-*-staging",
  prod: "tdei-*-production",
};

/** Human-readable environment names for the install pages. */
export const SETUP_ENV_NAMES: Record<SetupEnv, string> = {
  dev: "Development",
  stage: "Staging",
  prod: "Production",
};

/** Hosted connector entry names per environment (used by the install pages to build script URLs). */
export const SETUP_SERVER_NAMES: Record<SetupEnv, { core: string; workspace: string }> = SERVER_NAMES;

/** Which environment a server name belongs to (tdei-core-dev -> dev, tdei-workspace-stage -> stage, ...). */
export function setupEnvForServer(name: string): SetupEnv | undefined {
  for (const env of SETUP_ENVS) {
    if (name === SERVER_NAMES[env].core || name === SERVER_NAMES[env].workspace) return env;
  }
  const suffix = /-(dev|stage|staging|prod|production)$/.exec(name)?.[1];
  if (suffix === "dev") return "dev";
  if (suffix === "stage" || suffix === "staging") return "stage";
  if (suffix === "prod" || suffix === "production") return "prod";
  return undefined;
}

/** The repository the setup CLI is installed from (public; no npm publish needed). */
const SETUP_REPO = "github:TaskarCenterAtUW/TDEI-MCP";

/**
 * Package spec for `npx`: this repository, pinned to the deployed commit when its SHA is known (so the
 * CLI always matches the gateway), else the dev branch. TDEI_NPX_PACKAGE overrides it (for example
 * `tdei-mcp` once the package is published on npm).
 */
export function npxPackageSpec(buildSha?: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env["TDEI_NPX_PACKAGE"]?.trim();
  if (override) return override;
  return /^[0-9a-f]{7,40}$/i.test(buildSha ?? "") ? `${SETUP_REPO}#${buildSha}` : `${SETUP_REPO}#dev`;
}

/** `npx -y <package> setup`: the prefix every setup command on the pages and in messages starts with. */
export function npxSetupCommand(buildSha?: string, env: NodeJS.ProcessEnv = process.env): string {
  return `npx -y ${npxPackageSpec(buildSha, env)} setup`;
}
