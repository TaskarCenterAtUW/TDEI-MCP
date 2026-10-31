import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

import type { TdeiOperations } from "../intents/operations.js";
import type { AcceptedJob, DatasetAsset, RequestContext } from "../intents/types.js";
import { TdeiHttpError } from "./tdei-http-error.js";

type DatasetMutations = Required<Pick<TdeiOperations, "validateDataset" | "uploadDataset">>;

export const ALLOWED_UPLOAD_EXTENSIONS = new Set([".zip", ".json", ".geojson", ".osm", ".osc", ".xml"]);

export type MultipartFieldValue = string | DatasetAsset | { json: unknown; filename: string };

async function fieldToFormValue(
  value: MultipartFieldValue,
  fileFromAsset: (asset: DatasetAsset) => Promise<{ file: Blob; name: string }>,
): Promise<{ value: string | Blob; filename?: string }> {
  if (typeof value === "string") return { value };
  if ("json" in value) {
    return {
      value: new Blob([JSON.stringify(value.json)], { type: "application/json" }),
      filename: value.filename,
    };
  }
  const file = await fileFromAsset(value);
  return { value: file.file, filename: file.name };
}

export interface DirectMultipartOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
  allowedAssetKinds: ReadonlySet<DatasetAsset["kind"]>;
  timeoutMs?: number;
  maxRetries?: number;
}

const RETRYABLE_UPLOAD_STATUSES = new Set([408, 429, 502, 503, 504]);

