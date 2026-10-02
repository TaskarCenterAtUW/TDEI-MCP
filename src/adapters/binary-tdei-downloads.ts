import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RequestContext } from "../intents/types.js";
import { TdeiHttpError } from "./tdei-http-error.js";

export interface BinaryDownloadOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
  /** Absolute directory downloads are written under. Defaults to cwd. */
  outputDir?: string;
  timeoutMs?: number;
}

export interface DownloadedFile {
  tool: string;
  path: string;
  bytes: number;
  contentType?: string;
}

/**
 * Binary-safe counterpart to DirectMultipartTdeiMutations.
 *
 * The AWS OpenAPI MCP child decodes every response body as UTF-8
 * (FastMCP `response.json()` with only `json.JSONDecodeError` caught), so
 * `application/octet-stream` downloads such as getOswFile crash it with
 * `'utf-8' codec can't decode byte 0x83`. These downloads bypass the child
 * and stream raw bytes to a local file with fetch + arrayBuffer().
 */
export class BinaryTdeiDownloads {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly outputDir: string;

  constructor(private readonly options: BinaryDownloadOptions) {
    this.baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : `${options.baseUrl}/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.outputDir = resolve(options.outputDir ?? process.cwd());
  }

  static readonly DOWNLOAD_TOOLS = new Set([
    "getOswFile",
    "getGtfsFlexFile",
    "getGtfsPathwaysFile",
    "job-download",
    "job_download",
  ]);

  static isDownloadTool(tool: string): boolean {
    return BinaryTdeiDownloads.DOWNLOAD_TOOLS.has(tool);
  }

  async download(
    tool: string,
    input: Record<string, unknown>,
    context: RequestContext,
  ): Promise<DownloadedFile> {
    const path = this.routeFor(tool, input);
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: "GET",
      headers: {
        Accept: "application/octet-stream, application/json",
        Authorization: `Bearer ${await this.token(context)}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new TdeiHttpError(
        `TDEI download failed with status ${response.status}.`,
        response.status,
        await safeErrorBody(response),
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const filename = filenameFor(tool, input);
    const filePath = join(this.outputDir, filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    const contentType = response.headers.get("content-type") ?? undefined;
    return {
      tool,
      path: filePath,
      bytes: bytes.byteLength,
      ...(contentType ? { contentType } : {}),
    };
  }

  private routeFor(tool: string, input: Record<string, unknown>): string {
    switch (tool) {
      case "getOswFile":
        return `api/v1/osw/${encodeURIComponent(requireId(input, "tdei_dataset_id"))}${query(input, ["format", "file_version", "fileVersion"])}`;
      case "getGtfsFlexFile":
        return `api/v1/gtfs-flex/${encodeURIComponent(requireId(input, "tdei_dataset_id"))}`;
      case "getGtfsPathwaysFile":
        return `api/v1/gtfs-pathways/${encodeURIComponent(requireId(input, "tdei_dataset_id"))}`;
      case "job-download":
      case "job_download":
        return `api/v1/job/download/${encodeURIComponent(requireId(input, "job_id"))}`;
      default:
        throw new Error(`Binary download is not supported for tool "${tool}".`);
    }
  }

  private async token(context: RequestContext): Promise<string> {
    if (context.accessToken) return context.accessToken;
    if (this.options.tokenProvider) return this.options.tokenProvider();
    throw new Error("TDEI_SSO_REQUIRED");
  }
}

function requireId(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Download tool requires a non-empty string "${key}".`);
  }
  return value.trim();
}

function query(input: Record<string, unknown>, keys: string[]): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      const name = key === "fileVersion" ? "file_version" : key;
      params.set(name, value);
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function filenameFor(tool: string, input: Record<string, unknown>): string {
  const id = ["tdei_dataset_id", "job_id"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value !== "");
  const safe = (id ?? tool).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${tool}-${safe}.zip`;
}

async function safeErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 2000);
  }
}
