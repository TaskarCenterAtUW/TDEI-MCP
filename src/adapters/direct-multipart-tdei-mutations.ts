import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

import type { TdeiOperations } from "../intents/operations.js";
import type {
  AcceptedJob,
  DatasetAsset,
  RequestContext,
} from "../intents/types.js";
import { TdeiHttpError } from "./tdei-http-error.js";

type DatasetMutations = Required<Pick<
  TdeiOperations,
  "validateDataset" | "uploadDataset"
>>;

export interface DirectMultipartOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
  allowedAssetKinds: ReadonlySet<DatasetAsset["kind"]>;
  timeoutMs?: number;
}

export class DirectMultipartTdeiMutations implements DatasetMutations {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: DirectMultipartOptions) {
    this.baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : `${options.baseUrl}/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async validateDataset(
    input: Parameters<DatasetMutations["validateDataset"]>[0],
    context: RequestContext,
  ): Promise<AcceptedJob> {
    const form = new FormData();
    const dataset = await this.fileFromAsset(input.asset);
    form.set("dataset", dataset.file, dataset.name);
    return this.post(
      `api/v1/${this.dataTypePath(input.dataType)}/validate`,
      form,
      context,
    );
  }

  async uploadDataset(
    input: Parameters<DatasetMutations["uploadDataset"]>[0],
    context: RequestContext,
  ): Promise<AcceptedJob> {
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
    const params = new URLSearchParams();
    if (input.derivedFromDatasetId) {
      params.set("derived_from_dataset_id", input.derivedFromDatasetId);
    }
    return this.post(
      `api/v1/${this.dataTypePath(input.dataType)}/upload/${encodeURIComponent(input.projectGroupId)}/${encodeURIComponent(input.serviceId)}`,
      form,
      context,
      params,
    );
  }

  private async fileFromAsset(asset: DatasetAsset): Promise<{ file: Blob; name: string }> {
    if (!this.options.allowedAssetKinds.has(asset.kind)) {
      const accepted = [...this.options.allowedAssetKinds].join(" or ");
      throw new Error(`This transport accepts only ${accepted} dataset assets.`);
    }
    if (asset.kind === "local_path") {
      if (!isAbsolute(asset.path)) {
        throw new Error("Dataset local_path must be an absolute path on the MCP connector host.");
      }
      try {
        if (!(await stat(asset.path)).isFile()) throw new Error("not a regular file");
        return {
          file: await openAsBlob(asset.path, { type: mimeType(asset.path) }),
          name: asset.name ?? basename(asset.path),
        };
      } catch {
        throw new Error("Dataset local_path must point to a readable regular file on the MCP connector host.");
      }
    }
    if (asset.kind === "inline_base64") {
      const bytes = Buffer.from(asset.data, "base64");
      if (bytes.byteLength > 10 * 1024 * 1024) {
        throw new Error("Inline dataset assets are limited to 10MB.");
      }
      return {
        file: new Blob([bytes], { type: asset.mediaType }),
        name: asset.name,
      };
    }
    throw new Error("Object-reference dataset assets require an object-store adapter.");
  }

  private async token(context: RequestContext): Promise<string> {
    if (context.accessToken) return context.accessToken;
    if (this.options.tokenProvider) return this.options.tokenProvider();
    throw new Error("TDEI_SSO_REQUIRED");
  }

  private async post(
    path: string,
    form: FormData,
    context: RequestContext,
    params = new URLSearchParams(),
  ): Promise<AcceptedJob> {
    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, application/text",
        Authorization: `Bearer ${await this.token(context)}`,
      },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      let body: unknown = text;
      try { body = JSON.parse(text) as unknown; } catch {}
      throw new TdeiHttpError(
        `TDEI request failed with status ${response.status}.`,
        response.status,
        body,
      );
    }
    const jobId = parseJobId(text);
    const location = response.headers.get("Location");
    return { jobId, ...(location ? { location } : {}) };
  }

  private dataTypePath(dataType: "osw" | "flex" | "pathways"): string {
    if (dataType === "flex") return "gtfs-flex";
    if (dataType === "pathways") return "gtfs-pathways";
    return "osw";
  }
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".zip": return "application/zip";
    case ".json": return "application/json";
    case ".geojson": return "application/geo+json";
    case ".osm":
    case ".osc":
    case ".xml": return "application/xml";
    default: return "application/octet-stream";
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
