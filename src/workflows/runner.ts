import { fromJsonSchema } from "@modelcontextprotocol/server";
import { isUploadTool } from "../api/file-upload.js";
import type { WorkflowDef } from "../config-file.js";
import { resolveValue, validateRefs } from "./template.js";
import type { StepResult, WorkflowCallTool } from "./types.js";

export interface RunWorkflowDeps {
  callTool: WorkflowCallTool;
  toolSchemas: Map<string, { inputSchema: unknown }>;
  denied?: Set<string>;
  multipart?: Set<string>;
}

export interface RunWorkflowResult {
  outputs: Record<string, unknown>;
  transcript: StepResult[];
}

function declaresFileUpload(schema: unknown): boolean {
  const visit = (node: unknown): boolean => {
    if (node === null || node === undefined) return false;
    if (Array.isArray(node)) return node.some(visit);
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (record["contentMediaType"] === "application/octet-stream") return true;
      const format = record["format"];
      if (
        format === "binary" ||
        format === "binary/octet-stream" ||
        format === "octet-stream"
      ) {
        return true;
      }
      return Object.values(record).some(visit);
    }
    return false;
  };
  return visit(schema);
}

export async function runWorkflow(
  def: WorkflowDef,
  userArgs: Record<string, unknown>,
  deps: RunWorkflowDeps,
): Promise<RunWorkflowResult> {
  for (const step of def.steps) {
    for (const key of step.ask ?? []) {
      if (!(key in userArgs) || userArgs[key] === undefined || userArgs[key] === "") {
        throw new Error(
          `[workflows.${def.name}] step ${step.id}: ask "${key}" is required but missing from workflow input`,
        );
      }
    }
  }

  const outputs: Record<string, unknown> = {};
  const stepsCtx: Record<string, { output: unknown }> = {};
  const completedIds = new Set<string>();
  const transcript: StepResult[] = [];

  for (let index = 0; index < def.steps.length; index += 1) {
    const step = def.steps[index]!;
    if (deps.denied?.has(step.tool)) {
      throw new Error(
        `[workflows.${def.name}] step ${step.id}: tool "${step.tool}" is disabled by config (workflows.${def.name}.steps.${step.id})`,
      );
    }

    if (deps.multipart?.has(step.tool) && !isUploadTool(step.tool)) {
      throw new Error(
        `[workflows.${def.name}] step ${step.id}: tool "${step.tool}" is a multipart/form-data operation; file uploads are not supported in v1`,
      );
    }

    validateRefs(step.input ?? {}, completedIds, step.id);
    const resolved = resolveValue(step.input ?? {}, {
      user: userArgs,
      steps: stepsCtx,
    }) as Record<string, unknown>;

    const schemaEntry = deps.toolSchemas.get(step.tool);
    if (schemaEntry?.inputSchema === undefined || schemaEntry.inputSchema === null) {
      throw new Error(
        `[workflows.${def.name}] step ${step.id}: no input schema discovered for tool "${step.tool}" — cannot validate step input`,
      );
    }
    if (declaresFileUpload(schemaEntry.inputSchema) && !isUploadTool(step.tool)) {
      throw new Error(
        `[workflows.${def.name}] step ${step.id}: tool "${step.tool}" uses file upload (multipart) which is not supported in v1`,
      );
    }
    const validator = fromJsonSchema(
      schemaEntry.inputSchema as Record<string, unknown>,
    );
    const validated = await validator["~standard"].validate(resolved);
    if ("issues" in validated && Array.isArray(validated.issues) && validated.issues.length > 0) {
      const issues = validated.issues
        .map((issue: { message: string }) => issue.message)
        .join("; ");
      throw new Error(
        `[workflows.${def.name}] step ${step.id}: invalid input for tool "${step.tool}": ${issues}`,
      );
    }

    try {
      const output = await deps.callTool(step.tool, resolved);
      transcript.push({ id: step.id, tool: step.tool, input: resolved, output });
      outputs[step.id] = output;
      stepsCtx[step.id] = { output };
      completedIds.add(step.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transcript.push({
        id: step.id,
        tool: step.tool,
        input: resolved,
        error: message,
      });
      const payload = {
        failedStepId: step.id,
        stepIndex: index,
        tool: step.tool,
        input: resolved,
        error: message,
        priorOutputs: { ...outputs },
      };
      throw new Error(
        `[workflows.${def.name}] step ${step.id} (${step.tool}) failed: ${message} — transcript ${JSON.stringify(payload)}`,
      );
    }
  }

  return { outputs, transcript };
}