export class DirectMultipartTdeiMutations implements DatasetMutations {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: DirectMultipartOptions) {
    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
  }

  async validateDataset(
    input: Parameters<DatasetMutations["validateDataset"]>[0],
    context: RequestContext,
  ): Promise<AcceptedJob> {
    return this.post(
      `api/v1/${this.dataTypePath(input.dataType)}/validate`,
      async () => {
        const form = new FormData();
        const dataset = await this.fileFromAsset(input.asset);
        form.set("dataset", dataset.file, dataset.name);
        return form;
      },
      context,
    );
  }

  async uploadDataset(
    input: Parameters<DatasetMutations["uploadDataset"]>[0],
    context: RequestContext,
  ): Promise<AcceptedJob> {
    const params = new URLSearchParams();
    if (input.derivedFromDatasetId) {
      params.set("derived_from_dataset_id", input.derivedFromDatasetId);
    }
    return this.post(
      `api/v1/${this.dataTypePath(input.dataType)}/upload/${encodeURIComponent(input.projectGroupId)}/${encodeURIComponent(input.serviceId)}`,
      async () => {
        const form = new FormData();
        const dataset = await this.fileFromAsset(input.asset);
        form.set("dataset", dataset.file, dataset.name);
        form.set(
          "metadata",
          new File([JSON.stringify(input.metadata)], "metadata.json", {
            type: "application/json",
          }),
        );
        if (input.changeset) {
          const changeset = await this.fileFromAsset(input.changeset);
          form.set("changeset", changeset.file, changeset.name);
        }
        return form;
      },
      context,
      params,
    );
  }

  /** Generic multipart POST for job/file ops beyond validate+upload. Returns parsed JSON or raw text. */
  async postForm(
    path: string,
    fields: Record<string, MultipartFieldValue>,
    context: RequestContext,
    params = new URLSearchParams(),
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const form = new FormData();
    for (const [name, fieldValue] of Object.entries(fields)) {
      const { value, filename } = await fieldToFormValue(fieldValue, (asset) => this.fileFromAsset(asset));
      if (typeof value === "string") form.set(name, value);
      else form.set(name, value, filename ?? name);
    }
    const bearer = await this.token(context);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, application/text",
        Authorization: `Bearer ${bearer}`,
      },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      let body: unknown = text;
      try {
        body = JSON.parse(text) as unknown;
      } catch {}
      throw new TdeiHttpError(`TDEI request failed with status ${response.status} for ${path}.`, response.status, body);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async fileFromAsset(asset: DatasetAsset): Promise<{ file: Blob; name: string }> {
    if (!this.options.allowedAssetKinds.has(asset.kind)) {
      throw new Error(
        `MCP never accepts file bytes. Run the bytes via curl from the client machine (single hop, any size): curl -X POST "<apiUrl>/api/v1/{osw|gtfs-flex|gtfs-pathways}/validate" -H "Authorization: Bearer <SSO bearer from tdei_sso_login>" -F "dataset=@/path/to/file.zip". Then poll with tdei_list_jobs. Do not retry bytes through MCP.`,
      );
    }
    if (asset.kind === "local_path") {
      if (!isAbsolute(asset.path)) {
        throw new Error("Dataset local_path must be an absolute path on the MCP connector host.");
      }
      const resolvedName = asset.name ?? basename(asset.path);
      assertAllowedExtension(asset.path);
      if (asset.name) assertAllowedExtension(asset.name);
      let fileStat;
      try {
        fileStat = await stat(asset.path);
        if (!fileStat.isFile()) throw new Error("not a regular file");
      } catch {
        throw new Error("Dataset local_path must point to a readable regular file on the MCP connector host.");
      }
      if (fileStat.size === 0) {
        throw new Error(`Dataset file "${resolvedName}" is empty (0 bytes).`);
      }
      return {
        file: await openAsBlob(asset.path, { type: mimeType(asset.path) }),
        name: resolvedName,
      };
    }
    throw new Error(
      "Object-reference dataset assets require an object-store adapter. For any file size, run bytes via curl from the client machine, then poll with tdei_list_jobs.",
    );
  }

  private async token(context: RequestContext): Promise<string> {
    if (context.accessToken) return context.accessToken;
    if (this.options.tokenProvider) return this.options.tokenProvider();
    throw new Error("TDEI_SSO_REQUIRED");
  }

  private async post(
    path: string,
    buildForm: () => Promise<FormData>,
    context: RequestContext,
    params = new URLSearchParams(),
  ): Promise<AcceptedJob> {
    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const totalAttempts = this.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const form = await buildForm();
      const bearer = await this.token(context);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, application/text",
            Authorization: `Bearer ${bearer}`,
          },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt < totalAttempts && isRetryableNetworkError(error)) {
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`TDEI multipart upload failed after ${attempt} attempt(s) for ${path}: ${reason}`, {
          cause: error,
        });
      }

      const text = await response.text();
      if (!response.ok) {
        let body: unknown = text;
        try {
          body = JSON.parse(text) as unknown;
        } catch {}
        const httpError = new TdeiHttpError(
          `TDEI request failed with status ${response.status} (attempt ${attempt}/${totalAttempts}).`,
          response.status,
          body,
        );
        lastError = httpError;
        if (attempt < totalAttempts && RETRYABLE_UPLOAD_STATUSES.has(response.status)) {
          continue;
        }
        throw httpError;
      }
      const jobId = parseJobId(text);
      const location = response.headers.get("Location");
      return { jobId, ...(location ? { location } : {}) };
    }

    throw lastError instanceof Error ? lastError : new Error(`TDEI multipart upload failed for ${path}.`);
  }

  private dataTypePath(dataType: "osw" | "flex" | "pathways"): string {
    if (dataType === "flex") return "gtfs-flex";
    if (dataType === "pathways") return "gtfs-pathways";
    return "osw";
  }
}

function assertAllowedExtension(filePathOrName: string): void {
  const ext = extname(filePathOrName).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported dataset file extension "${ext || "(none)"}" for "${basename(filePathOrName)}". Allowed extensions: ${[...ALLOWED_UPLOAD_EXTENSIONS].join(", ")}.`,
    );
  }
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket|stream/i.test(error.message);
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".zip":
      return "application/zip";
    case ".json":
      return "application/json";
    case ".geojson":
      return "application/geo+json";
    case ".osm":
    case ".osc":
    case ".xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

function parseJobId(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["jobId", "job_id", "id"]) {
        if (typeof record[key] === "string") return record[key];
      }
    }
  } catch {}
  return text.trim();
}
