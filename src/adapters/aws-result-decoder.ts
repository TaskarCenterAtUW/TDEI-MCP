const RECORD_KEYS = [
  "data",
  "datasets",
  "results",
  "records",
  "items",
  "services",
] as const;

function objectRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export function decodeAwsRecords(payload: unknown): Array<Record<string, unknown>> {
  let value = payload;
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const text = content.find(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )?.text;
    if (text === undefined) return [];
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("AWS MCP operation returned non-JSON text content.");
    }
  }

  if (Array.isArray(value)) return objectRecords(value);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  for (const key of RECORD_KEYS) {
    const records = objectRecords(record[key]);
    if (records.length > 0 || Array.isArray(record[key])) return records;
  }
  return [];
}
