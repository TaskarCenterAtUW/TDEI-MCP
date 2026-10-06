import { tryParseTdeiJson } from "./parse-tdei-json.js";
import { recordsFrom } from "./tdei-records.js";

export type TdeiGetResponseKind = "records" | "object" | "empty" | "text";

/**
 * Normalized GET body for MCP consumers.
 * - `records`: list endpoints (top-level array or known envelope)
 * - `object`: metrics / capabilities / metadata objects (preserved whole)
 * - `body`: full parsed JSON (or original text) so LLMs can present the API truth
 */
export interface ParsedTdeiGetResponse {
  kind: TdeiGetResponseKind;
  body: unknown;
  records: Array<Record<string, unknown>>;
  envelopeKey?: string;
}

const LIST_ENVELOPE_KEYS = [
  "data",
  "datasets",
  "results",
  "records",
  "items",
  "services",
  "project_groups",
  "projectGroups",
  "versions",
  "jobs",
  "feedbacks",
] as const;

/**
 * Parse a TDEI GET response body and classify it without discarding API data.
 * List callers use `.records`; object GETs use `.body` as-is.
 */
export function parseTdeiGetResponse(input: unknown): ParsedTdeiGetResponse {
  let body: unknown = input;
  if (typeof body === "string") {
    const parsed = tryParseTdeiJson(body);
    if (typeof parsed === "string") {
      const trimmed = parsed.trim();
      return {
        kind: trimmed ? "text" : "empty",
        body: parsed,
        records: [],
      };
    }
    body = parsed;
  }

  if (body === null || body === undefined || body === "") {
    return { kind: "empty", body, records: [] };
  }

  if (Array.isArray(body)) {
    const records = recordsFrom(body);
    return {
      kind: "records",
      body,
      records,
    };
  }

  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    const envelopeKey = detectEnvelopeKey(record);
    if (envelopeKey) {
      return {
        kind: "records",
        body,
        records: recordsFrom(body),
        envelopeKey,
      };
    }
    return {
      kind: "object",
      body,
      records: [],
    };
  }

  return { kind: "text", body, records: [] };
}

function detectEnvelopeKey(record: Record<string, unknown>): string | undefined {
  let emptyKey: string | undefined;
  for (const key of LIST_ENVELOPE_KEYS) {
    if (!Array.isArray(record[key])) continue;
    const rows = recordsFrom({ [key]: record[key] });
    if (rows.length > 0) return key;
    emptyKey ??= key;
  }
  if (emptyKey) return emptyKey;

  const arrayEntries = Object.entries(record).filter(([, value]) => Array.isArray(value));
  if (arrayEntries.length === 1) return arrayEntries[0]![0];
  return undefined;
}
