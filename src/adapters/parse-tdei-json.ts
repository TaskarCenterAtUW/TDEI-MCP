/**
 * Robust JSON parsing for TDEI HTTP / MCP text payloads.
 * Handles BOM, markdown fences, double-encoded JSON strings, and
 * JSON embedded in short plain-text wrappers.
 */
export function parseTdeiJson(input: string): unknown {
  const trimmed = normalizeJsonText(input);
  if (!trimmed) {
    throw new Error("TDEI upstream returned an empty response body.");
  }

  const direct = tryParseJson(trimmed);
  if (direct.ok) return unwrapDoubleEncoded(direct.value);

  const fenced = stripMarkdownFence(trimmed);
  if (fenced !== trimmed) {
    const fromFence = tryParseJson(fenced);
    if (fromFence.ok) return unwrapDoubleEncoded(fromFence.value);
  }

  const embedded = extractEmbeddedJson(trimmed);
  if (embedded !== undefined) return unwrapDoubleEncoded(embedded);

  const snippet = trimmed.replace(/\s+/g, " ").slice(0, 200);
  throw new Error(`TDEI upstream returned non-JSON response: ${snippet}`);
}

/** Best-effort parse that returns the original string on failure. */
export function tryParseTdeiJson(input: string): unknown {
  try {
    return parseTdeiJson(input);
  } catch {
    return input;
  }
}

function normalizeJsonText(input: string): string {
  return input.replace(/^\uFEFF/, "").trim();
}

function stripMarkdownFence(text: string): string {
  const match = /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1]?.trim() ?? text;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function unwrapDoubleEncoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const inner = normalizeJsonText(value);
  if (!(inner.startsWith("{") || inner.startsWith("["))) return value;
  const nested = tryParseJson(inner);
  return nested.ok ? nested.value : value;
}

function extractEmbeddedJson(text: string): unknown | undefined {
  const startObject = text.indexOf("{");
  const startArray = text.indexOf("[");
  let start = -1;
  let open: "{" | "[" | undefined;
  if (startObject >= 0 && (startArray < 0 || startObject < startArray)) {
    start = startObject;
    open = "{";
  } else if (startArray >= 0) {
    start = startArray;
    open = "[";
  }
  if (start < 0 || !open) return undefined;

  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (character === "\\") {
        escape = true;
        continue;
      }
      if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === open) {
      depth += 1;
      continue;
    }
    if (character === close) {
      depth -= 1;
      if (depth === 0) {
        const parsed = tryParseJson(text.slice(start, index + 1));
        return parsed.ok ? parsed.value : undefined;
      }
    }
  }
  return undefined;
}
