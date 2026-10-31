import { tryParseTdeiJson } from "./parse-tdei-json.js";

const RECORD_KEYS = [
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

function objectRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/**
 * Extract object-row arrays from TDEI list responses.
 * Accepts raw arrays, known envelopes, a sole array property, and JSON text.
 * Prefers non-empty arrays when multiple envelope keys are present.
 */
export function recordsFrom(value: unknown): Array<Record<string, unknown>> {
  let current: unknown = value;
  if (typeof current === "string") {
    current = tryParseTdeiJson(current);
    if (typeof current === "string") return [];
  }

  if (Array.isArray(current)) return objectRecords(current);
  if (typeof current !== "object" || current === null) return [];

  const record = current as Record<string, unknown>;
  let emptyMatch: Array<Record<string, unknown>> | undefined;

  for (const key of RECORD_KEYS) {
    if (!Array.isArray(record[key])) continue;
    const rows = objectRecords(record[key]);
    if (rows.length > 0) return rows;
    emptyMatch ??= rows;
  }

  if (emptyMatch) return emptyMatch;

  // Unknown envelope with exactly one array property (e.g. future list keys).
  const arrayEntries = Object.entries(record).filter(([, nested]) => Array.isArray(nested));
  if (arrayEntries.length === 1) {
    return objectRecords(arrayEntries[0]![1]);
  }

  // Pretty human-readable single-object envelope (record-replay fixtures and
  // hand-written API samples): surface the payload with a _kind marker so
  // replay tests can assert the envelope parsed instead of vanishing to [].
  const payload = prettyEnvelopePayload(record);
  if (payload) {
    return [{ _kind: "object-envelope", ...payload }];
  }

  return [];
}

const ENVELOPE_KEYS = new Set(["datasetId", "dataType", "source", "note", "generatedAt", "rowCount"]);

/**
 * Payload of a pretty human-readable single-object envelope (record-replay
 * fixtures and hand-written API samples): no arrays, but carries descriptive
 * envelope keys. Returns undefined when the record is not such an envelope.
 */
export function prettyEnvelopePayload(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.values(record).some((value) => Array.isArray(value))) return undefined;
  const payloadEntries = Object.entries(record).filter(([key]) => !ENVELOPE_KEYS.has(key));
  if (payloadEntries.length === 0 || payloadEntries.length === Object.keys(record).length) return undefined;
  return Object.fromEntries(payloadEntries);
}
