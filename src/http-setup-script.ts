import { resolveTdeiServerProfile, type TdeiServerProfile } from "./intents/server-instructions.js";
import { installCopy } from "./tdei-shared/install-copy.js";
import { publicAuthCallbackUrl, REGISTERED_SSO_REDIRECT_URI } from "./sso-public-callback.js";
import { buildRelayProgram, RELAY_PID_NAME, RELAY_PORT, RELAY_TARGETS_NAME } from "./setup/relay.js";

/** Relay source baked into installer scripts (fallback list empty: the installer writes the targets file first). */
const EMBEDDED_RELAY_SOURCE = JSON.stringify(buildRelayProgram([], RELAY_PORT));

export type SetupClientTarget = "codex" | "opencode" | "claude-cli" | "claude-desktop" | "vscode" | "cursor";

const SETUP_CLIENTS: readonly SetupClientTarget[] = [
  "codex",
  "opencode",
  "claude-cli",
  "claude-desktop",
  "vscode",
  "cursor",
];

export function isSetupClientTarget(value: string): value is SetupClientTarget {
  return (SETUP_CLIENTS as readonly string[]).includes(value);
}

/**
 * Resolve a client slug from the setup URL, folding the deprecated `claude`
 * alias to `claude-cli` (Claude Code). Returns undefined for unknown slugs.
 */
export function normalizeSetupClientTarget(value: string): SetupClientTarget | undefined {
  const slug = value.toLowerCase();
  if (slug === "claude") return "claude-cli";
  return isSetupClientTarget(slug) ? slug : undefined;
}

/**
 * Installer action: fresh `install`, `update` (remove + reinstall from the current server URL),
 * `uninstall` (remove only this server's entry), or `cleanup` (remove every `tdei` / `tdei-*`
 * entry from the client config; the client may be `all` to sweep every supported harness).
 */
export type SetupScriptAction = "install" | "update" | "uninstall" | "cleanup";

/** A concrete client, or `all` (cleanup only: sweep every supported harness). */
export type SetupScriptTarget = SetupClientTarget | "all";

const MCP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Config key clients use to tell MCP servers apart.
 * Prefers the `name` from mcps.json (`tdei-core-dev`) when it is a safe identifier.
 */
export function clientMcpName(name?: string): string {
  const trimmed = name?.trim() ?? "";
  if (MCP_NAME_RE.test(trimmed)) return trimmed;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return MCP_NAME_RE.test(slug) ? slug : "tdei";
}

export function isSetupScriptAction(value: string): value is SetupScriptAction {
  return value === "install" || value === "update" || value === "uninstall" || value === "cleanup";
}

/** URL path for a client script: `<client>` for installs, `<action>/<client>` otherwise. */
export function setupActionPath(client: SetupScriptTarget, action: SetupScriptAction = "install"): string {
  return action === "install" ? client : `${action}/${client}`;
}

function setupUrls(
  baseUrl: string,
  basePath = "/mcp",
  _gatewaySlug?: string,
): { origin: string; mcpUrl: string; remoteCallbackUrl: string } {
  const origin = baseUrl.replace(/\/$/, "");
  const prefix = normalizeBasePath(basePath);
  return {
    origin,
    mcpUrl: `${origin}${prefix || "/mcp"}`,
    remoteCallbackUrl: publicAuthCallbackUrl(origin),
  };
}

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === "/") return "";
  return basePath.endsWith("/") && basePath.length > 1 ? basePath.slice(0, -1) : basePath;
}

/** Most extra entries one installer may add; the combined installers use one (core + workspace). */
const MAX_EXTRA_ENTRIES = 4;

/** Keep only well-formed, distinct extra entry names (the primary entry is added by the caller). */
function sanitizeExtraEntryNames(names: readonly string[], primary: string): string[] {
  const seen = new Set<string>([primary]);
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!MCP_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_EXTRA_ENTRIES) break;
  }
  return out;
}

