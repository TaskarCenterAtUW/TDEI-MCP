/**
 * Some TDEI tasks have no API operation and can only be done in a web UI (TDEI Portal or Workspaces).
 * Tool descriptions carry a handoff for each: where to send the user (per-environment link), the exact
 * steps, the role needed, and what to offer afterwards, so the model never leaves the user lost.
 * Steps come from the TCAT wiki (taskarcenteratuw.github.io/tcat-wiki); UI labels may change, so the
 * model is told to say "or the closest equivalent" rather than invent controls.
 */

export type TdeiEnvironment = "dev" | "stage" | "prod";

function environmentToken(text: string): TdeiEnvironment | undefined {
  const value = text.toLowerCase();
  if (/(^|[^a-z])dev([^a-z]|$)/.test(value)) return "dev";
  if (/stag(e|ing)/.test(value)) return "stage";
  if (/(^|[^a-z])prod(uction)?([^a-z]|$)/.test(value)) return "prod";
  return undefined;
}

/**
 * dev/stage/prod for this server. Priority: explicit TDEI_ENVIRONMENT, then the server name
 * (tdei-core-dev, tdei-workspace-stage, ...), then the API host (api-dev.tdei.us, ws-backend-stage...,
 * api.tdei.us). Defaults to prod. A dev server therefore only ever points at the dev portal and dev Workspaces.
 */
export function resolveTdeiEnvironment(env: NodeJS.ProcessEnv = process.env): TdeiEnvironment {
  const explicit = env.TDEI_ENVIRONMENT?.trim() ? environmentToken(env.TDEI_ENVIRONMENT) : undefined;
  return explicit ?? environmentToken(env.TDEI_MCP_NAME ?? "") ?? environmentToken(env.TDEI_API_URL ?? "") ?? "prod";
}

const PORTAL_HOST: Record<TdeiEnvironment, string> = {
  dev: "https://portal-dev.tdei.us",
  stage: "https://portal-stage.tdei.us",
  prod: "https://portal.tdei.us",
};

const WORKSPACES_HOST: Record<TdeiEnvironment, string> = {
  dev: "https://workspaces-dev.sidewalks.washington.edu",
  stage: "https://workspaces-stage.sidewalks.washington.edu",
  prod: "https://workspaces.sidewalks.washington.edu",
};

export function portalUrl(environment: TdeiEnvironment, path = "/"): string {
  return `${PORTAL_HOST[environment]}${path}`;
}

export function workspacesUrl(environment: TdeiEnvironment, path = "/dashboard"): string {
  return `${WORKSPACES_HOST[environment]}${path}`;
}

export type WebUiTask =
  | "register_account"
  | "create_service"
  | "manage_project_group_members"
  | "export_workspace"
  | "edit_workspace_features"
  | "review_changesets";

interface Handoff {
  /** What the user is trying to do. */
  task: string;
  link: (environment: TdeiEnvironment) => string;
  steps: string[];
  role: string;
  /** What the model can still do through MCP afterwards. */
  after: string;
  /** When the task also has MCP tools (User Management API), they come first and the web UI is the fallback. */
  api?: string;
}

