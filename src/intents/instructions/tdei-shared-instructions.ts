import { TDEI_LLM_CACHE_INSTRUCTIONS, TDEI_PRESENTATION_INSTRUCTIONS } from "../descriptions.js";

const TDEI_TOOL_AUTH_PARAGRAPH =
  "Authentication is shared across TDEI MCP servers: sign in with tdei_sso_login once. The returned commands already embed the SSO bearer from that session; never ask the user to paste a token. If a call reports TDEI_SSO_REQUIRED or an expired token, sign in again with tdei_sso_login and retry.";

const TDEI_GATEWAY_AUTH_PARAGRAPH =
  "Authentication: tools are listed without signing in, and sign-in starts on the first tool call that needs it. This server has no tdei_sso_login tool; your MCP client runs the browser sign-in itself. When a call fails with 401, TDEI_SSO_REQUIRED or an expired token, do not ask the user whether to log in and do not report the failure as an error: tell them a TDEI sign-in is starting and to approve the browser login (Claude Code: run /mcp and authenticate this server; Claude Desktop: approve the sign-in window or reconnect the connector; Cursor and VS Code: use the server's Sign in action), then retry the same call once without asking again. Never ask the user to paste a token.";

/** Instructions for a gateway-hosted server, where sign-in is the client's OAuth flow rather than a tool. */
export function withGatewaySignIn(instructions: string): string {
  return instructions.replace(TDEI_TOOL_AUTH_PARAGRAPH, TDEI_GATEWAY_AUTH_PARAGRAPH);
}

/**
 * Rules that apply to every TDEI MCP server regardless of backend: one SSO
 * login, no file bytes through MCP, client-side curl transfers, and the shared
 * cache/presentation conventions.
 */
export const TDEI_SHARED_SERVER_INSTRUCTIONS = [
  "## Shared TDEI connector rules (all servers)",
  TDEI_TOOL_AUTH_PARAGRAPH,
  "MCP never accepts or returns file bytes and never reads or writes the server filesystem. For every upload or download, ask for the absolute file path on the CLIENT machine, then run the returned client-side curl command on that machine (single hop, any size). Do not pass inline_base64, a URL fetch, or raw bytes through an MCP tool.",
  "Async work returns a job_id. Track it with tdei_list_jobs (or the server-specific job tool), and fetch the completed output from the job result endpoint only after the status is COMPLETED.",
  "Environments: TDEI runs separate dev, stage and prod environments with different data and separate sign-ins, and the user may have several connected at once (for example tdei-core-dev and tdei-core-production). Each server states its own environment in its instructions. If more than one environment of the same kind of server is connected and the user has not named one, ask which environment before calling any data tool; do not query all of them or pick one yourself. Once the user names an environment, use only that environment's servers for the rest of the conversation, including follow-ups and pagination, until they explicitly switch. Never silently fall back to another environment when the chosen one fails or needs sign-in: report it and let the user choose. For writes and destructive calls (upload, publish, delete, clone, tag, viewer access, key regeneration), restate the environment and get a yes first. If only one environment is connected, do not ask. The environment choice spans both kinds of server: a request that needs core and workspace (for example creating a workspace from a dataset id found on core) must use the core and workspace servers of the SAME environment, because dataset ids, service ids and project group ids from one environment do not exist in another. Never pass an id from one environment to a server of a different environment.",
  "Stay on this kind of server by default. TDEI has two kinds of MCP server per environment: tdei-core-* (datasets, jobs, feedback, metrics) and tdei-workspace-* (workspaces, tasking, teams). Answer from the server you are on; only when the user's request genuinely needs the other kind (for example creating a workspace from a dataset, or showing workspaces by project group name) check that the other kind is connected in the same environment, and if it is not, send the user to the TDEI MCP status page to install both. Never mention the other kind, or the status page, for a request that stays on one kind.",
  TDEI_LLM_CACHE_INSTRUCTIONS,
  TDEI_PRESENTATION_INSTRUCTIONS,
].join("\n\n");

const ENVIRONMENT_LABEL: Record<"dev" | "stage" | "prod", string> = {
  dev: "dev (development)",
  stage: "stage (staging)",
  prod: "prod (production, live data)",
};

/** The line each server adds so the model knows which environment this server is. */
export function tdeiEnvironmentInstruction(environment: "dev" | "stage" | "prod"): string {
  return `## This server's environment\n\nThis server is the ${ENVIRONMENT_LABEL[environment]} environment. When the user asks for ${environment} (or its usual synonyms), use this server; when they ask for a different environment, do not use this server. If the user has not named an environment and other TDEI environments are connected, ask first.`;
}