/** `name|profile|url` args the embedded program reads for the extra entries on the same gateway. */
function extraEntryArgs(
  extraNames: readonly string[],
  origin: string,
  basePath: string,
  gatewaySlug: string | undefined,
  primary: string,
): string[] {
  const prefix = normalizeBasePath(basePath) || "/mcp";
  return sanitizeExtraEntryNames(extraNames, primary).map((name) => {
    const path =
      gatewaySlug && prefix.includes(`/${gatewaySlug}/`)
        ? prefix.replace(`/${gatewaySlug}/`, `/${name}/`)
        : `/${name}/mcp`;
    return `${name}|${resolveTdeiServerProfile({ name })}|${origin}${path}`;
  });
}

/** Escape a value for a PowerShell single-quoted string literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Shared client-configuration program (CommonJS, `require` only — no deps).
 * Runs identically on macOS, Ubuntu, and Windows under any Node 22+.
 * argv: [node, script, client, mcpUrl, remoteCallbackUrl, callbackPort, action, serverName, profile].
 * action is one of install (default), update, uninstall, or cleanup.
 * cleanup removes every tdei / tdei-* entry (client may be "all").
 * serverName is the mcps.json name (for example tdei-core-dev); omitted means tdei.
 * profile is core (default) or workspace; it only selects the post-login hint.
 * Embedded by both the POSIX sh wrapper and the PowerShell wrapper.
 */
