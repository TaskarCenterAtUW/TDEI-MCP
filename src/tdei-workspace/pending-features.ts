import { resolveTdeiEnvironment, type TdeiEnvironment } from "../tdei-shared/web-ui-handoffs.js";

/**
 * Workspace operations that exist in the dev and stage backends but are not deployed to production yet
 * (found by diffing the three OpenAPI specs). On prod they are simply not discovered, so the model must be
 * told why they are missing instead of searching for them or blaming the connection.
 */
export const WORKSPACE_PENDING_FEATURES: ReadonlyArray<{ operation: string; label: string }> = [
  { operation: "check_workspace_create", label: "the workspace creation pre-check (check_workspace_create)" },
  { operation: "get_fixmes", label: "the workspace fixmes listing (get_fixmes)" },
];

function labels(): string {
  return WORKSPACE_PENDING_FEATURES.map((feature) => feature.label).join(" and ");
}

/** Text for the server instructions and create_workspace: what is missing here and why. */
export function pendingFeaturesNote(environment: TdeiEnvironment = resolveTdeiEnvironment()): string {
  if (environment === "prod") {
    return (
      `Not yet available in production: ${labels()} are under testing on the dev and stage Workspaces servers and will be available once they are deployed to production. ` +
      "If the user asks for them, say exactly that; do not search for a substitute, do not call them a connection problem, and continue without them (for creation use the name check)."
    );
  }
  return (
    `Under testing: ${labels()} are available on this ${environment} server but are not deployed to production yet; ` +
    "tell the user that if they plan to rely on them in production, and that they will be available there once deployed."
  );
}

/** Per-tool banner for the pending operations that are discovered on dev/stage. */
export function pendingToolBanner(environment: TdeiEnvironment = resolveTdeiEnvironment()): string {
  return environment === "prod"
    ? "Under testing; not yet deployed to production."
    : `Under testing: available on ${environment} only for now, not yet deployed to production; behavior may change before release.`;
}
