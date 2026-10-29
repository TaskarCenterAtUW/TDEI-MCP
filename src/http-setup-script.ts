export type SetupClientTarget = "codex" | "opencode" | "claude-cli" | "claude-desktop" | "vscode";

const SETUP_CLIENTS: readonly SetupClientTarget[] = [
  "codex",
  "opencode",
  "claude-cli",
  "claude-desktop",
  "vscode",
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

function setupUrls(baseUrl: string): { origin: string; mcpUrl: string; remoteCallbackUrl: string } {
  const origin = baseUrl.replace(/\/$/, "");
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    remoteCallbackUrl: `${origin}/auth/callback`,
  };
}

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === "/") return "";
  return basePath.endsWith("/") && basePath.length > 1 ? basePath.slice(0, -1) : basePath;
}

/** Escape a value for a PowerShell single-quoted string literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Shared client-configuration program (CommonJS, `require` only — no deps).
 * Runs identically on macOS, Ubuntu, and Windows under any Node 22+.
 * argv: [node, script, client, mcpUrl, remoteCallbackUrl, callbackPort].
 * Embedded by both the POSIX sh wrapper and the PowerShell wrapper.
 */
const CLIENT_SETUP_JS = `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [, , client, mcpUrl, remoteCallbackUrl, callbackPortRaw] = process.argv;
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
    .replace(/\\n?\\[mcp_servers\\.tdei\\][\\s\\S]*?(?=\\n\\[|$)/g, "")
    .trimEnd();
  const block = [
    "[mcp_servers.tdei]",
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
  root.mcp.tdei = {
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
  root.mcpServers.tdei = {
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
  root.mcpServers.tdei = claudeDesktopStdioEntry(mcpUrl);
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
  root.servers.tdei = {
    type: "http",
    url: mcpUrl,
  };
  fs.writeFileSync(filePath, JSON.stringify(root, null, 2) + "\\n", "utf-8");
  return filePath;
}

let writtenPath;
if (client === "codex") writtenPath = configureCodex();
else if (client === "opencode") writtenPath = configureOpenCode();
else if (client === "claude-cli") writtenPath = configureClaudeCli();
else if (client === "claude-desktop") writtenPath = configureClaudeDesktop();
else if (client === "vscode") writtenPath = configureVsCode();
else {
  console.error("Unsupported client:", client);
  process.exit(1);
}

const restartByClient = {
  codex: "Quit and reopen Codex, then start a new chat (run /mcp to verify tdei appears).",
  opencode: "Quit and reopen OpenCode, then start a new session so it reloads opencode.json.",
  "claude-cli": "Exit Claude Code and start a new session so it picks up ~/.claude.json.",
  "claude-desktop": "Fully quit Claude Desktop (Cmd+Q on macOS / File > Exit on Windows - closing the window is not enough), reopen it, then start a new chat.",
  vscode: "Reload VS Code (Cmd/Ctrl+Shift+P -> Developer: Reload Window) or quit and reopen it, then start a new chat.",
};

console.log(\`[tdei-mcp] Configured \${client} in \${writtenPath}\`);
console.log(\`[tdei-mcp] Endpoint: \${mcpUrl} (no hardcoded token; authenticate via tdei_sso_login tool call)\`);
if (client === "claude-desktop") {
  console.log("[tdei-mcp] Claude Desktop accepts stdio servers only; registered a local npx mcp-remote bridge.");
}
console.log("");
console.log("[tdei-mcp] === RESTART REQUIRED ===");
console.log(\`[tdei-mcp] \${restartByClient[client] || "Restart your MCP client, then start a new chat."}\`);
console.log("[tdei-mcp] Then ask your agent to log in to TDEI (it calls tdei_sso_login).");

const parsedMcp = new URL(mcpUrl);
const isLoopbackServer =
  parsedMcp.hostname === "127.0.0.1" ||
  parsedMcp.hostname === "localhost" ||
  parsedMcp.hostname === "::1";

if (!isLoopbackServer && !process.env.TDEI_NO_RELAY) {
  const relayDir = path.join(home, ".tdei-mcp");
  fs.mkdirSync(relayDir, { recursive: true });
  const relayScript = path.join(relayDir, "sso-callback-relay.cjs");
  const relayCode = \`const http = require("node:http");
const targetBase = \${JSON.stringify(remoteCallbackUrl)};
const port = Number(\${JSON.stringify(callbackPortRaw)}) || 8765;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1:" + port);
  if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
    const dest = new URL(targetBase);
    dest.search = url.search;
    res.writeHead(302, { Location: dest.toString(), "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, targetBase }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
server.on("error", () => process.exit(0));
server.listen(port, "127.0.0.1");
\`;
  fs.writeFileSync(relayScript, relayCode, "utf-8");
  const child = spawn(process.execPath, [relayScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log(\`[tdei-mcp] Local SSO callback relay listening on http://127.0.0.1:\${callbackPortRaw}/callback -> \${remoteCallbackUrl}\`);
}
`;

