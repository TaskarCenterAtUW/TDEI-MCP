import { parse } from "smol-toml";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CLIENTS = ["codex", "claude", "vscode", "custom"] as const;
export type ClientName = (typeof CLIENTS)[number];

export interface ServerEntry { command: string; args: string[]; cwd?: string; env: Record<string, string>; }

export function buildServerEntry(nodePath: string, env: Record<string, string>, serverPath: string): ServerEntry {
  return { command: nodePath, args: [serverPath], cwd: dirname(dirname(serverPath)), env: { ...env } };
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
  return [...lines.slice(0, start + 1), ...body.split("\n"), ...lines.slice(end)].join("\n").replace(/\s*$/, "\n");
}

function envToToml(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
}

export function codexConfigPath(home: string = homedir()): string {
  return join(process.env.CODEX_HOME || join(home, ".codex"), "config.toml");
}

export function writeCodexEntry(toml: string, entry: ServerEntry, env: Record<string, string>): string {
  parse(toml);
  const body = [
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`,
    ...(entry.cwd ? [`cwd = ${JSON.stringify(entry.cwd)}`] : []),
    "startup_timeout_sec = 120",
    "tool_timeout_sec = 120",
    "",
    "[mcp_servers.tdei.env]",
    envToToml(env),
  ].join("\n");
  const updated = upsertTomlBlock(toml, "[mcp_servers.tdei]", body);
  parse(updated);
  return updated;
}

export function readCodexEntry(toml: string): { found: boolean; env: Record<string, string>; command?: string; args?: string[]; cwd?: string } {
  const doc = parse(toml) as { mcp_servers?: { tdei?: ServerEntry } };
  const entry = doc.mcp_servers?.tdei;
  return entry ? { found: true, ...entry, env: { ...(entry.env ?? {}) } } : { found: false, env: {} };
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

function readJsonEntry(jsonText: string, rootKey: string, serverKey: string): { found: boolean; env: Record<string, string>; command?: string; args?: string[]; cwd?: string } {
  if (!jsonText.trim()) return { found: false, env: {} };
  const doc = JSON.parse(jsonText) as Record<string, unknown>;
  const entry = (doc[rootKey] as Record<string, unknown> | undefined)?.[serverKey] as ServerEntry | undefined;
  if (!entry) return { found: false, env: {} };
  return { found: true, ...entry, env: { ...(entry.env ?? {}) } };
}

export function writeClaudeEntry(jsonText: string, entry: ServerEntry, env: Record<string, string>, pathForError = "claude_desktop_config.json"): string {
  return upsertJsonEntry(jsonText, "mcpServers", "tdei", { ...entry, env }, pathForError);
}

export function readClaudeEntry(jsonText: string): { found: boolean; env: Record<string, string>; command?: string; args?: string[]; cwd?: string } {
  return readJsonEntry(jsonText, "mcpServers", "tdei");
}

export function vscodeConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, ".vscode", "mcp.json");
}

export function writeVscodeEntry(jsonText: string, entry: ServerEntry, env: Record<string, string>, pathForError = "mcp.json"): string {
  return upsertJsonEntry(jsonText, "servers", "tdei", { ...entry, env }, pathForError);
}

export function readVscodeEntry(jsonText: string): { found: boolean; env: Record<string, string>; command?: string; args?: string[]; cwd?: string } {
  return readJsonEntry(jsonText, "servers", "tdei");
}

export function formatManual(entry: ServerEntry, env: Record<string, string>): string {
  return [
    "Manual MCP setup (Custom client):",
    `  Command: ${entry.command}`,
    `  Args: ${JSON.stringify(entry.args)}`,
    `  Working directory: ${entry.cwd ?? "client default"}`,
    "  Env:",
    ...Object.entries(env).map(([k, v]) => `    ${k}=${v}`),
  ].join("\n");
}

export function switchCodexEnv(toml: string, env: Record<string, string>): string {
  parse(toml);
  const lines = toml.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.tdei.env]");
  if (start < 0) return `${toml.trimEnd()}\n\n[mcp_servers.tdei.env]\n${envToToml(env)}\n`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  const updated = [...lines.slice(0, start + 1), envToToml(env), ...lines.slice(end)].join("\n");
  parse(updated);
  return updated;
}
