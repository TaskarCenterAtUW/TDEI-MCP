import { basename, extname } from "node:path";

import type { TdeiOperations } from "../intents/operations.js";
import type {
  ClientUploadInstruction,
  DataType,
  DatasetAsset,
  DatasetMetadata,
  RequestContext,
} from "../intents/types.js";
import { TdeiHttpError } from "./tdei-http-error.js";

type DatasetMutations = Required<Pick<TdeiOperations, "validateDataset" | "uploadDataset">>;

export const ALLOWED_UPLOAD_EXTENSIONS = new Set([".zip", ".json", ".geojson", ".osm", ".osc", ".xml"]);

export type MultipartFieldValue = string | DatasetAsset | { json: unknown; filename: string };

async function fieldToFormValue(value: MultipartFieldValue): Promise<{ value: string | Blob; filename?: string }> {
  if (typeof value === "string") return { value };
  if ("json" in value) {
    return {
      value: new Blob([JSON.stringify(value.json)], { type: "application/json" }),
      filename: value.filename,
    };
  }
  throw new Error(
    "MCP never accepts file bytes — run the bytes via curl from the client machine (single hop, any size) with the SSO bearer from tdei_sso_login, then poll with tdei_list_jobs. Do not retry bytes through MCP.",
  );
}

export interface DirectMultipartOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
  timeoutMs?: number;
}

/**
 * Builds client-side curl upload instructions. File bytes never flow through
 * the MCP server: the returned curl command reads the dataset straight from
 * the CLIENT machine and posts it to the TDEI API in a single hop.
 */
export class DirectMultipartTdeiMutations implements DatasetMutations {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokenProvider?: () => Promise<string>;

  constructor(options: DirectMultipartOptions) {
    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (options.tokenProvider !== undefined) this.tokenProvider = options.tokenProvider;
  }

  async validateDataset(
    input: Parameters<DatasetMutations["validateDataset"]>[0],
    context: RequestContext,
  ): Promise<ClientUploadInstruction> {
    const datasetPath = clientAssetPath(input.asset, "asset");
    const path = `api/v1/${this.dataTypePath(input.dataType)}/validate`;
    const url = new URL(path, this.baseUrl).toString();
    const bearer = await this.resolveCurlToken(context);
    const auth = bearer ?? "$TDEI_TOKEN";
    const curlCommand = `curl -X POST "${url}" -H "Authorization: Bearer ${auth}" -F "dataset=@${datasetPath}" -sS --fail-with-body`;
    return {
      dataType: input.dataType,
      datasetPath,
      apiOperation: "validateDataset",
      method: "POST",
      path: `/${path}`,
      curlCommand,
      instruction:
        `MCP server never accepts file bytes and never reads client files: run on the CLIENT machine (any size, single hop): ${curlCommand} ` +
        (bearer
          ? `with the current TDEI SSO session token already embedded (from tdei_sso_login; no $TDEI_TOKEN export needed).`
          : `with $TDEI_TOKEN set to the current TDEI SSO bearer token (sign in via tdei_sso_login first).`) +
        ` Then poll with tdei_list_jobs.`,
    };
  }