const CLIENT_SETUP_JS = `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [, , client, primaryMcpUrl, remoteCallbackUrl, callbackPortRaw, actionRaw, serverNameRaw, profileRaw, ...extraArgs] = process.argv;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
let mcpUrl = primaryMcpUrl;
let profile = profileRaw === "workspace" ? "workspace" : "core";
const AFTER_LOGIN = {
  core: "Then try tdei_list_my_project_groups to see your project groups and datasets.",
  workspace: "Then try get_my_workspaces to see your workspaces. Dataset upload, validation and publish live on the matching tdei-core-* server.",
};
const action = actionRaw || "install";
let serverName = NAME_RE.test(serverNameRaw || "") ? serverNameRaw : "tdei";

// Optional extra entries for the same client (a combined core + workspace install):
// each extra arg is name|profile|url. The first entry is the server this script was fetched from.
const entries = [{ name: serverName, url: mcpUrl, profile }];
for (const raw of extraArgs) {
  const [name, extraProfile, url] = String(raw).split("|");
  if (NAME_RE.test(name || "") && /^https?:\\/\\//.test(url || "")) {
    entries.push({ name, url, profile: extraProfile === "workspace" ? "workspace" : "core" });
  }
}
function useEntry(entry) {
  serverName = entry.name;
  mcpUrl = entry.url;
  profile = entry.profile;
}
const shownNames = entries.map((entry) => entry.name).join(", ");

function codexEntryPattern() {
  const escaped = String(serverName).replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  return new RegExp("\\\\n?\\\\[mcp_servers\\\\." + escaped + "\\\\][\\\\s\\\\S]*?(?=\\\\n\\\\[|$)", "g");
}
if (action !== "install" && action !== "update" && action !== "uninstall" && action !== "cleanup") {
  console.error("Unsupported action:", actionRaw, '(expected "install", "update", "uninstall", or "cleanup")');
  process.exit(1);
}
const home = os.homedir();

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonOrEmpty(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

// Claude Desktop's claude_desktop_config.json schema accepts stdio servers
// only (command/args/env). A remote { type: "http", url } entry is dropped at
// launch with "Skipped invalid MCP server config entries", so bridge to the
// Streamable HTTP endpoint through mcp-remote instead.
function claudeDesktopStdioEntry(endpoint) {
  const args = ["-y", "mcp-remote", endpoint];
  if (new URL(endpoint).protocol === "http:") args.push("--allow-http");
  return { command: "npx", args };
}

function configureCodex() {
  const filePath = path.join(home, ".codex", "config.toml");
  ensureDir(filePath);
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch {
    existing = "";
  }
  const cleaned = existing
    .replace(codexEntryPattern(), "")
    .trimEnd();
  const block = [
    "[mcp_servers." + serverName + "]",
    \`url = \${JSON.stringify(mcpUrl)}\`,
    "startup_timeout_sec = 120",
    "tool_timeout_sec = 120",
  ].join("\\n");
  const next = cleaned ? \`\${cleaned}\\n\\n\${block}\\n\` : \`\${block}\\n\`;
  fs.writeFileSync(filePath, next, "utf-8");
  return filePath;
}

function configureOpenCode() {
  const filePath = path.join(home, ".config", "opencode", "opencode.json");
  ensureDir(filePath);
  const root = readJsonOrEmpty(filePath);
  if (!root.$schema) root.$schema = "https://opencode.ai/config.json";
  root.mcp = typeof root.mcp === "object" && root.mcp !== null ? root.mcp : {};
  root.mcp[serverName] = {
    type: "remote",
    url: mcpUrl,
    enabled: true,
    timeout: 120000,
  };
  fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return filePath;
}

function configureClaudeCli() {
  const filePath = path.join(home, ".claude.json");
  ensureDir(filePath);
  const root = readJsonOrEmpty(filePath);
  root.mcpServers =
    typeof root.mcpServers === "object" && root.mcpServers !== null
      ? root.mcpServers
      : {};
  root.mcpServers[serverName] = {
    type: "http",
    url: mcpUrl,
  };
  fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return filePath;
}

function configureClaudeDesktop() {
  const filePath =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
        : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  ensureDir(filePath);
  const root = readJsonOrEmpty(filePath);
  root.mcpServers =
    typeof root.mcpServers === "object" && root.mcpServers !== null
      ? root.mcpServers
      : {};
  root.mcpServers[serverName] = claudeDesktopStdioEntry(mcpUrl);
  fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return filePath;
}

function configureVsCode() {
  const filePath =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Code", "User", "mcp.json")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "mcp.json")
        : path.join(home, ".config", "Code", "User", "mcp.json");
  ensureDir(filePath);
  const root = readJsonOrEmpty(filePath);
  root.servers =
    typeof root.servers === "object" && root.servers !== null
      ? root.servers
      : {};
  root.servers[serverName] = {
    type: "http",
    url: mcpUrl,
  };
  fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return filePath;
}

function configureCursor() {
  const filePath = path.join(home, ".cursor", "mcp.json");
  ensureDir(filePath);
  const root = readJsonOrEmpty(filePath);
  root.mcpServers =
    typeof root.mcpServers === "object" && root.mcpServers !== null
      ? root.mcpServers
      : {};
  root.mcpServers[serverName] = {
    url: mcpUrl,
  };
  fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return filePath;
}

function codexFilePath() {
  return path.join(home, ".codex", "config.toml");
}

function removeCodex() {
  const filePath = codexFilePath();
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { filePath, removed: false };
  }
  if (!codexEntryPattern().test(existing)) return { filePath, removed: false };
  const cleaned = existing
    .replace(codexEntryPattern(), "")
    .trimEnd();
  fs.writeFileSync(filePath, cleaned ? \`\${cleaned}\\n\` : "", "utf-8");
  return { filePath, removed: true };
}

function removeJsonEntry(filePath, parentKey) {
  let root;
  try {
    root = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return { filePath, removed: false };
  }
  const parent =
    root && typeof root === "object" && typeof root[parentKey] === "object" && root[parentKey] !== null
      ? root[parentKey]
      : undefined;
  if (!parent || parent[serverName] === undefined) return { filePath, removed: false };
  delete parent[serverName];
  fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return { filePath, removed: true };
}

function claudeDesktopFilePath() {
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function vsCodeFilePath() {
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Code", "User", "mcp.json")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "mcp.json")
      : path.join(home, ".config", "Code", "User", "mcp.json");
}

function removeClientEntry(target) {
  if (target === "codex") return removeCodex();
  if (target === "opencode")
    return removeJsonEntry(path.join(home, ".config", "opencode", "opencode.json"), "mcp");
  if (target === "claude-cli") return removeJsonEntry(path.join(home, ".claude.json"), "mcpServers");
  if (target === "claude-desktop") return removeJsonEntry(claudeDesktopFilePath(), "mcpServers");
  if (target === "vscode") return removeJsonEntry(vsCodeFilePath(), "servers");
  if (target === "cursor") return removeJsonEntry(path.join(home, ".cursor", "mcp.json"), "mcpServers");
  console.error("Unsupported client:", target);
  process.exit(1);
}

const restartByClient = {
  codex: "Quit and reopen Codex, then start a new chat (run /mcp to verify " + shownNames + " appears).",
  opencode: "Quit and reopen OpenCode, then start a new session so it reloads opencode.json.",
  "claude-cli": "Exit Claude Code and start a new session so it picks up ~/.claude.json.",
  "claude-desktop": "Fully quit Claude Desktop (Cmd+Q on macOS / File > Exit on Windows - closing the window is not enough), reopen it, then start a new chat.",
  vscode: "Reload VS Code (Cmd/Ctrl+Shift+P -> Developer: Reload Window) or quit and reopen it, then start a new chat.",
  cursor: "Quit and reopen Cursor, then start a new chat (open Cursor Settings > MCP to verify " + shownNames + " appears).",
};

function printRestart() {
  console.log("");
  console.log("[tdei-mcp] === RESTART REQUIRED ===");
  console.log(\`[tdei-mcp] \${restartByClient[client] || "Restart your MCP client, then start a new chat."}\`);
}


// ---- cleanup: remove EVERY tdei / tdei-* entry (tdei, tdei-core-dev, tdei-workspace-prod, ...) ----
const ALL_CLIENTS = ["codex", "opencode", "claude-cli", "claude-desktop", "vscode", "cursor"];
const TDEI_NAME_RE = /^tdei(-[A-Za-z0-9_]+)*$/;

function pruneTdeiKeys(parent) {
  const removed = [];
  if (parent && typeof parent === "object" && !Array.isArray(parent)) {
    for (const key of Object.keys(parent)) {
      if (TDEI_NAME_RE.test(key)) {
        delete parent[key];
        removed.push(key);
      }
    }
  }
  return removed;
}

function cleanupJsonFile(filePath, parentKey, includeProjects) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { filePath, removed: [] };
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return { filePath, removed: [], warning: "not valid JSON (comments?) - left untouched, edit it by hand" };
  }
  if (!root || typeof root !== "object") return { filePath, removed: [] };
  const removed = pruneTdeiKeys(root[parentKey]);
  // Claude Code also keeps per-project servers under projects[<dir>].mcpServers.
  if (includeProjects && root.projects && typeof root.projects === "object") {
    for (const project of Object.values(root.projects)) {
      if (project && typeof project === "object") removed.push(...pruneTdeiKeys(project.mcpServers));
    }
  }
  if (removed.length > 0) fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return { filePath, removed };
}

function cleanupCodex() {
  const filePath = codexFilePath();
  let existing;
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { filePath, removed: [] };
  }
  const removed = [];
  // Also swallows sub-tables such as [mcp_servers.tdei-core-dev.env].
  const pattern = /\\n?\\[mcp_servers\\.(tdei(?:-[A-Za-z0-9_]+)*)(?:\\.[^\\]\\n]*)?\\][\\s\\S]*?(?=\\n\\[|$)/g;
  const cleaned = existing.replace(pattern, (_match, name) => {
    if (!removed.includes(name)) removed.push(name);
    return "";
  });
  if (removed.length > 0) fs.writeFileSync(filePath, cleaned.trimEnd() ? cleaned.trimEnd() + "\\n" : "", "utf-8");
  return { filePath, removed };
}

function cleanupClient(target) {
  if (target === "codex") return cleanupCodex();
  if (target === "opencode")
    return cleanupJsonFile(path.join(home, ".config", "opencode", "opencode.json"), "mcp", false);
  if (target === "claude-cli") return cleanupJsonFile(path.join(home, ".claude.json"), "mcpServers", true);
  if (target === "claude-desktop") return cleanupJsonFile(claudeDesktopFilePath(), "mcpServers", false);
  if (target === "vscode") return cleanupJsonFile(vsCodeFilePath(), "servers", false);
  if (target === "cursor") return cleanupJsonFile(path.join(home, ".cursor", "mcp.json"), "mcpServers", false);
  console.error("Unsupported client:", target);
  process.exit(1);
}

if (action === "cleanup") {
  const targets = client === "all" ? ALL_CLIENTS : [client];
  let total = 0;
  for (const target of targets) {
    const { filePath, removed, warning } = cleanupClient(target);
    if (warning) console.log("[tdei-mcp] WARNING " + target + ": " + filePath + " is " + warning);
    else if (removed.length > 0) console.log("[tdei-mcp] Removed " + removed.join(", ") + " (" + target + ") from " + filePath);
    else console.log("[tdei-mcp] No tdei / tdei-* entries for " + target + " in " + filePath + " - nothing to do.");
    total += removed.length;
  }
  console.log("[tdei-mcp] Removed " + total + " TDEI MCP entr" + (total === 1 ? "y" : "ies") + "; other MCP servers were left untouched.");
  if (total > 0) {
    console.log("");
    console.log("[tdei-mcp] === RESTART REQUIRED ===");
    for (const target of targets) console.log("[tdei-mcp] " + target + ": " + (restartByClient[target] || "restart the app."));
  }
  process.exit(0);
}

if (action === "uninstall") {
  for (const entry of entries) {
    useEntry(entry);
    const { filePath, removed } = removeClientEntry(client);
    if (removed) console.log("[tdei-mcp] Removed " + serverName + " entry (" + client + ") from " + filePath);
    else console.log("[tdei-mcp] No " + serverName + " entry found for " + client + " in " + filePath + " - nothing to do.");
  }
  printRestart();
  const setupUrl = String(primaryMcpUrl).replace(/\\/mcp$/, "") + "/setup/" + client;
  console.log(\`[tdei-mcp] To add TDEI back, re-run the installer: curl -fsSL \${setupUrl} | sh\`);
  process.exit(0);
}

if (action === "update") {
  // Best-effort cleanup so a stale entry shape can never linger; the fresh
  // configure below then rewrites each entry from the current server URL.
  for (const entry of entries) {
    useEntry(entry);
    removeClientEntry(client);
  }
}

for (const entry of entries) {
  useEntry(entry);
  let writtenPath;
  if (client === "codex") writtenPath = configureCodex();
  else if (client === "opencode") writtenPath = configureOpenCode();
  else if (client === "claude-cli") writtenPath = configureClaudeCli();
  else if (client === "claude-desktop") writtenPath = configureClaudeDesktop();
  else if (client === "vscode") writtenPath = configureVsCode();
  else if (client === "cursor") writtenPath = configureCursor();
  else {
    console.error("Unsupported client:", client);
    process.exit(1);
  }
  console.log(
    action === "update"
      ? \`[tdei-mcp] Updated \${client} (\${serverName}) in \${writtenPath}\`
      : \`[tdei-mcp] Configured \${client} (\${serverName}) in \${writtenPath}\`,
  );
  console.log(\`[tdei-mcp] Endpoint: \${mcpUrl} (no token is stored; the TDEI sign-in starts on your first tool call)\`);
}
useEntry(entries[0]);
if (client === "claude-desktop") {
  console.log("[tdei-mcp] Claude Desktop accepts stdio servers only; registered a local npx mcp-remote bridge.");
}
printRestart();
console.log("[tdei-mcp] Then ask your agent to use any TDEI tool. The first call starts the TDEI sign-in: approve the browser login and the call is retried.");
for (const next of [...new Set(entries.map((entry) => entry.profile))]) console.log("[tdei-mcp] " + AFTER_LOGIN[next]);

const parsedMcp = new URL(mcpUrl);
const isLoopbackServer =
  parsedMcp.hostname === "127.0.0.1" ||
  parsedMcp.hostname === "localhost" ||
  parsedMcp.hostname === "::1";

if (!isLoopbackServer && !process.env.TDEI_NO_RELAY) {
  const relayDir = path.join(home, ".tdei-mcp");
  fs.mkdirSync(relayDir, { recursive: true });
  const relayScript = path.join(relayDir, "sso-callback-relay.cjs");
  const relaySource = ${EMBEDDED_RELAY_SOURCE};
  // One relay serves every environment: merge this gateway into the shared
  // targets file (most-recent-first) before (re)writing the script. The
  // running relay — if any — picks the updated file up on the next callback.
  const relayTargetsFile = path.join(relayDir, ${JSON.stringify(RELAY_TARGETS_NAME)});
  let relayCallbacks = [];
  try {
    const parsedTargets = JSON.parse(fs.readFileSync(relayTargetsFile, "utf-8"));
    if (parsedTargets && typeof parsedTargets === "object" && Array.isArray(parsedTargets.callbacks)) {
      relayCallbacks = parsedTargets.callbacks.filter(function (entry) { return typeof entry === "string" && entry.length > 0; });
    }
  } catch {}
  relayCallbacks = [remoteCallbackUrl].concat(relayCallbacks.filter(function (entry) { return entry !== remoteCallbackUrl; })).slice(0, 5);
  try { fs.writeFileSync(relayTargetsFile, JSON.stringify({ callbacks: relayCallbacks }, null, 2) + "\\n", "utf-8"); } catch {}
  fs.writeFileSync(relayScript, relaySource, "utf-8");
  // Replace a relay from an earlier install so it runs the current program
  // (the pid is written next to the script by the relay itself).
  try {
    const oldPid = Number.parseInt(fs.readFileSync(path.join(relayDir, ${JSON.stringify(RELAY_PID_NAME)}), "utf-8").trim(), 10);
    if (Number.isInteger(oldPid) && oldPid > 0) {
      try { process.kill(oldPid); } catch {}
    }
  } catch {}
  const child = spawn(process.execPath, [relayScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log(\`[tdei-mcp] Local SSO callback relay listening on http://127.0.0.1:\${callbackPortRaw}/callback (stays running so client-initiated sign-ins always find it; redirects the browser to this gateway and any other installed TDEI gateway)\`);
}
`;

