import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { exportToTdeiRunbook } from "./export-to-tdei.js";
import { resolveTdeiEnvironment, webUiHandoff, workspacesUrl } from "../tdei-shared/web-ui-handoffs.js";

export const EXPORT_WORKSPACE_TOOL = "export_workspace_to_tdei";

const exportSchema = z.object({
  workspace_id: z.string().trim().min(1).optional(),
  method: z.enum(["web_ui", "api_runbook"]).optional(),
});

export const EXPORT_WORKSPACE_TOOL_DESCRIPTION =
  "Export a workspace to TDEI core as a NEW dataset (the Workspaces 'Export > Upload to TDEI' action). Call this whenever the user asks to export, publish or push a workspace to TDEI core. " +
  "It does not upload anything itself: it returns the instructions to follow. method web_ui (default) gives the Workspaces web UI link and steps, the recommended way. " +
  "method api_runbook returns the step-by-step recipe for doing the export yourself with existing tools plus client-side curl; use it only when the user asks you to do the export for them. " +
  "workspace_id is optional (it fills in the web UI link); never guess it, find it with get_my_workspaces.";

/** The instructions the export tool returns; split out so it can be tested without a server. */
export function exportWorkspaceGuide(
  args: { workspace_id?: string | undefined; method?: "web_ui" | "api_runbook" | undefined },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (args.method === "api_runbook") return exportToTdeiRunbook(env);
  const environment = resolveTdeiEnvironment(env);
  const link = args.workspace_id
    ? workspacesUrl(environment, `/dashboard?workspace=${encodeURIComponent(args.workspace_id)}`)
    : workspacesUrl(environment, "/dashboard");
  const handoff = webUiHandoff("export_workspace", env).replace(workspacesUrl(environment, "/dashboard"), link);
  return (
    `${handoff}\n\nThis is the recommended way. If the user would rather have you do the export, call ${EXPORT_WORKSPACE_TOOL} again with method api_runbook ` +
    `(it needs a client that can run commands on their machine).`
  );
}

export function registerExportWorkspaceTool(server: McpServer): void {
  server.registerTool(
    EXPORT_WORKSPACE_TOOL,
    {
      description: EXPORT_WORKSPACE_TOOL_DESCRIPTION,
      inputSchema: exportSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (async (args: z.infer<typeof exportSchema>) => ({
      content: [{ type: "text" as const, text: exportWorkspaceGuide(args) }],
    })) as unknown as Parameters<McpServer["registerTool"]>[2],
  );
}
