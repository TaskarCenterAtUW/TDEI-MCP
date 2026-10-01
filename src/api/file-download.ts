import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { authManager } from "../auth/auth-manager.js";
import { config } from "../config.js";
import { jsonResult } from "../mcp/responses.js";

const DOWNLOADS = {
  getOswFile: { path: "/api/v1/osw/", id: "tdei_dataset_id", extension: "zip" },
  getGtfsFlexFile: { path: "/api/v1/gtfs-flex/", id: "tdei_dataset_id", extension: "zip" },
  getGtfsPathwaysFile: { path: "/api/v1/gtfs-pathways/", id: "tdei_dataset_id", extension: "zip" },
  job_download: { path: "/api/v1/job/download/", id: "job_id", extension: "bin" },
  oswDatasetViewerFeedbacksDownload: { path: "/api/v1/osw/dataset-viewer/feedbacks/download/", id: "tdei_project_group_id", extension: "csv" },
} as const;

export function isDownloadTool(name: string): name is keyof typeof DOWNLOADS {
  return Object.hasOwn(DOWNLOADS, name);
}

const BINARY_TYPES = ["application/octet-stream", "application/zip", "application/x-zip-compressed"];
const FILE_EXTENSIONS: Record<string, string> = {
  "application/zip": "zip", "application/x-zip-compressed": "zip",
  "text/csv": "csv", "application/geo+json": "geojson", "application/json": "json",
  "text/plain": "txt", "application/pdf": "pdf", "application/xml": "xml", "text/xml": "xml",
};
const FEEDBACK_QUERY = ["tdei_dataset_id", "from_date", "to_date", "status", "sort_by", "due_date", "sort_order", "page_no", "page_size"];

export async function downloadFile(name: keyof typeof DOWNLOADS, args: Record<string, unknown>) {
  const endpoint = DOWNLOADS[name];
  const id = args[endpoint.id];
  if (typeof id !== "string" || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new Error(`${endpoint.id} must be a non-empty identifier`);
  }
  const url = new URL(`${endpoint.path}${encodeURIComponent(id)}`, `${config.apiUrl}/`);
  let format: unknown;
  let extension: string = endpoint.extension;
  if (name === "getOswFile") {
    format = args.format ?? "osw";
    const version = args.file_version ?? "latest";
    if (format !== "osw" && format !== "osm") throw new Error("format must be osw or osm");
    if (version !== "latest") throw new Error("file_version must be latest");
    url.searchParams.set("format", format);
    url.searchParams.set("file_version", version);
  } else if (name === "oswDatasetViewerFeedbacksDownload") {
    format = args.format ?? "csv";
    if (format !== "csv" && format !== "geojson") throw new Error("format must be csv or geojson");
    extension = format;
    url.searchParams.set("format", format);
    for (const key of FEEDBACK_QUERY) {
      if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
    }
  }

  const token = await authManager.getAccessToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: name === "oswDatasetViewerFeedbacksDownload" ? "text/csv, application/geo+json, application/octet-stream" : "application/octet-stream, application/zip" },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`TDEI ${name} download failed: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const allowed = name === "job_download"
    ? [...BINARY_TYPES, ...Object.keys(FILE_EXTENSIONS)]
    : name === "oswDatasetViewerFeedbacksDownload"
      ? [...BINARY_TYPES, format === "csv" ? "text/csv" : "application/geo+json", ...(format === "geojson" ? ["application/json"] : [])]
      : BINARY_TYPES;
  if (!response.body || !contentType || !allowed.includes(contentType)) {
    await response.body?.cancel();
    throw new Error(`TDEI ${name} download returned unexpected content type: ${contentType ?? "missing"}`);
  }
  if (name === "job_download") {
    // Keep only a safe extension from the server filename, never a server path.
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename\s*=\s*"([^"]+)"/i.exec(disposition)?.[1]
      ?? /filename\s*=\s*([^;\s]+)/i.exec(disposition)?.[1];
    extension = filename?.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase()
      ?? FILE_EXTENSIONS[contentType] ?? "bin";
  }

  const directory = resolve(process.env.TDEI_DOWNLOAD_DIR?.trim() || "downloads");
  const stem = `${name}-${id}-${randomUUID()}`;
  const partialPath = join(directory, `${stem}.part`);
  let bytes = 0;
  let prefix = Buffer.alloc(0);
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (prefix.length < 4) prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)]);
      callback(null, chunk);
    },
  });
  let filename: string;
  let path: string;
  try {
    await mkdir(directory, { recursive: true });
    await pipeline(response.body, counter, createWriteStream(partialPath, { flags: "wx", mode: 0o600 }));
    if (bytes === 0) throw new Error(`TDEI ${name} download returned an empty file`);
    // Job outputs can be ZIPs even when the API sends only octet-stream.
    if (name === "job_download" && ["504b0304", "504b0506", "504b0708"].includes(prefix.toString("hex"))) extension = "zip";
    filename = `${stem}.${extension}`;
    path = join(directory, filename);
    await rename(partialPath, path);
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    await rm(partialPath, { force: true });
    throw error;
  }
  const data = { [endpoint.id]: id, ...(format ? { format } : {}), path, filename, contentType, bytes };
  return { ...jsonResult(data), structuredContent: data };
}