const HANDOFFS: Record<WebUiTask, Handoff> = {
  register_account: {
    task: "register a TDEI account",
    link: (e) => portalUrl(e, "/register"),
    steps: [
      "Open the link, or go to the TDEI Portal and choose TDEI Login, then Register Now.",
      "Enter first name, last name, email, optional phone and a password (min 8 characters with a lowercase letter, an uppercase letter, a number and a special character), accept the Terms and Conditions and choose Create Account.",
      "Open the verification email from admin@tdei.us and choose Verify My Email (check spam; the page can resend it).",
    ],
    role: "none; anyone can register. The user must type their own password; never ask for it in chat.",
    after: "Once registered and verified, ask them to sign in again so the session picks up the new account.",
  },
  create_service: {
    task: "create or edit a TDEI service (OSW, Flex or Pathways) for a project group",
    api: "use portal_create_service, portal_update_service and portal_set_service_active (list existing ones with tdei_list_services first; project group ids from tdei_list_my_project_groups). They need the poc role in that project group and the exact change confirmed with the user.",
    link: (e) => portalUrl(e, "/"),
    steps: [
      "Open the Portal and make the target project group the active one.",
      "Open Services and choose Create Service (top right).",
      "Enter the Service Name and the Service Type (OSW, Flex or Pathways); Service Boundaries (a GeoJSON FeatureCollection) is optional. Choose Create.",
      "To change a service later use Edit (name or boundaries) or Deactivate on its row.",
    ],
    role: "the project group's Point of Contact (poc) role; other members see a read-only list",
    after: "Afterwards call tdei_list_services to confirm the new service and reuse its id for uploads.",
  },
  manage_project_group_members: {
    task: "add members to a project group or change their roles",
    api: "use portal_assign_project_group_roles and portal_revoke_project_group_roles (valid roles from portal_list_roles, current members from portal_list_project_group_members). They need the poc role in that project group, the user must already have a TDEI account, and the email and roles must be confirmed twice.",
    link: (e) => portalUrl(e, "/"),
    steps: [
      "Open the Portal and make the target project group the active one.",
      "Open Members and choose Assign New User (top right).",
      "Enter the user's registered email (they must already have a TDEI account), select one or more roles and choose Assign. Double-check the email and roles: a wrong poc assignment grants broad change rights.",
    ],
    role: "the project group's Point of Contact (poc) role; others get a permission error",
    after:
      "Afterwards the user can check their own roles with tdei_get_my_identity (a new sign-in may be needed for the token to refresh).",
  },
  export_workspace: {
    task: "export a workspace to TDEI as a new dataset",
    link: (e) => workspacesUrl(e, "/dashboard"),
    steps: [
      "Open the Workspaces dashboard with the workspace selected (add ?workspace=<workspace_id> to the link when the id is known).",
      "Open the workspace actions menu and choose Export.",
      "On the Export Workspace page choose Upload to TDEI, select Start and follow the prompts. First review the edits and confirm the workspace id, source lineage, target format, project group and review status.",
    ],
    role: "POC or osw_data_generator in at least one TDEI project group; otherwise Workspaces shows a permission message instead of the form",
    after:
      "Export is not validation or publication. Only if the user also wants to validate, publish or pick a service, that is a cross-server step on the matching tdei-core-* server (tdei_find_datasets, tdei_validate_dataset, tdei_publish_dataset, tdei_list_services): follow the companion-server rule if it is missing; otherwise do not bring it up.",
  },
  edit_workspace_features: {
    task: "edit map features in a workspace",
    link: (e) => workspacesUrl(e, "/dashboard"),
    steps: [
      "Open the Workspaces dashboard and select the workspace (it opens at /dashboard?workspace=<id>).",
      "Choose an editor: Rapid in the browser, JOSM, or AVIV ScoutRoute on mobile for targeted survey questions.",
      "Edits are committed as changesets; coordinate with teammates so two people do not edit the same area unknowingly.",
    ],
    role: "workspace membership; reviewing and settings need extra roles",
    after: "MCP cannot edit features. It can show tasks, locks, changeset diffs and audit events for the work.",
  },
  review_changesets: {
    task: "review changesets or see per-feature edit history in a workspace",
    link: (e) => workspacesUrl(e, "/workspace/<workspace_id>/review"),
    steps: [
      "Open the link with the workspace id filled in (add ?changeset=<changeset_id> for one changeset).",
      "Inspect the changeset: author, time, sources, comments and before/after values; the edits view lists changed attributes and can restore them.",
      "For a flagged changeset choose Mark as Reviewed once checked; follow-up corrections are new changesets.",
    ],
    role: "validator or owner to mark changesets reviewed",
    after:
      "MCP can fetch the augmented diff of a known changeset id (get_changeset_adiff) and list audit events, and mark a changeset as reviewed with resolve_changeset (validator or owner), but detailed inspection and the per-feature edits view are web UI only.",
  },
};

/** Description text telling the model to hand a UI-only task to the user with a link and steps. */
export function webUiHandoff(task: WebUiTask, env: NodeJS.ProcessEnv = process.env): string {
  const h = HANDOFFS[task];
  const environment = resolveTdeiEnvironment(env);
  const steps = h.steps.map((step, i) => `${i + 1}) ${step}`).join(" ");
  if (h.api) {
    return (
      `To ${h.task}: ${h.api} Only if those tools are not available in this session, or the user prefers the web UI, hand off instead: ` +
      `give them this link (${environment}): ${h.link(environment)} and walk them through it: ${steps} Role needed: ${h.role}. ` +
      `Say the labels may differ slightly if the UI changed; do not invent controls. When it is done, ${h.after}`
    );
  }
  return (
    `Web UI only, no MCP operation: to ${h.task}, give the user this link (${environment}): ${h.link(environment)} and walk them through it: ${steps} ` +
    `Role needed: ${h.role}. Say the labels may differ slightly if the UI changed; do not invent controls. When they are done, ${h.after}`
  );
}
