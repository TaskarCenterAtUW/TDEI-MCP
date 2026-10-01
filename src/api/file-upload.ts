import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { authManager } from "../auth/auth-manager.js";
import { config } from "../config.js";
import { jsonResult } from "../mcp/responses.js";

interface UploadEndpoint {
  path: string;
  method?: "POST" | "PUT";
  files: readonly string[];
  optionalFiles?: readonly string[];
  fields?: readonly string[];
  query?: readonly string[];
}
const DATASET_UPLOAD = {
  files: ["dataset", "metadata"], optionalFiles: ["changeset"], query: ["derived_from_dataset_id"],
} as const;
const UPLOADS = {
  uploadOswFile: { path: "/api/v1/osw/upload/{tdei_project_group_id}/{tdei_service_id}", ...DATASET_UPLOAD },
  uploadGtfsFlexFile: { path: "/api/v1/gtfs-flex/upload/{tdei_project_group_id}/{tdei_service_id}", ...DATASET_UPLOAD },
  uploadGtfsPathwaysFile: { path: "/api/v1/gtfs-pathways/upload/{tdei_project_group_id}/{tdei_service_id}", ...DATASET_UPLOAD },
  validateOswFile: { path: "/api/v1/osw/validate", files: ["dataset"] },
  validateGtfsFlexFile: { path: "/api/v1/gtfs-flex/validate", files: ["dataset"] },
  validateGtfsPathwaysFile: { path: "/api/v1/gtfs-pathways/validate", files: ["dataset"] },
  sanitizeOswFile: { path: "/api/v1/osw/sanitize", files: ["dataset"] },
  editMetadata: { path: "/api/v1/metadata/{tdei_dataset_id}", method: "PUT", files: ["file"] },
  cloneDataset: { path: "/api/v1/dataset/clone/{tdei_dataset_id}/{tdei_project_group_id}/{tdei_service_id}", files: ["file"] },
  oswOnDemandFormat: { path: "/api/v1/osw/convert", files: ["file"], fields: ["source_format", "target_format"] },
  oswConfidenceCalculate: { path: "/api/v1/osw/confidence/{tdei_dataset_id}", files: [], optionalFiles: ["file"] },
  oswQualityCalculate: { path: "/api/v1/osw/quality-metric/ixn/{tdei_dataset_id}", files: [], optionalFiles: ["file"] },
  qualityMetricTag: { path: "/api/v1/osw/quality-metric/tag/{tdei_dataset_id}", files: ["file"] },
} satisfies Record<string, UploadEndpoint>;

export function isUploadTool(name: string): name is keyof typeof UPLOADS {
  return Object.hasOwn(UPLOADS, name);
}

export function uploadFileFields(name: keyof typeof UPLOADS): readonly string[] {
  const endpoint: UploadEndpoint = UPLOADS[name];
  return [...endpoint.files, ...(endpoint.optionalFiles ?? [])];
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".zip": return "application/zip";
    case ".json": return "application/json";
    case ".geojson": return "application/geo+json";
    case ".osm": case ".osc": case ".xml": return "application/xml";
    default: return "application/octet-stream";
  }
}

export async function uploadFiles(name: keyof typeof UPLOADS, args: Record<string, unknown>) {
  const endpoint: UploadEndpoint = UPLOADS[name];
  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = args[key];
    if (typeof value !== "string" || !/^[A-Za-z0-9-]+$/.test(value)) throw new Error(`${key} must be a non-empty identifier`);
    return encodeURIComponent(value);
  });
  const url = new URL(path, `${config.apiUrl}/`);
  for (const key of endpoint.query ?? []) {
    if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
  }
  const form = new FormData();
  for (const key of uploadFileFields(name)) {
    const value = args[key];
    if (value === undefined && !endpoint.files.includes(key)) continue;
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${key} must be an absolute local file path on the MCP connector host`);
    try {
      if (!(await stat(value)).isFile()) throw new Error("not a regular file");
      form.append(key, await openAsBlob(value, { type: mimeType(value) }), basename(value));
    } catch {
      throw new Error(`${key} must point to a readable regular file on the MCP connector host`);
    }
  }
  for (const key of endpoint.fields ?? []) {
    const value = args[key];
    if (value !== "osw" && value !== "osm") throw new Error(`${key} must be osw or osm`);
    form.append(key, value);
  }
  if (name === "oswOnDemandFormat" && args.source_format === args.target_format) throw new Error("source_format and target_format must differ");

  const token = await authManager.getAccessToken();
  const response = await fetch(url, {
    method: endpoint.method ?? "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/plain, application/text" },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`TDEI ${name} upload failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const result: unknown = text && (contentType.includes("application/json") || contentType.includes("+json"))
    ? JSON.parse(text) : text || null;
  const data = { status: response.status, result, location: response.headers.get("location") };
  return { ...jsonResult(data), structuredContent: data };
}
