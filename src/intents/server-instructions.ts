import { tdeiEnvironmentInstruction } from "./instructions/tdei-shared-instructions.js";
import { TDEI_CORE_SERVER_INSTRUCTIONS } from "./instructions/tdei-core-instructions.js";
import { TDEI_WORKSPACE_SERVER_INSTRUCTIONS } from "./instructions/tdei-workspace-instructions.js";

export type TdeiServerProfile = "core" | "workspace";

export { TDEI_CORE_SERVER_INSTRUCTIONS } from "./instructions/tdei-core-instructions.js";
export { TDEI_SHARED_SERVER_INSTRUCTIONS } from "./instructions/tdei-shared-instructions.js";
export { TDEI_WORKSPACE_SERVER_INSTRUCTIONS } from "./instructions/tdei-workspace-instructions.js";

/** Backward-compatible default: the core server instructions. */
export const TDEI_SERVER_INSTRUCTIONS = TDEI_CORE_SERVER_INSTRUCTIONS;

export interface TdeiServerProfileInput {
  /** Server name from TDEI_MCP_NAME (e.g. tdei-core-dev, tdei-workspace). */
  name?: string | undefined;
  /** Explicit profile from TDEI_MCP_PROFILE or mcps.json "profile". */
  explicit?: string | undefined;
  /** Backend API URL, used as a fallback signal for single-server setups. */
  apiUrl?: string | undefined;
}

/**
 * Resolve which instruction set a server should advertise. Explicit profile
 * wins, then a workspace-looking name, then a workspace-looking API host.
 * Everything else is a core server.
 */
export function resolveTdeiServerProfile(input: TdeiServerProfileInput = {}): TdeiServerProfile {
  const explicit = input.explicit?.trim().toLowerCase();
  if (explicit === "workspace" || explicit === "core") return explicit;

  const name = input.name?.trim().toLowerCase() ?? "";
  if (/(^|[-_])workspace([-_]|$)/.test(name) || name.includes("workspace")) return "workspace";

  const apiUrl = input.apiUrl?.trim().toLowerCase() ?? "";
  if (apiUrl.includes("ws-backend") || apiUrl.includes("workspace")) return "workspace";

  return "core";
}

/** The full server `instructions` string for a profile. */
export function tdeiServerInstructions(profile: TdeiServerProfile, environment?: "dev" | "stage" | "prod"): string {
  const base = profile === "workspace" ? TDEI_WORKSPACE_SERVER_INSTRUCTIONS : TDEI_CORE_SERVER_INSTRUCTIONS;
  return environment ? `${base}\n\n${tdeiEnvironmentInstruction(environment)}` : base;
}
