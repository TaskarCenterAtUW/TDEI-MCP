import type { TemplateContext } from "./types.js";

const REF_PATTERN = /{{\s*(.*?)\s*}}/g;
const EXACT_REF_PATTERN = /^\s*{{\s*(.*?)\s*}}\s*$/;
const MAX_REF_DEPTH = 5;

export function getPath(obj: unknown, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolveRef(ref: string, ctx: TemplateContext): unknown {
  const trimmed = ref.trim();
  const parts = trimmed.split(".").map((p) => p.trim());
  if (parts.length > MAX_REF_DEPTH) {
    throw new Error(
      `template ref "{{${trimmed}}}" exceeds max depth of ${MAX_REF_DEPTH}`,
    );
  }
  if (parts[0] === "user") {
    if (parts.length < 2 || !parts[1]) {
      throw new Error(
        `invalid template ref "{{${trimmed}}}": expected {{user.<key>}}`,
      );
    }
    const value = getPath(ctx.user, parts.slice(1));
    if (value === undefined) {
      throw new Error(`unknown template ref "{{${trimmed}}}"`);
    }
    return value;
  }
  if (parts[0] === "steps") {
    if (parts.length < 3 || !parts[1] || parts[2] !== "output") {
      throw new Error(
        `invalid template ref "{{${trimmed}}}": expected {{steps.<id>.output[.<path>]}}`,
      );
    }
    const entry = ctx.steps[parts[1]];
    if (entry === undefined) {
      throw new Error(`unknown template ref "{{${trimmed}}}"`);
    }
    if (parts.length === 3) return entry.output;
    const value = getPath(entry.output, parts.slice(3));
    if (value === undefined) {
      throw new Error(`unknown template ref "{{${trimmed}}}"`);
    }
    return value;
  }
  throw new Error(
    `invalid template ref "{{${trimmed}}}": must be {{user.*}} or {{steps.<id>.output...}}`,
  );
}

export function collectRefs(value: unknown): string[] {
  const refs: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      REF_PATTERN.lastIndex = 0;
      for (const match of node.matchAll(REF_PATTERN)) {
        refs.push((match[1] ?? "").trim());
      }
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else if (node !== null && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) visit(v);
    }
  };
  visit(value);
  return refs;
}

export function validateRefs(
  value: unknown,
  knownStepIds: Set<string> | string[] | Record<string, unknown>,
  stepId: string,
): void {
  const known: Set<string> =
    knownStepIds instanceof Set
      ? knownStepIds
      : Array.isArray(knownStepIds)
        ? new Set(knownStepIds)
        : new Set(Object.keys(knownStepIds));
  for (const ref of collectRefs(value)) {
    if (!ref) {
      throw new Error(
        `invalid template ref in step "${stepId}": empty {{}} expression`,
      );
    }
    const parts = ref.split(".").map((p) => p.trim());
    if (parts[0] !== "user" && parts[0] !== "steps") {
      throw new Error(
        `invalid template ref "{{${ref}}}" in step "${stepId}": must be {{user.*}} or {{steps.<id>.output...}}`,
      );
    }
    if (parts.length > MAX_REF_DEPTH) {
      throw new Error(
        `template ref "{{${ref}}}" in step "${stepId}" exceeds max depth of ${MAX_REF_DEPTH}`,
      );
    }
    if (parts[0] === "user") {
      if (parts.length < 2 || !parts[1]) {
        throw new Error(
          `invalid template ref "{{${ref}}}" in step "${stepId}": expected {{user.<key>}}`,
        );
      }
      continue;
    }
    if (parts.length < 3 || !parts[1] || parts[2] !== "output") {
      throw new Error(
        `invalid template ref "{{${ref}}}" in step "${stepId}": expected {{steps.<id>.output[.<path>]}}`,
      );
    }
    if (!known.has(parts[1])) {
      throw new Error(
        `unknown or forward step ref "{{${ref}}}" in step "${stepId}": step "${parts[1]}" has no output yet`,
      );
    }
  }
}

export function resolveValue(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") {
    REF_PATTERN.lastIndex = 0;
    const matches = [...value.matchAll(REF_PATTERN)];
    if (matches.length === 0) return value;
    const exact = value.match(EXACT_REF_PATTERN);
    if (exact && matches.length === 1) {
      return resolveRef(exact[1] ?? "", ctx);
    }
    return value.replace(REF_PATTERN, (_whole, inner: string) => {
      const resolved = resolveRef((inner ?? "").trim(), ctx);
      if (typeof resolved === "string") return resolved;
      return String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, ctx);
    }
    return out;
  }
  return value;
}