/** Exposed for tests: the exact JS embedded in both sh and PowerShell installers. */
export function getClientSetupJs(): string {
  return CLIENT_SETUP_JS;
}

export function renderSetupOverview(
  baseUrl: string,
  basePath = "/mcp",
  gatewaySlug?: string,
  profile: TdeiServerProfile = "core",
): string {
  const { origin, mcpUrl, remoteCallbackUrl } = setupUrls(baseUrl, basePath, gatewaySlug);
  const mcpName = clientMcpName(gatewaySlug);
  const prefix = normalizeBasePath(basePath);
  const setupBase = `${origin}${prefix}/setup`;
  return [
    "# TDEI MCP Streamable HTTP Client Setup",
    "",
    `MCP Endpoint: ${mcpUrl}`,
    `Client entry name: ${mcpName}`,
    `Server: ${installCopy(profile).summary}`,
    `Keycloak redirect: ${REGISTERED_SSO_REDIRECT_URI}`,
    `Local relay forwards that to: ${remoteCallbackUrl}`,
    "",
    "macOS / Ubuntu — run one of these on the client machine (needs sh + node, no hardcoded tokens):",
    "",
    "  # Codex (~/.codex/config.toml)",
    `  curl -fsSL ${setupBase}/codex | sh`,
    "",
    "  # OpenCode (~/.config/opencode/opencode.json)",
    `  curl -fsSL ${setupBase}/opencode | sh`,
    "",
    "  # Claude Code CLI (~/.claude.json)",
    `  curl -fsSL ${setupBase}/claude-cli | sh`,
    "",
    "  # Claude Desktop (claude_desktop_config.json)",
    `  curl -fsSL ${setupBase}/claude-desktop | sh`,
    "",
    "  # VS Code (User/mcp.json)",
    `  curl -fsSL ${setupBase}/vscode | sh`,
    "",
    "  # Cursor (~/.cursor/mcp.json)",
    `  curl -fsSL ${setupBase}/cursor | sh`,
    "",
    "Windows (PowerShell 5.1+ with node on PATH) — run one of these:",
    "",
    "  # Codex (%USERPROFILE%\\.codex\\config.toml)",
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/codex.ps1 | iex`,
    "",
    "  # OpenCode (%USERPROFILE%\\.config\\opencode\\opencode.json)",
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/opencode.ps1 | iex`,
    "",
    "  # Claude Code CLI (%USERPROFILE%\\.claude.json)",
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/claude-cli.ps1 | iex`,
    "",
    "  # Claude Desktop (%APPDATA%\\Claude\\claude_desktop_config.json)",
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/claude-desktop.ps1 | iex`,
    "",
    "  # VS Code (%APPDATA%\\Code\\User\\mcp.json)",
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/vscode.ps1 | iex`,
    "",
    "  # Cursor (%USERPROFILE%\\.cursor\\mcp.json)",
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/cursor.ps1 | iex`,
    "",
    "Update / reinstall (MCP broken after a server move? run this, then restart the app):",
    `Safe to re-run — replaces only the ${mcpName} entry, keeps every other entry.`,
    "Swap in your client (codex, opencode, claude-cli, claude-desktop, vscode, cursor):",
    "",
    `  curl -fsSL ${setupBase}/update/codex | sh`,
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/update/codex.ps1 | iex`,
    "",
    `Uninstall (removes only the ${mcpName} entry, keeps every other entry):`,
    "",
    `  curl -fsSL ${setupBase}/uninstall/codex | sh`,
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/uninstall/codex.ps1 | iex`,
    "",
    `Clean up (removes EVERY tdei / tdei-* entry, e.g. tdei-core-dev, tdei-workspace-prod; keeps all other servers):`,
    'Use a client name, or "all" to sweep every supported client on this machine:',
    "",
    `  curl -fsSL ${setupBase}/cleanup/claude-desktop | sh`,
    `  curl -fsSL ${setupBase}/cleanup/all | sh`,
    `  Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${setupBase}/cleanup/all.ps1 | iex`,
    "",
    "Combined install (core + workspace of one environment in a single command): add ?with=<other-entry>",
    `to any install / update / uninstall URL, for example (quote the URL):`,
    "",
    `  curl -fsSL '${setupBase}/claude-desktop?with=tdei-workspace-dev' | sh`,
    "",
    "Fix-it flow for a colleague: 1) run the update command above,",
    "2) fully restart the app (see table below), 3) start a NEW chat and log",
    "in again when the first tool call asks. Still broken? Uninstall, restart, reinstall.",
    "",
    "=== RESTART REQUIRED (do this right after the installer) ===",
    `The client only picks up the new ${mcpName} entry on a full restart. Closing a`,
    "chat window is not enough — restart the app, then start a NEW chat/session:",
    "",
    `  # Codex:            quit and reopen Codex, then new chat (run /mcp to verify ${mcpName}).`,
    "  # OpenCode:         quit and reopen OpenCode, then start a new session.",
    "  # Claude Code CLI:  exit Claude Code and start a new session (reloads ~/.claude.json).",
    "  # Claude Desktop:   fully quit with Cmd+Q (macOS) or File > Exit (Windows),",
    "  #                   reopen it, then start a new chat.",
    "  # VS Code:          Cmd/Ctrl+Shift+P -> Developer: Reload Window (or quit + reopen).",
    `  # Cursor:           quit and reopen Cursor, then start a new chat (verify ${mcpName}).`,
    "",
    "Then ask your agent to use any TDEI tool. The first call starts the TDEI sign-in: approve the browser login and the call is retried.",
    installCopy(profile).afterLogin,
    "",
  ].join("\n");
}

