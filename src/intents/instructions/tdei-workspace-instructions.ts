import { TDEI_SHARED_SERVER_INSTRUCTIONS } from "./tdei-shared-instructions.js";

/** Instructions for the TDEI Workspace backend. */
export const TDEI_WORKSPACE_SERVER_INSTRUCTIONS = `${TDEI_SHARED_SERVER_INSTRUCTIONS}

## TDEI workspace server
This server talks to the TDEI Workspace backend for workspace editing, tasking, teams, and review workflows. It is not the core dataset catalog. Authentication still uses the TDEI core SSO session from tdei_sso_login.

- Start with get_my_workspaces (GET /api/v1/workspaces/mine) and cache each workspace_id and name. Almost every workspace tool is scoped by workspace_id; never guess or invent one.
- Tasking tools also need project_id and, for task actions, task_number. List projects and tasks before acting, and reuse cached IDs.
- Typical task flow: list projects → list tasks → lock task → work → extend lock if needed → submit task or submit changeset → review the task/project audit. Reset only when the user explicitly asks.
- Workspace jobs use the workspace endpoints: GET /api/v1/workspaces/{workspace_id}/jobs and GET /api/v1/workspaces/jobs/{job_id}. Poll them after starting an async action and fetch the result when the job completes.
- Workspace file operations (create workspace from file, upload project AOI) follow the same client-side curl rule: ask for the absolute path on the CLIENT machine and run the returned command there.
- Dataset validation, upload, publish, and dataset downloads belong to the matching tdei-core-* server. Use that server for those operations instead of calling core-only tools on this workspace server.
`;
