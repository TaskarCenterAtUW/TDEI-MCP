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
 * Characters of the commit SHA used to pin the npx package spec.
 *
 * A full 40-character SHA breaks `npx` on npm 10 (the npm bundled with Node
 * 22): pacote takes its "hosted tarball" shortcut for a full SHA, and since
 * this package has a `prepare` script it then needs an Arborist to pack the
 * prepared tarball. `npm exec` does not pass one, so the install dies with
 * "GitFetcher requires an Arborist constructor to pack a tarball" before the
 * CLI ever runs. Any committish shorter than 40 characters makes pacote clone
 * (which npm exec does pass Arborist to), so pin with an abbreviated SHA that
 * is still unambiguous in practice. See npm/cli#6723.
 */
const NPX_PIN_LENGTH = 12;

/** Abbreviated commit SHA that is safe for an `npx` git spec, if `buildSha` is a SHA. */
function npxPin(buildSha?: string): string | undefined {
  const sha = (buildSha ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, NPX_PIN_LENGTH) : undefined;
}

/**
 * Package spec for `npx`: this repository, pinned to the deployed commit when its SHA is known (so the
 * CLI always matches the gateway), else the dev branch. TDEI_NPX_PACKAGE overrides it; set that once the
 * package is published on npm, preferably with an exact version (`tdei-mcp@0.1.42`) so the CLI matches
 * the gateway. A registry spec is the preferred install path: no git, no client-side build, and no
 * npm-10 full-SHA packing bug.
 */
export function npxPackageSpec(buildSha?: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env["TDEI_NPX_PACKAGE"]?.trim();
  if (override) return override;
  return `${SETUP_REPO}#${npxPin(buildSha) ?? "dev"}`;
}

/** `npx -y <package> setup`: the prefix every setup command on the pages and in messages starts with. */
export function npxSetupCommand(buildSha?: string, env: NodeJS.ProcessEnv = process.env): string {
  return `npx -y ${npxPackageSpec(buildSha, env)} setup`;
}
