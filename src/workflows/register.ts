import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WorkflowDef } from "../config-file.js";
import { runWorkflow } from "./runner.js";
import { validateWorkflow } from "./validate.js";
import { errorResult, jsonResult } from "../mcp/responses.js";

// Per server: workflow tool name -> serialized definition, so a reload of an
// unchanged workflow is a no-op but a changed or duplicate one is an error.
const registeredWorkflows = new WeakMap<McpServer, Map<string, string>>();

export interface RegisterWorkflowDeps {
  callTool: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
  toolSchemas: Map<string, { description?: string; inputSchema: unknown }>;
  denied: Set<string>;
  multipart?: Set<string>;
  configPath: string;
}

export function registerWorkflows(server: McpServer, workflows: WorkflowDef[], deps: RegisterWorkflowDeps): { registered: string[] } {
  let seen = registeredWorkflows.get(server);
  if (!seen) { seen = new Map(); registeredWorkflows.set(server, seen); }
  const registered: string[] = [];
  for (const def of workflows) {
    const toolName = `workflow_${def.name}`;
    const fingerprint = JSON.stringify(def);
    const previous = seen.get(toolName);
    if (previous !== undefined) {
      if (previous === fingerprint) continue;
      throw new Error(`[tdei-config] duplicate workflow in ${deps.configPath}: "${def.name}" is already registered with a different definition — restart the MCP server to apply changes to existing workflows`);
    }
    validateWorkflow(def, deps);
    const askKeys = [...new Set(def.steps.flatMap((s) => s.ask ?? []))];
    const shape: Record<string, z.ZodType> = {};
    for (const key of askKeys) shape[key] = z.string().min(1).describe(`Required input ${key}`);
    server.registerTool(toolName, { description: def.description || `Linear workflow ${def.name}: ${def.steps.map((s) => s.tool).join(" -> ")}`, inputSchema: z.object(shape) }, async (args) => {
      try {
        const result = await runWorkflow(def, args as Record<string, unknown>, { callTool: deps.callTool, toolSchemas: deps.toolSchemas, denied: deps.denied, multipart: deps.multipart });
        return jsonResult({ workflow: def.name, outputs: result.outputs, transcript: result.transcript });
      } catch (error) { return errorResult(error); }
    });
    seen.set(toolName, fingerprint);
    console.error(`[workflows] registered ${toolName} (${def.steps.length} steps)`);
    registered.push(toolName);
  }
  return { registered };
}
