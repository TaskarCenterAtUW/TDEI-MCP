/**
 * Core and workspace servers depend on each other for some tasks: workspace
 * creation needs core project groups, services and datasets; dataset work that
 * ends in a workspace needs the workspace server. Tool descriptions carry a
 * short "companion server" note so the model checks that the other server is
 * connected and otherwise sends the user to the MCP status page to install it.
 */

/** Optional env: the status/install page of this deployment (the base URL users installed from). */
export function statusPageHint(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TDEI_STATUS_PAGE_URL?.trim();
  return url
    ? `the TDEI MCP status page (${url})`
    : "the TDEI MCP status page (the root URL of the TDEI MCP host the user installed this server from)";
}

function installFallback(env: NodeJS.ProcessEnv): string {
  return (
    `Do not guess ids or continue with partial data: tell the user the matching server is missing, send them to ${statusPageHint(env)} ` +
    "and ask them to install BOTH servers for the same environment (dev, stage or prod), then restart the client and start a new chat."
  );
}

/** Appended to workspace tools that need TDEI core data (project groups, services, datasets). */
export function coreCompanionNote(env: NodeJS.ProcessEnv = process.env): string {
  return (
    "Companion server required: project group names/ids, services and datasets come from the matching tdei-core-* MCP of the same environment " +
    "(tools tdei_list_my_project_groups, tdei_list_services, tdei_find_datasets). " +
    `Before using this tool, confirm those tools are available in this session. If they are not, ${installFallback(env)}`
  );
}

/** Appended to core tools whose result feeds a workspace action. */
export function workspaceCompanionNote(env: NodeJS.ProcessEnv = process.env): string {
  return (
    "Companion server for workspace tasks: if the user's goal is a workspace action (create a workspace from a dataset, export a workspace, list workspaces or workspace roles), " +
    "the matching tdei-workspace-* MCP of the same environment is also required (tools such as get_my_workspaces / create_workspace). " +
    `If it is not available in this session, ${installFallback(env)}`
  );
}