/** Exposed for tests: the exact JS embedded in both sh and PowerShell installers. */
export function getClientSetupJs(): string {
  return CLIENT_SETUP_JS;
}

export function renderSetupOverview(baseUrl: string, basePath = "/mcp"): string {
  const { origin, mcpUrl } = setupUrls(baseUrl);
  const prefix = normalizeBasePath(basePath);
  const setupBase = `${origin}${prefix}/setup`;
  return [
    "# TDEI MCP Streamable HTTP Client Setup",
    "",
    `MCP Endpoint: ${mcpUrl}`,
    `SSO Callback: ${origin}/auth/callback`,
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
    "=== RESTART REQUIRED (do this right after the installer) ===",
    "The client only picks up the new tdei entry on a full restart. Closing a",
    "chat window is not enough — restart the app, then start a NEW chat/session:",
    "",
    "  # Codex:            quit and reopen Codex, then new chat (run /mcp to verify tdei).",
    "  # OpenCode:         quit and reopen OpenCode, then start a new session.",
    "  # Claude Code CLI:  exit Claude Code and start a new session (reloads ~/.claude.json).",
    "  # Claude Desktop:   fully quit with Cmd+Q (macOS) or File > Exit (Windows),",
    "  #                   reopen it, then start a new chat.",
    "  # VS Code:          Cmd/Ctrl+Shift+P -> Developer: Reload Window (or quit + reopen).",
    "",
    "Then ask your agent to log in to TDEI (it calls tdei_sso_login).",
    "",
  ].join("\n");
}

export function renderClientSetupScript(
  client: SetupClientTarget,
  baseUrl: string,
  callbackPort = 8765,
): string {
  const { mcpUrl, remoteCallbackUrl } = setupUrls(baseUrl);

  return `#!/usr/bin/env sh
set -eu

CLIENT=${JSON.stringify(client)}
MCP_URL=${JSON.stringify(mcpUrl)}
REMOTE_CALLBACK_URL=${JSON.stringify(remoteCallbackUrl)}
CALLBACK_PORT=${JSON.stringify(String(callbackPort))}

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required on the client machine to configure $CLIENT." >&2
  exit 1
fi

node - "$CLIENT" "$MCP_URL" "$REMOTE_CALLBACK_URL" "$CALLBACK_PORT" <<'EOF'
${CLIENT_SETUP_JS}EOF
`;
}

export function renderClientSetupPowershell(
  client: SetupClientTarget,
  baseUrl: string,
  callbackPort = 8765,
): string {
  const { mcpUrl, remoteCallbackUrl } = setupUrls(baseUrl);

  return `# TDEI MCP client setup (${client})
# Run with: Set-ExecutionPolicy Bypass -Scope Process -Force; irm <server>/mcp/setup/${client}.ps1 | iex
$ErrorActionPreference = "Stop"

$Client = ${psQuote(client)}
$McpUrl = ${psQuote(mcpUrl)}
$RemoteCallbackUrl = ${psQuote(remoteCallbackUrl)}
$CallbackPort = ${Number(callbackPort) || 8765}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is required on this machine to configure $Client. Install Node.js 22+ from https://nodejs.org/ and re-run this script."
  exit 1
}

$setupJs = @'
${CLIENT_SETUP_JS}'@

$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("tdei-mcp-setup-" + [Guid]::NewGuid().ToString("N") + ".cjs")
Set-Content -Path $tempFile -Value $setupJs -Encoding utf8NoBOM
try {
  & node $tempFile $Client $McpUrl $RemoteCallbackUrl "$CallbackPort"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
}
`;
}
