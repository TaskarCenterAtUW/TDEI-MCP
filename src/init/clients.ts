import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { join } from "node:path";

export const CLIENTS = ["codex", "claude", "vscode", "custom"] as const;
export type ClientName = (typeof CLIENTS)[number];

export interface ServerEntry { command: string; args: string[]; env: Record<string, string>; }

export function buildServerEntry(npxPath: string, env: Record<string, string>): ServerEntry {
  return { command: npxPath, args: ["-y", "tdei-mcp"], env: { ...env } };
}

// Checkout mode: run the locally built server with the absolute node path.
export function buildLocalEntry(nodePath: string, indexJsPath: string, env: Record<string, string>): ServerEntry {
  return { command: nodePath, args: [indexJsPath], env: { ...env } };
}

// npx ships beside node (same bin dir on all platforms). The client entry
// must launch npx — NOT node — because args ["-y", "tdei-mcp"] are npx flags.
export function npxPathFor(nodeExecPath: string, platform: string = process.platform): string {
  const p = platform === "win32" ? win32 : posix;
  return p.join(p.dirname(nodeExecPath), platform === "win32" ? "npx.cmd" : "npx");
}

function upsertTomlBlock(toml: string, header: string, body: string): string {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    const prefix = toml.trim() ? toml.replace(/\s+$/, "") + "\n\n" : "";
    return prefix + header + "\n" + body + "\n";
  }
  // The [mcp_servers.tdei.env] child table belongs to this block — only a
  // non-child header ends it. Otherwise re-upserts orphan the old env lines.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (/^\[.*\]$/.test(trimmed) && trimmed !== "[mcp_servers.tdei.env]") { end = i; break; }
  }
  return [...lines.slice(0, start + 1), ...body.split("\n"), ...lines.slice(end)].join("\n");
}

function envToToml(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
}

export function codexConfigPath(home: string = homedir()): string {
  return join(home, ".codex", "config.toml");
}

export function writeCodexEntry(toml: string, entry: ServerEntry, env: Record<string, string>): string {
  const body = [
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`,
    "startup_timeout_sec = 120",
    "tool_timeout_sec = 120",
    "",
    "[mcp_servers.tdei.env]",
    envToToml(env),
  ].join("\n");
  return upsertTomlBlock(toml, "[mcp_servers.tdei]", body);
}

export function readCodexEntry(toml: string): { found: boolean; env: Record<string, string>; command?: string } {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.tdei]");
  if (start === -1) return { found: false, env: {} };
  // Include the [mcp_servers.tdei.env] child table — env lives there.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (/^\[.*\]$/.test(trimmed) && trimmed !== "[mcp_servers.tdei.env]") { end = i; break; }
  }
  const env: Record<string, string> = {};
  let command: string | undefined;
  for (const line of lines.slice(start + 1, end)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"\s*$/);
    if (m && m[1] === "command") command = JSON.parse(`"${m[2]}"`);
    else if (m) env[m[1]!] = JSON.parse(`"${m[2]}"`);
  }
  return { found: true, env, command };
}

export function claudeConfigPath(platform: string = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function upsertJsonEntry(jsonText: string, rootKey: string, serverKey: string, value: unknown, pathForError: string): string {
  let doc: Record<string, unknown>;
  if (!jsonText.trim()) {
    doc = {};
  } else {
    try {
      doc = JSON.parse(jsonText) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`existing MCP client config at ${pathForError} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or move the file, then re-run init.`);
    }
  }
  const root = (doc[rootKey] as Record<string, unknown> | undefined) ?? {};
  doc[rootKey] = { ...root, [serverKey]: value };
  return JSON.stringify(doc, null, 2) + "\n";
}

function readJsonEntry(jsonText: string, rootKey: string, serverKey: string): { found: boolean; env: Record<string, string>; command?: string } {
  if (!jsonText.trim()) return { found: false, env: {} };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`existing MCP client config is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or move the file, then re-run init.`);
  }
  const entry = (doc[rootKey] as Record<string, unknown> | undefined)?.[serverKey] as { env?: Record<string, string>; command?: string } | undefined;
  if (!entry) return { found: false, env: {} };
  return { found: true, env: { ...(entry.env ?? {}) }, command: entry.command };
}

export function writeClaudeEntry(jsonText: string, entry: ServerEntry, env: Record<string, string>, pathForError = "claude_desktop_config.json"): string {
  return upsertJsonEntry(jsonText, "mcpServers", "tdei", { command: entry.command, args: entry.args, env }, pathForError);
}

export function readClaudeEntry(jsonText: string): { found: boolean; env: Record<string, string>; command?: string } {
  return readJsonEntry(jsonText, "mcpServers", "tdei");
}

export function vscodeConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, ".vscode", "mcp.json");
}

export function writeVscodeEntry(jsonText: string, entry: ServerEntry, env: Record<string, string>, pathForError = "mcp.json"): string {
  return upsertJsonEntry(jsonText, "servers", "tdei", { command: entry.command, args: entry.args, env }, pathForError);
}

export function readVscodeEntry(jsonText: string): { found: boolean; env: Record<string, string>; command?: string } {
  return readJsonEntry(jsonText, "servers", "tdei");
}

export function formatManual(entry: ServerEntry, env: Record<string, string>): string {
  return [
    "Manual MCP setup (Custom client):",
    `  Command: ${entry.command}`,
    `  Args: ${entry.args.join(" ")}`,
    "  Env:",
    ...Object.entries(env).map(([k, v]) => `    ${k}=${v}`),
  ].join("\n");
}
