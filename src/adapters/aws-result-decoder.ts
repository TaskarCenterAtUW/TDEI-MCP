import { parseTdeiJson } from "./parse-tdei-json.js";
import { parseTdeiGetResponse, type ParsedTdeiGetResponse } from "./tdei-get-response.js";

export function unwrapMcpPayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    return parseTdeiJson(payload);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }

  const record = payload as Record<string, unknown>;

  if (Array.isArray(record.content)) {
    const textBlocks = record.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);

    for (const text of textBlocks) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      try {
        return parseTdeiJson(trimmed);
      } catch {
        // Try the next text block; only fail after all candidates are exhausted.
      }
    }

    if (textBlocks.some((text) => text.trim())) {
      const snippet = textBlocks.map((text) => text.trim()).find(Boolean) ?? "";
      throw new Error(
        `TDEI upstream returned non-JSON response: ${snippet.replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }

    if (textBlocks.length > 0) return [];
  }

  if (record.structuredContent !== undefined) {
    const structured = record.structuredContent;
    return typeof structured === "string" ? parseTdeiJson(structured) : structured;
  }

  return payload;
}

/** Full GET classification — use for object and list responses. */
export function decodeAwsJson(payload: unknown): ParsedTdeiGetResponse {
  return parseTdeiGetResponse(unwrapMcpPayload(payload));
}

/** List-row extraction for array / envelope GET endpoints. */
export function decodeAwsRecords(payload: unknown): Array<Record<string, unknown>> {
  return decodeAwsJson(payload).records;
}

export type NormalizedMcpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textContentFrom(result: unknown): Array<{ type: "text"; text: string }> {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const blocks = (result as { content: Array<Record<string, unknown>> }).content.flatMap((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return [];
      const trimmed = block.text.trim();
      if (!trimmed) return [{ type: "text" as const, text: block.text }];
      try {
        return [{ type: "text" as const, text: JSON.stringify(parseTdeiJson(trimmed), null, 2) }];
      } catch {
        return [{ type: "text" as const, text: block.text }];
      }
    });
    if (blocks.length > 0) return blocks;
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

/**
 * Normalize an AWS MCP tool result so JSON GET bodies stay valid API JSON
 * (unwrap fences / double-encoding) without inventing empty lists for objects.
 */
export function normalizeAwsToolResult(result: unknown): NormalizedMcpToolResult {
  const content = textContentFrom(result);
  const isError =
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    (result as { isError?: unknown }).isError === true;
  return isError ? { content, isError: true } : { content };
}
