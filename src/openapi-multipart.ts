// Finds operations whose request body is multipart/form-data in the OpenAPI
// spec the connector already uses (TDEI_SPEC_URL). This is authoritative;
// guessing from the generated MCP tool schema is not (file fields are
// rendered differently by the AWS child depending on the spec version).

type Json = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function multipartOperationIds(spec: unknown): Set<string> {
  const ids = new Set<string>();
  const paths = (spec as Json | null)?.["paths"];
  if (!paths || typeof paths !== "object") return ids;
  for (const item of Object.values(paths as Json)) {
    if (!item || typeof item !== "object") continue;
    const shared = (item as Json)["parameters"];
    for (const method of METHODS) {
      const op = (item as Json)[method] as Json | undefined;
      const operationId = op?.["operationId"];
      if (!op || typeof operationId !== "string") continue;
      const content = (op["requestBody"] as Json | undefined)?.["content"];
      const consumes = op["consumes"];
      const params = [
        ...(Array.isArray(shared) ? shared : []),
        ...(Array.isArray(op["parameters"]) ? (op["parameters"] as unknown[]) : []),
      ];
      const isMultipart =
        (content && typeof content === "object" && Object.keys(content).some((k) => k.toLowerCase().startsWith("multipart/"))) ||
        (Array.isArray(consumes) && consumes.some((c) => typeof c === "string" && c.toLowerCase().startsWith("multipart/"))) ||
        params.some((p) => (p as Json | null)?.["in"] === "formData");
      if (isMultipart) ids.add(operationId);
    }
  }
  return ids;
}

export async function fetchMultipartOperationIds(
  specUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<Set<string> | undefined> {
  try {
    const res = await fetchFn(specUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return multipartOperationIds(await res.json());
  } catch (error) {
    console.error(
      `[tdei-config] could not read ${specUrl} to detect multipart operations (${error instanceof Error ? error.message : String(error)}) — falling back to schema heuristics`,
    );
    return undefined;
  }
}
