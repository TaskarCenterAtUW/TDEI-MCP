import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Remote-connector client configuration for `tdei-mcp setup`.
 *
 * This is the typed twin of the program embedded in `http-setup-script.ts` (the
 * curl / PowerShell installers). It only handles REMOTE Streamable HTTP
 * connectors; the stdio flow in `src/init/` is untouched.
 */

export const SETUP_CLIENTS = ["codex", "opencode", "claude-cli", "claude-desktop", "vscode", "cursor"] as const;
export type SetupClient = (typeof SETUP_CLIENTS)[number];

export interface HostEnv {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows; defaults to <home>/AppData/Roaming. */
  appData?: string | undefined;
}

/** Entry names this tool manages: `tdei` or `tdei-<anything>` (not `tdeiish`). */
const TDEI_NAME = /^tdei(-[A-Za-z0-9_]+)*$/;
export function isTdeiEntryName(name: string): boolean {
  return TDEI_NAME.test(name);
}

function appSupportDir(host: HostEnv, app: string): string {
  if (host.platform === "darwin") return join(host.home, "Library", "Application Support", app);
  if (host.platform === "win32") return join(host.appData || join(host.home, "AppData", "Roaming"), app);
  return join(host.home, ".config", app);
}

export function configPath(client: SetupClient, host: HostEnv): string {
  switch (client) {
    case "codex":
      return join(host.home, ".codex", "config.toml");
    case "opencode":
      return join(host.home, ".config", "opencode", "opencode.json");
    case "claude-cli":
      return join(host.home, ".claude.json");
    case "claude-desktop":
      return join(appSupportDir(host, "Claude"), "claude_desktop_config.json");
    case "vscode":
      return join(appSupportDir(host, "Code"), "User", "mcp.json");
    case "cursor":
      return join(host.home, ".cursor", "mcp.json");
  }
}

/** JSON key that holds the server map in each JSON-based client. */
const JSON_PARENT: Record<Exclude<SetupClient, "codex">, string> = {
  opencode: "mcp",
  "claude-cli": "mcpServers",
  "claude-desktop": "mcpServers",
  vscode: "servers",
  cursor: "mcpServers",
};

/** Claude Desktop only accepts stdio servers, so bridge to the HTTP endpoint with mcp-remote. */
function claudeDesktopEntry(endpoint: string): { command: string; args: string[] } {
  const args = ["-y", "mcp-remote", endpoint];
  if (new URL(endpoint).protocol === "http:") args.push("--allow-http");
  return { command: "npx", args };
}

function jsonEntry(client: Exclude<SetupClient, "codex">, url: string): Record<string, unknown> {
  switch (client) {
    case "opencode":
      return { type: "remote", url, enabled: true, timeout: 120000 };
    case "claude-cli":
    case "vscode":
      return { type: "http", url };
    case "claude-desktop":
      return claudeDesktopEntry(url);
    case "cursor":
      return { url };
  }
}

function writeAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf-8");
  renameSync(temporary, filePath);
}

type ReadResult = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; root: Record<string, unknown> };

function readJsonObject(filePath: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return { kind: "missing" };
  }
  if (text.trim() === "") return { kind: "ok", root: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { kind: "ok", root: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through
  }
  return { kind: "invalid" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** TOML blocks for `[mcp_servers.<name>]` plus any `[mcp_servers.<name>.*]` sub-tables. */
function codexBlockPattern(nameSource: string): RegExp {
  return new RegExp(`\\n?\\[mcp_servers\\.(${nameSource})(?:\\.[^\\]\\n]*)?\\][\\s\\S]*?(?=\\n\\[|$)`, "g");
}

export interface ApplyResult {
  filePath: string;
  /** "skipped" means the file could not be safely edited; see `reason`. */
  status: "written" | "skipped";
  reason?: string;
}

/** Add or replace one remote server entry. Other entries are never touched. */
export function upsertEntry(client: SetupClient, host: HostEnv, name: string, url: string): ApplyResult {
  const filePath = configPath(client, host);
  if (client === "codex") {
    let existing = "";
    try {
      existing = readFileSync(filePath, "utf-8");
    } catch {
      existing = "";
    }
    const cleaned = existing.replace(codexBlockPattern(escapeRegExp(name)), "").trimEnd();
    const block = [
      `[mcp_servers.${name}]`,
      `url = ${JSON.stringify(url)}`,
      "startup_timeout_sec = 120",
      "tool_timeout_sec = 120",
    ].join("\n");
    writeAtomic(filePath, cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`);
    return { filePath, status: "written" };
  }

  const read = readJsonObject(filePath);
  if (read.kind === "invalid") {
    return { filePath, status: "skipped", reason: "not plain JSON (comments or a syntax error); left untouched" };
  }
  const root = read.kind === "ok" ? read.root : {};
  const parentKey = JSON_PARENT[client];
  const parent =
    root[parentKey] && typeof root[parentKey] === "object" && !Array.isArray(root[parentKey])
      ? (root[parentKey] as Record<string, unknown>)
      : {};
  parent[name] = jsonEntry(client, url);
  root[parentKey] = parent;
  if (client === "opencode" && !root["$schema"]) root["$schema"] = "https://opencode.ai/config.json";
  writeAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`);
  return { filePath, status: "written" };
}

export interface RemoveResult {
  filePath: string;
  removed: string[];
  reason?: string;
}

function pruneKeys(parent: unknown, matches: (name: string) => boolean): string[] {
  const removed: string[] = [];
  if (parent && typeof parent === "object" && !Array.isArray(parent)) {
    const record = parent as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (matches(key)) {
        delete record[key];
        removed.push(key);
      }
    }
  }
  return removed;
}

/** Remove every entry whose name matches (default: all `tdei` / `tdei-*`). Other servers are kept. */
export function removeEntries(
  client: SetupClient,
  host: HostEnv,
  matches: (name: string) => boolean = isTdeiEntryName,
): RemoveResult {
  const filePath = configPath(client, host);
  if (client === "codex") {
    let existing: string;
    try {
      existing = readFileSync(filePath, "utf-8");
    } catch {
      return { filePath, removed: [] };
    }
    const removed: string[] = [];
    const cleaned = existing.replace(codexBlockPattern("[A-Za-z0-9_-]+"), (block: string, name: string) => {
      if (!matches(name)) return block;
      if (!removed.includes(name)) removed.push(name);
      return "";
    });
    if (removed.length > 0) writeAtomic(filePath, cleaned.trimEnd() ? `${cleaned.trimEnd()}\n` : "");
    return { filePath, removed };
  }

  const read = readJsonObject(filePath);
  if (read.kind === "missing") return { filePath, removed: [] };
  if (read.kind === "invalid") {
    return { filePath, removed: [], reason: "not plain JSON (comments or a syntax error); left untouched" };
  }
  const { root } = read;
  const removed = pruneKeys(root[JSON_PARENT[client]], matches);
  // Claude Code also keeps per-project servers under projects[<dir>].mcpServers.
  if (client === "claude-cli" && root["projects"] && typeof root["projects"] === "object") {
    for (const project of Object.values(root["projects"] as Record<string, unknown>)) {
      if (project && typeof project === "object") {
        removed.push(...pruneKeys((project as Record<string, unknown>)["mcpServers"], matches));
      }
    }
  }
  if (removed.length > 0) writeAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`);
  return { filePath, removed };
}