export function renderClientSetupScript(
  client: SetupScriptTarget,
  baseUrl: string,
  callbackPort = 8765,
  action: SetupScriptAction = "install",
  basePath = "/mcp",
  gatewaySlug?: string,
  profile: TdeiServerProfile = "core",
  extraNames: readonly string[] = [],
): string {
  const { origin, mcpUrl, remoteCallbackUrl } = setupUrls(baseUrl, basePath, gatewaySlug);
  const mcpName = clientMcpName(gatewaySlug);
  const extra = extraEntryArgs(extraNames, origin, basePath, gatewaySlug?.trim() || undefined, mcpName);

  return `#!/usr/bin/env sh
set -eu

CLIENT=${JSON.stringify(client)}
MCP_URL=${JSON.stringify(mcpUrl)}
REMOTE_CALLBACK_URL=${JSON.stringify(remoteCallbackUrl)}
CALLBACK_PORT=${JSON.stringify(String(callbackPort))}
ACTION=${JSON.stringify(action)}
SERVER_NAME=${JSON.stringify(mcpName)}
PROFILE=${JSON.stringify(profile)}
EXTRA_ENTRIES=${JSON.stringify(extra.join(" "))}

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required on the client machine to configure $CLIENT." >&2
  exit 1
fi

# EXTRA_ENTRIES is deliberately unquoted: it is a space-separated list of name|profile|url words.
set -f
# shellcheck disable=SC2086
node - "$CLIENT" "$MCP_URL" "$REMOTE_CALLBACK_URL" "$CALLBACK_PORT" "$ACTION" "$SERVER_NAME" "$PROFILE" $EXTRA_ENTRIES <<'EOF'
${CLIENT_SETUP_JS}EOF
`;
}

