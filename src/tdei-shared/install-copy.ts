import type { TdeiServerProfile } from "../intents/server-instructions.js";

/**
 * Profile-specific wording for install pages and installers. Login, restart
 * and update steps are identical for every server; only what to do AFTER login
 * differs, so core and workspace installs never describe each other's tools.
 */
export interface InstallCopy {
  /** What this server is, one line. */
  summary: string;
  /** First tool call after SSO login. */
  firstCall: string;
  /** Tool used to poll async work. */
  jobsTool: string;
  /** Sentence for the end of an install: what to ask the agent after logging in. */
  afterLogin: string;
  /** Sentence about file transfers. */
  fileTransfer: string;
}

const COPY: Record<TdeiServerProfile, InstallCopy> = {
  core: {
    summary: "TDEI core data server: project groups, services, datasets, jobs, feedback and metrics.",
    firstCall: "tdei_list_my_project_groups",
    jobsTool: "tdei_list_jobs",
    afterLogin: "Then try tdei_list_my_project_groups to see your project groups and datasets.",
    fileTransfer:
      "File bytes never go through MCP — run curl from the client machine for dataset uploads and validation, then poll with tdei_list_jobs.",
  },
  workspace: {
    summary: "TDEI workspace server: workspaces, tasking projects and tasks, teams and roles, changesets.",
    firstCall: "get_my_workspaces",
    jobsTool: "get_jobs_by_workspace_id",
    afterLogin:
      "Then try get_my_workspaces to see your workspaces. Dataset upload, validation and publish live on the matching tdei-core-* server.",
    fileTransfer:
      "File bytes never go through MCP — run curl from the client machine for workspace-from-file and project AOI uploads, then poll with get_jobs_by_workspace_id.",
  },
};

export function installCopy(profile: TdeiServerProfile = "core"): InstallCopy {
  return COPY[profile];
}
