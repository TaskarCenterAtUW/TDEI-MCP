import type { RequestContext } from "../intents/types.js";

export interface BinaryDownloadOptions {
  baseUrl: string;
  /** Supplies the caller's SSO bearer (stdio). Remote callers pass it per request via RequestContext. */
  tokenProvider?: () => Promise<string>;
}

export interface DownloadInstruction {
  tool: string;
  method: "GET";
  path: string;
  filename: string;
  curlCommand: string;
  instruction: string;
}

/**
 * Default client-side downloads folder. Returned as a shell expression that
 * is expanded on the CLIENT machine — never resolved with node:os on the
 * MCP server, which must not touch the server filesystem for downloads.
 * $HOME expands in bash/zsh and PowerShell; Windows cmd.exe callers
 * substitute the connected folder's absolute path before running.
 */
export function defaultClientDownloadsDir(): string {
  return "$HOME/Downloads";
}

/**
 * Join a client-side directory with a filename. Client-side expressions
 * (containing `$`, e.g. $HOME/Downloads) join with `/`, which works in
 * bash/zsh and PowerShell; explicit Windows paths (drive letter or
 * backslashes) join with `\`; everything else joins with `/`.
 */
export function joinDownloadPath(dir: string, filename: string): string {
  const base = dir.replace(/[/\\]+$/, "");
  const sep = /\\|^[A-Za-z]:/.test(base) ? "\\" : "/";
  return `${base}${sep}${filename}`;
}

/**
 * Paths end up inside double quotes in a command the CLIENT machine runs, so a
 * path that can break out of the quotes or run a command is rejected. Plain
 * variables such as $HOME stay allowed (the default folder is $HOME/Downloads).
 */
export function assertSafeShellPath(value: string, label: string): void {
  if (/["`\n\r\0]|\$\(/.test(value)) {
    throw new Error(
      `Unsafe ${label} "${value.slice(0, 80)}": it must not contain double quotes, backticks, "$(", or line breaks.`,
    );
  }
}

/**
 * Shared client-side download command used by every download path. Flags:
 * -L (follow redirects), -sS (silent but show errors), --create-dirs
 * (create the target folder), --fail-with-body (non-zero exit on HTTP
 * errors while still printing the body), and -w prints a trailing
 * HTTP_STATUS line so clients can verify success regardless of extension.
 * All interpolations are double-quoted for paths containing spaces.
 */
export function buildClientDownloadCurl(url: string, bearer: string, filePath: string): string {
  assertSafeShellPath(filePath, "download path");
  return (
    `curl -L -sS --create-dirs --fail-with-body -w "\\nHTTP_STATUS:%{http_code}\\n" ` +
    `-H "Authorization: Bearer ${bearer}" "${url}" -o "${filePath}"`
  );
}

/**
 * Client-side counterpart to the former streaming downloader.
 *
 * Generic MCP text results cannot safely carry ZIP payloads, and the MCP
 * server must never touch file bytes (no fetching, no disk writes) and must
 * relay bytes. Binary download tools
 * therefore resolve to a ready-to-run curl command which the assistant
 * executes on the CLIENT machine via its shell tool into the user-connected
 * folder, with the calling user's own bearer embedded ($TDEI_TOKEN fallback). File bytes flow
 * directly from the TDEI backend to the client; the gateway is not a relay.
 * This builder is pure: no fetch, no fs.
 */
export class BinaryTdeiDownloads {
  private readonly baseUrl: string;
  private readonly tokenProvider: (() => Promise<string>) | undefined;

  constructor(options: BinaryDownloadOptions) {
    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.tokenProvider = options.tokenProvider;
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
    context: RequestContext = {},
  ): Promise<DownloadInstruction> {
    const path = this.routeFor(tool, input);
    const filename = filenameFor(tool, input);
    const url = new URL(path, this.baseUrl).toString();
    // The response goes only to the calling user, so embedding that caller's
    // own bearer keeps the command hands-free. $TDEI_TOKEN is only a fallback
    // when no token is available.
    const auth = (await this.resolveCurlToken(context)) ?? "$TDEI_TOKEN";
    const curlCommand = buildClientDownloadCurl(url, auth, filename);
    return {
      tool,
      method: "GET",
      path: `/${path}`,
      filename,
      curlCommand,
      instruction:
        `Execute this now with your shell tool on the CLIENT machine (no human step, do not ask the user to run it, do not save it to a script file): ${curlCommand} ` +
        (auth === "$TDEI_TOKEN"
          ? `with $TDEI_TOKEN set to the caller's TDEI SSO bearer (sign in first). `
          : `The caller's TDEI bearer is already embedded; no export needed. `) +
        `File bytes flow directly from the TDEI backend to the client; the gateway is not a relay.`,
    };
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
