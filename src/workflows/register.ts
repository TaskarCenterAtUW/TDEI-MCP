import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WorkflowDef } from "../config-file.js";
import { runWorkflow } from "./runner.js";
import { jsonResult } from "../mcp/responses.js";
import { formatError } from "../mcp/errors.js";

const registeredWorkflows = new Set<string>();

export function registerWorkflows(server: McpServer, workflows: WorkflowDef[], deps: { callTool: (tool: string, input: Record<string, unknown>) => Promise<unknown>; toolSchemas: Map<string, { description?: string | undefined; inputSchema: unknown }>; denied: Set<string>; configPath: string }): { registered: string[] } {
  const registered: string[] = [];
  for (const def of workflows) {
    const toolName = `workflow_${def.name}`;
    if (registeredWorkflows.has(toolName)) continue;
    for (const step of def.steps) {
      if (!deps.toolSchemas.has(step.tool)) throw new Error(`[tdei-config] unknown operationId in ${deps.configPath}: workflows.${def.name}.steps.${step.id}.tool "${step.tool}" does not match any discovered tool`);
      if (deps.denied.has(step.tool)) throw new Error(`[tdei-config] disabled by config in ${deps.configPath}: workflows.${def.name}.steps.${step.id}.tool "${step.tool}" is denied`);
    }
    const askKeys = [...new Set(def.steps.flatMap((s) => s.ask ?? []))];
    const shape: Record<string, z.ZodType> = {};
    for (const key of askKeys) shape[key] = z.string().min(1).describe(`Required input ${key}`);
    server.registerTool(toolName, { description: def.description || `Linear workflow ${def.name}: ${def.steps.map((s) => s.tool).join(" -> ")}`, inputSchema: z.object(shape) }, async (args) => {
      try {
        const result = await runWorkflow(def, args as Record<string, unknown>, { callTool: deps.callTool, toolSchemas: deps.toolSchemas, denied: deps.denied });
        return jsonResult({ workflow: def.name, outputs: result.outputs, transcript: result.transcript });
      } catch (error) { return formatError(error); }
    });
    registeredWorkflows.add(toolName);
    console.error(`[workflows] registered ${toolName} (${def.steps.length} steps)`);
    registered.push(toolName);
  }
  return { registered };
}