export function renderClientSetupPowershell(
  client: SetupScriptTarget,
  baseUrl: string,
  callbackPort = 8765,
  action: SetupScriptAction = "install",
  basePath = "/mcp",
  gatewaySlug?: string,
  profile: TdeiServerProfile = "core",
  extraNames: readonly string[] = [],
): string {
  const { origin, mcpUrl, remoteCallbackUrl } = setupUrls(baseUrl, basePath, gatewaySlug);
  const mcpName = clientMcpName(gatewaySlug);
  const extra = extraEntryArgs(extraNames, origin, basePath, gatewaySlug?.trim() || undefined, mcpName);

  return `# TDEI MCP client setup (${client}, action: ${action}, entry: ${mcpName})
# Run with: Set-ExecutionPolicy Bypass -Scope Process -Force; irm <server>/mcp/setup/${setupActionPath(client, action)}.ps1 | iex
$ErrorActionPreference = "Stop"

$Client = ${psQuote(client)}
$McpUrl = ${psQuote(mcpUrl)}
$RemoteCallbackUrl = ${psQuote(remoteCallbackUrl)}
$CallbackPort = ${Number(callbackPort) || 8765}
$Action = ${psQuote(action)}
$ServerName = ${psQuote(mcpName)}
$Profile = ${psQuote(profile)}
$ExtraEntries = @(${extra.map(psQuote).join(", ")})

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is required on this machine to configure $Client. Install Node.js 22+ from https://nodejs.org/ and re-run this script."
  exit 1
}

$setupJs = @'
${CLIENT_SETUP_JS}'@

$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("tdei-mcp-setup-" + [Guid]::NewGuid().ToString("N") + ".cjs")
Set-Content -Path $tempFile -Value $setupJs -Encoding utf8NoBOM
try {
  & node $tempFile $Client $McpUrl $RemoteCallbackUrl "$CallbackPort" $Action $ServerName $Profile @ExtraEntries
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
}
`;
}
