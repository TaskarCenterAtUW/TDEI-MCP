import type { WorkflowDef } from "../config-file.js";
import { isUploadTool } from "../api/file-upload.js";
import { CONNECTOR_AUTH_TOOLS } from "../config-file.js";
import { validateRefs } from "./template.js";

export interface WorkflowValidationDeps {
  /** Every discovered, non-connector-auth operation (schemas are sanitized). */
  toolSchemas: Map<string, unknown>;
  /** Operations switched off by endpoints allow/deny. */
  denied: Set<string>;
  /** operationIds whose request body is multipart/form-data (from the spec). */
  multipart?: Set<string>;
  configPath: string;
}

/**
 * Static check of a workflow against the *effective* tool catalogue.
 * Throws one Error listing every problem, each with its JSON path.
 */
export function validateWorkflow(def: WorkflowDef, deps: WorkflowValidationDeps): void {
  const problems: string[] = [];
  const askKeys = new Set(def.steps.flatMap((s) => s.ask ?? []));
  const done = new Set<string>();

  for (const step of def.steps) {
    const at = `workflows.${def.name}.steps.${step.id}`;
    if (CONNECTOR_AUTH_TOOLS.has(step.tool)) {
      problems.push(`${at}.tool "${step.tool}" is a connector-managed auth operation and cannot be used in workflows`);
    } else if (!deps.toolSchemas.has(step.tool)) {
      problems.push(`${at}.tool "${step.tool}" is not present: no such operationId in the discovered API tools`);
    } else if (deps.denied.has(step.tool)) {
      problems.push(`${at}.tool "${step.tool}" is not present: disabled by endpoints config`);
    } else if (deps.multipart?.has(step.tool) && !isUploadTool(step.tool)) {
      problems.push(`${at}.tool "${step.tool}" is a multipart/form-data operation; file uploads are not supported in workflows (v1)`);
    }

    try {
      validateRefs(step.input ?? {}, done, step.id);
    } catch (error) {
      problems.push(`${at}.input: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const ref of collectUserKeys(step.input ?? {})) {
      if (!askKeys.has(ref)) {
        problems.push(`${at}.input: {{user.${ref}}} is not declared in any step's "ask" list`);
      }
    }
    done.add(step.id);
  }

  if (problems.length > 0) {
    throw new Error(`[tdei-config] workflow "${def.name}" rejected in ${deps.configPath}: ${problems.join("; ")}`);
  }
}

function collectUserKeys(value: unknown): string[] {
  const keys: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const m of node.matchAll(/{{\s*user\.([^.}\s]+)[^}]*}}/g)) keys.push(m[1]!);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return keys;
}
