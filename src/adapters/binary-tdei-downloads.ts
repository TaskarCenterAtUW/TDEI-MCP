import { mkdir, open, rename, rm } from "node:fs/promises";
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
  maxRetries?: number;
}

export interface DownloadedFile {
  tool: string;
  path: string;
  bytes: number;
  contentType?: string;
  status: "completed" | "resumed" | "restarted";
  attempts: number;
  message: string;
}

const RETRYABLE_DOWNLOAD_STATUSES = new Set([408, 429, 502, 503, 504]);

/**
 * Binary-safe counterpart to DirectMultipartTdeiMutations.
 *
 * Generic MCP text results cannot safely carry ZIP payloads. Binary download
 * tools therefore stream raw bytes directly to disk with Content-Length
 * verification and automatic Range-resume / full-restart fallback on transient
 * stream or network failures.
 */
export class BinaryTdeiDownloads {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly outputDir: string;
  private readonly maxRetries: number;

  constructor(private readonly options: BinaryDownloadOptions) {
    this.baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : `${options.baseUrl}/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.outputDir = resolve(options.outputDir ?? process.cwd());
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
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
    const filename = filenameFor(tool, input);
    const filePath = join(this.outputDir, filename);
    const partPath = `${filePath}.part`;
    await mkdir(dirname(filePath), { recursive: true });
    await rm(partPath, { force: true }).catch(() => undefined);

    const totalAttempts = this.maxRetries + 1;
    let bytesWritten = 0;
    let expectedTotalBytes: number | undefined;
    let recoveryStatus: DownloadedFile["status"] = "completed";
    let forceRestart = false;
    let lastError: unknown;

    try {
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        if (forceRestart && bytesWritten > 0) {
          await rm(partPath, { force: true }).catch(() => undefined);
          bytesWritten = 0;
          expectedTotalBytes = undefined;
          recoveryStatus = "restarted";
          forceRestart = false;
        }

        const resumeOffset = bytesWritten;
        const headers: Record<string, string> = {
          Accept: "application/octet-stream, application/json",
          Authorization: `Bearer ${await this.token(context)}`,
        };
        if (resumeOffset > 0) {
          headers.Range = `bytes=${resumeOffset}-`;
        }

        let response: Response;
        try {
          response = await this.fetchImpl(new URL(path, this.baseUrl), {
            method: "GET",
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (error) {
          lastError = error;
          if (attempt < totalAttempts) {
            continue;
          }
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `TDEI download failed for ${tool} after ${attempt} attempt(s) (${bytesWritten} bytes received): ${reason}`,
          );
        }

        // If the server rejects our Range header with 416, fall back to a full restart from byte 0.
        if (response.status === 416 && resumeOffset > 0 && attempt < totalAttempts) {
          await response.body?.cancel().catch(() => undefined);
          forceRestart = true;
          continue;
        }

        if (!response.ok) {
          const errorBody = await safeErrorBody(response);
          const httpError = new TdeiHttpError(
            `TDEI download failed for ${tool} with status ${response.status} (attempt ${attempt}/${totalAttempts}).`,
            response.status,
            errorBody,
          );
          lastError = httpError;
          if (attempt < totalAttempts && RETRYABLE_DOWNLOAD_STATUSES.has(response.status)) {
            continue;
          }
          throw httpError;
        }

        // Determine whether we are appending (206 Partial Content) or writing from offset 0 (200 OK).
        const isPartial = resumeOffset > 0 && response.status === 206;
        if (resumeOffset > 0) {
          recoveryStatus = isPartial ? "resumed" : "restarted";
        }
        if (!isPartial && bytesWritten > 0) {
          bytesWritten = 0;
          expectedTotalBytes = undefined;
        }

        const contentLengthHeader = response.headers.get("content-length");
        const parsedLength = contentLengthHeader !== null ? Number(contentLengthHeader) : NaN;
        if (Number.isFinite(parsedLength) && parsedLength >= 0) {
          expectedTotalBytes = isPartial ? resumeOffset + parsedLength : parsedLength;
        }

        try {
          const handle = await open(partPath, isPartial ? "a" : "w");
          try {
            if (response.body) {
              const reader = response.body.getReader();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value && value.byteLength > 0) {
                    await handle.write(value);
                    bytesWritten += value.byteLength;
                  }
                }
              } finally {
                reader.releaseLock();
              }
            } else {
              const fallbackBytes = Buffer.from(await response.arrayBuffer());
              if (fallbackBytes.byteLength > 0) {
                await handle.write(fallbackBytes);
                bytesWritten += fallbackBytes.byteLength;
              }
            }
          } finally {
            await handle.close();
          }

          if (expectedTotalBytes !== undefined && bytesWritten < expectedTotalBytes) {
            throw new Error(
              `Incomplete download stream for ${tool}: received ${bytesWritten} of ${expectedTotalBytes} expected bytes.`,
            );
          }

          await rename(partPath, filePath);
          const contentType = response.headers.get("content-type") ?? undefined;
          const statusLabel =
            recoveryStatus === "completed"
              ? `completed in ${attempt} attempt(s)`
              : `${recoveryStatus} after transient failure in ${attempt} attempt(s)`;
          return {
            tool,
            path: filePath,
            bytes: bytesWritten,
            ...(contentType ? { contentType } : {}),
            status: recoveryStatus,
            attempts: attempt,
            message: `Downloaded ${bytesWritten} bytes to ${filePath} (${statusLabel}).`,
          };
        } catch (streamError) {
          lastError = streamError;
          if (attempt < totalAttempts) {
            continue;
          }
          const reason = streamError instanceof Error ? streamError.message : String(streamError);
          throw new Error(
            `TDEI download stream failed for ${tool} after ${attempt} attempt(s) (${bytesWritten} bytes received): ${reason}`,
          );
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error(`TDEI download failed for ${tool}.`);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
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