  async uploadDataset(
    input: Parameters<DatasetMutations["uploadDataset"]>[0],
    context: RequestContext,
  ): Promise<ClientUploadInstruction> {
    const datasetPath = clientAssetPath(input.asset, "asset");
    const params = new URLSearchParams();
    if (input.derivedFromDatasetId) {
      params.set("derived_from_dataset_id", input.derivedFromDatasetId);
    }
    const path = `api/v1/${this.dataTypePath(input.dataType)}/upload/${encodeURIComponent(input.projectGroupId)}/${encodeURIComponent(input.serviceId)}`;
    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const metadataArg = `-F 'metadata=${shellQuoteJson(input.metadata)};type=application/json'`;
    const changesetArg = input.changeset ? ` -F "changeset=@${clientAssetPath(input.changeset, "changeset")}"` : "";
    const bearer = await this.resolveCurlToken(context);
    const auth = bearer ?? "$TDEI_TOKEN";
    const curlCommand =
      `curl -X POST "${url.toString()}" -H "Authorization: Bearer ${auth}" ` +
      `-F "dataset=@${datasetPath}" ${metadataArg}${changesetArg} -sS --fail-with-body`;
    return {
      dataType: input.dataType,
      datasetPath,
      apiOperation: "uploadDataset",
      method: "POST",
      path: `/${path}`,
      curlCommand,
      instruction:
        `MCP server never accepts file bytes and never reads client files: run on the CLIENT machine (any size, single hop): ${curlCommand} ` +
        (bearer
          ? `with the current TDEI SSO session token already embedded (from tdei_sso_login; no $TDEI_TOKEN export needed).`
          : `with $TDEI_TOKEN set to the current TDEI SSO bearer token (sign in via tdei_sso_login first).`) +
        ` Then poll with tdei_list_jobs. The 'metadata=...' value is single-quoted for bash/zsh/PowerShell; on Windows cmd.exe re-quote it with double quotes (escape inner " as \\").`,
    };
  }

  /** Generic multipart POST for JSON-only job/file ops (clone, launchJob fields). File assets are refused. */
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
      const { value, filename } = await fieldToFormValue(fieldValue);
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

  private async resolveCurlToken(context: RequestContext): Promise<string | undefined> {
    if (context.accessToken?.trim()) return context.accessToken.trim();
    if (this.tokenProvider) {
      try {
        const token = await this.tokenProvider();
        if (token?.trim()) return token.trim();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async token(context: RequestContext): Promise<string> {
    if (context.accessToken) return context.accessToken;
    if (this.tokenProvider) return this.tokenProvider();
    throw new Error("TDEI_SSO_REQUIRED");
  }

  private dataTypePath(dataType: DataType): string {
    if (dataType === "flex") return "gtfs-flex";
    if (dataType === "pathways") return "gtfs-pathways";
    return "osw";
  }
}

/**
 * Resolve a dataset asset to a CLIENT-machine file path. The path is only
 * ever embedded in the curl command — the server never stats, opens, or
 * reads it. Only local_path assets are supported: inline_base64, url, and
 * object_ref kinds would require bytes (or server fetches) through MCP.
 */
function clientAssetPath(asset: DatasetAsset, field: string): string {
  if (asset.kind !== "local_path") {
    throw new Error(
      `MCP never accepts file bytes — "${field}" must be a local_path asset with the absolute dataset path on the CLIENT machine. Run the upload via curl from the client machine (single hop, any size) with the SSO bearer from tdei_sso_login, then poll with tdei_list_jobs.`,
    );
  }
  const rawPath = asset.path.trim();
  if (!rawPath) throw new Error(`"${field}" path must be a non-empty absolute path on the CLIENT machine.`);
  if (!isClientAbsolutePath(rawPath)) {
    throw new Error(
      `"${field}" path must be absolute on the CLIENT machine (e.g. /Users/you/data/file.zip or C:\\data\\file.zip); got "${asset.path}".`,
    );
  }
  assertAllowedExtension(rawPath);
  if (asset.name) assertAllowedExtension(asset.name);
  return rawPath;
}

function isClientAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Single-quote-escape a metadata object for inline `-F 'metadata=...'` use. */
function shellQuoteJson(metadata: DatasetMetadata): string {
  return JSON.stringify(metadata).replace(/'/g, `'\\''`);
}

function assertAllowedExtension(filePathOrName: string): void {
  const ext = extname(filePathOrName).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported dataset file extension "${ext || "(none)"}" for "${basename(filePathOrName)}". Allowed extensions: ${[...ALLOWED_UPLOAD_EXTENSIONS].join(", ")}.`,
    );
  }
}
