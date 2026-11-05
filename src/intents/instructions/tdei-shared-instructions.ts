import { TDEI_LLM_CACHE_INSTRUCTIONS, TDEI_PRESENTATION_INSTRUCTIONS } from "../descriptions.js";

/**
 * Rules that apply to every TDEI MCP server regardless of backend: one SSO
 * login, no file bytes through MCP, client-side curl transfers, and the shared
 * cache/presentation conventions.
 */
export const TDEI_SHARED_SERVER_INSTRUCTIONS = [
  "## Shared TDEI connector rules (all servers)",
  "Authentication is shared across TDEI MCP servers: sign in with tdei_sso_login once. The returned commands already embed the SSO bearer from that session; never ask the user to paste a token. If a call reports TDEI_SSO_REQUIRED or an expired token, sign in again with tdei_sso_login and retry.",
  "MCP never accepts or returns file bytes and never reads or writes the server filesystem. For every upload or download, ask for the absolute file path on the CLIENT machine, then run the returned client-side curl command on that machine (single hop, any size). Do not pass inline_base64, a URL fetch, or raw bytes through an MCP tool.",
  "Async work returns a job_id. Track it with tdei_list_jobs (or the server-specific job tool), and fetch the completed output from the job result endpoint only after the status is COMPLETED.",
  TDEI_LLM_CACHE_INSTRUCTIONS,
  TDEI_PRESENTATION_INSTRUCTIONS,
].join("\n\n");
