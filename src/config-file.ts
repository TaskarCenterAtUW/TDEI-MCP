import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as z from "zod/v4";

// The AWS OpenAPI server exposes operationIds as tool names with "-" turned
// into "_" (spec "job-download" -> tool job_download). Config accepts either.
export function normalizeOperationId(id: string): string {
  return id.replace(/-/g, "_");
}

export const BUILTIN_TOOL_PREFIX = "tdei_";
export const CONNECTOR_AUTH_TOOLS = new Set([
  "authenticate", "refreshToken", "ssoRedirect", "ssoLogin", "ssoLogout",
]);

const EndpointsSchema = z.object({
  mode: z.enum(["all", "allow", "deny"]).default("all"),
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
});

const WorkflowStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  tool: z.string().min(1),
  ask: z.array(z.string().min(1)).default([]),
  input: z.record(z.string(), z.unknown()).default({}),
});

const WorkflowSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/),
  description: z.string().default(""),
  steps: z.array(WorkflowStepSchema).min(1),
});

const ConfigFileSchema = z.object({
  $schema: z.string().optional(),
  endpoints: EndpointsSchema.default({ mode: "all", allow: [], deny: [] }),
  workflows: z.array(WorkflowSchema).default([]),
}).superRefine((cfg, ctx) => {
  const names = new Map<string, number>();
  cfg.workflows.forEach((w, wi) => {
    const firstName = names.get(w.name);
    if (firstName !== undefined) {
      ctx.addIssue({ code: "custom", path: ["workflows", wi, "name"], message: `duplicate workflow name "${w.name}" (first defined at workflows[${firstName}])` });
    } else {
      names.set(w.name, wi);
    }
    const ids = new Map<string, number>();
    w.steps.forEach((s, si) => {
      const firstId = ids.get(s.id);
      if (firstId !== undefined) {
        ctx.addIssue({ code: "custom", path: ["workflows", wi, "steps", si, "id"], message: `duplicate step id "${s.id}" in workflow "${w.name}" (first defined at steps[${firstId}])` });
      } else {
        ids.set(s.id, si);
      }
    });
  });
});

export interface EndpointFilter { mode: "all" | "allow" | "deny"; allow: string[]; deny: string[]; }
export interface WorkflowStepDef { id: string; tool: string; ask?: string[]; input: Record<string, unknown>; }
export interface WorkflowDef { name: string; description?: string; steps: WorkflowStepDef[]; }
export interface LoadedConfig { path: string; exists: boolean; filter: EndpointFilter; workflows: WorkflowDef[]; warnings: string[]; }

export function defaultConfigJson(schemaRef?: string): string {
  return JSON.stringify(
    { ...(schemaRef ? { $schema: schemaRef } : {}), endpoints: { mode: "all", allow: [], deny: [] }, workflows: [] },
    null, 2,
  ) + "\n";
}

export const DEFAULT_CONFIG_JSON = defaultConfigJson("./tdei.config.schema.json");

export function resolveConfigPath(): string {
  const explicit = process.env.TDEI_CONFIG_PATH?.trim();
  return explicit ? resolve(explicit) : resolve(process.cwd(), "tdei.config.json");
}

function fallback(path: string, exists: boolean, warning: string): LoadedConfig {
  if (warning) console.error(warning);
  return { path, exists, filter: { mode: "all", allow: [], deny: [] }, workflows: [], warnings: warning ? [warning] : [] };
}

export function loadConfigFile(explicitPath?: string): LoadedConfig {
  const path = explicitPath ?? resolveConfigPath();
  if (!existsSync(path)) return { path, exists: false, filter: { mode: "all", allow: [], deny: [] }, workflows: [], warnings: [] };
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { return fallback(path, true, `[tdei-config] cannot read ${path}: ${error instanceof Error ? error.message : String(error)} — using allow-all, no workflows`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { return fallback(path, true, `[tdei-config] invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)} — using allow-all, no workflows`); }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return fallback(path, true, `[tdei-config] schema violation in ${path}: ${issues} — using allow-all, no workflows`);
  }
  const { endpoints, workflows } = result.data;
  if (endpoints.allow.length > 0 && endpoints.deny.length > 0) {
    return fallback(path, true, `[tdei-config] schema violation in ${path}: endpoints.allow and endpoints.deny are mutually exclusive (only one may be non-empty) — using allow-all, no workflows`);
  }
  if (endpoints.mode === "allow" && endpoints.allow.length === 0) {
    return fallback(path, true, `[tdei-config] schema violation in ${path}: endpoints.mode is "allow" but endpoints.allow is empty — using allow-all, no workflows`);
  }
  if (endpoints.mode === "deny" && endpoints.deny.length === 0) {
    return fallback(path, true, `[tdei-config] schema violation in ${path}: endpoints.mode is "deny" but endpoints.deny is empty — using allow-all, no workflows`);
  }
  return {
    path,
    exists: true,
    filter: { mode: endpoints.mode, allow: endpoints.allow.map(normalizeOperationId), deny: endpoints.deny.map(normalizeOperationId) },
    workflows: workflows.map((w) => ({ ...w, steps: w.steps.map((s) => ({ ...s, tool: normalizeOperationId(s.tool) })) })) as WorkflowDef[],
    warnings: [],
  };
}

export function ensureDefaultConfig(explicitPath?: string): string {
  const path = explicitPath ?? resolveConfigPath();
  if (existsSync(path)) return path;
  writeFileSync(path, DEFAULT_CONFIG_JSON, "utf8");
  console.error(`[tdei-config] wrote default config to ${path} — edit endpoints/workflows, then restart or call tdei_reload_config`);
  return path;
}

export function isToolAllowed(rawToolName: string, filter: EndpointFilter): boolean {
  const toolName = normalizeOperationId(rawToolName);
  if (toolName.startsWith(BUILTIN_TOOL_PREFIX)) return true;
  if (CONNECTOR_AUTH_TOOLS.has(toolName)) return true;
  if (filter.mode === "all") return true;
  if (filter.mode === "allow") return filter.allow.includes(toolName);
  return !filter.deny.includes(toolName);
}
