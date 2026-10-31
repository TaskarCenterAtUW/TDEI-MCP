import type { RequestContext } from "../intents/types.js";

export interface BinaryDownloadOptions {
  baseUrl: string;
  /**
   * Kept for backward compatibility with existing wiring/tests; ignored for
   * fetching. The MCP server never fetches bytes or writes files — downloads
   * run on the client machine via the returned curl command.
   * tokenProvider supplies the same SSO token from the sso logon tool so
   * curl is already authenticated.
   */
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
  outputDir?: string;
  timeoutMs?: number;
  maxRetries?: number;
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
 * Client-side counterpart to the former streaming downloader.
 *
 * Generic MCP text results cannot safely carry ZIP payloads, and the MCP
 * server must never touch file bytes (no fetching, no disk writes). Binary
 * download tools therefore resolve to a ready-to-run curl command which the
 * LLM executes on the CLIENT machine into the user-connected folder with
 * the same SSO bearer from the sso logon tool already embedded.
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

  async download(tool: string, input: Record<string, unknown>, context: RequestContext): Promise<DownloadInstruction> {
    const path = this.routeFor(tool, input);
    const filename = filenameFor(tool, input);
    const url = new URL(path, this.baseUrl).toString();
    // Use the same SSO token from the sso logon tool (via context or
    // tokenProvider) so client-side curl is already authenticated.
    // Falls back to $TDEI_TOKEN only when no session token is available.
    const bearer = await this.resolveCurlToken(context);
    const auth = bearer ?? "$TDEI_TOKEN";
    const curlCommand = `curl -L -H "Authorization: Bearer ${auth}" "${url}" -o "${filename}"`;
    return {
      tool,
      method: "GET",
      path: `/${path}`,
      filename,
      curlCommand,
      instruction:
        `MCP server never downloads files. Run on the CLIENT machine into the user-connected folder: ${curlCommand} ` +
        (bearer
          ? `with the current TDEI SSO session token already embedded (from tdei_sso_login; no $TDEI_TOKEN export needed).`
          : `with $TDEI_TOKEN set to the current TDEI SSO bearer token (sign in via tdei_sso_login first).`),
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
