import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * "client" (default): the MCP server returns a curl command and the client
 * shell runs it. Required when the server runs remotely.
 * "server": the MCP server streams the ZIP to a local folder itself. Only
 * allowed when the server runs on the user's machine (stdio, or HTTP bound to
 * loopback), because it writes to the host filesystem.
 */
export type DownloadMode = "client" | "server";

export interface DownloadSettings {
  mode: DownloadMode;
  /** Absolute folder used in server mode when the caller gives no outputDir. */
  serverDir: string;
}

export interface DownloadSettingsResult {
  settings: DownloadSettings;
  warnings: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Reads TDEI_DOWNLOAD_MODE and TDEI_DOWNLOAD_DIR. Anything unsafe or invalid
 * falls back to client mode and reports a warning instead of failing startup.
 */
export function resolveDownloadSettings(
  env: NodeJS.ProcessEnv,
  transport: "stdio" | "http",
  httpHost: string,
): DownloadSettingsResult {
  const warnings: string[] = [];
  const defaultDir = join(homedir(), "Downloads");

  const requested = env.TDEI_DOWNLOAD_MODE?.trim().toLowerCase() || "client";
  let mode: DownloadMode = "client";
  if (requested === "server") {
    const local = transport === "stdio" || LOOPBACK_HOSTS.has(httpHost.trim().toLowerCase());
    if (local) mode = "server";
    else warnings.push("TDEI_DOWNLOAD_MODE=server ignored: server is not bound to loopback. Using client mode.");
  } else if (requested !== "client") {
    warnings.push(`TDEI_DOWNLOAD_MODE="${requested}" is not valid (use client or server). Using client mode.`);
  }

  let serverDir = defaultDir;
  const rawDir = env.TDEI_DOWNLOAD_DIR?.trim();
  if (rawDir) {
    if (isAbsolute(rawDir)) serverDir = rawDir;
    else warnings.push("TDEI_DOWNLOAD_DIR must be an absolute path. Using ~/Downloads.");
  }

  return { settings: { mode, serverDir }, warnings };
}

export interface SaveDatasetOptions {
  url: string;
  bearer: string;
  dir: string;
  filename: string;
  fetchImpl?: typeof fetch | undefined;
}

export interface SavedDataset {
  filePath: string;
  bytes: number;
  httpStatus: number;
}

/**
 * Streams a TDEI dataset ZIP to disk. Writes to a .part file and renames it
 * on success, so a failed transfer never leaves a truncated ZIP behind. The
 * bearer is sent only in the request header; it is never returned or logged.
 */
export async function saveDatasetToDisk(options: SaveDatasetOptions): Promise<SavedDataset> {
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(options.dir, { recursive: true });
  const filePath = join(options.dir, options.filename);
  const partPath = `${filePath}.part`;

  const res = await fetchImpl(options.url, {
    headers: { Authorization: `Bearer ${options.bearer}` },
    redirect: "follow",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TDEI download failed: HTTP ${res.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  if (!res.body) throw new Error("TDEI download failed: empty response body.");

  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(partPath),
    );
    await rename(partPath, filePath);
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  }

  const { size } = await stat(filePath);
  return { filePath, bytes: size, httpStatus: res.status };
}
