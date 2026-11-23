import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { publicAuthCallbackUrl } from "../sso-public-callback.js";

/**
 * Loopback relay: the Keycloak client only accepts
 * http://127.0.0.1:8765/callback, so a small relay on the CLIENT machine
 * forwards that hit to the hosted gateway(s).
 *
 * Lifecycle: the installer registers a login-time service that keeps the
 * relay running (so client-initiated first sign-ins always work). Without
 * that service (TDEI_NO_AUTOSTART, unsupported OS) the relay is started by
 * the installer and exits after 10 minutes idle so the shared
 * loopback port (127.0.0.1:8765) is freed for other tools on the same
 * machine (for example the TDEI-Orchestrator backend, which must bind 8765
 * itself during its own login). The next TDEI sign-in restarts it on demand
 * (see ensureCallbackRelay, called from the login path, or re-run the
 * installer / the one-liner in the login message). Starting it twice is
 * safe: a new start replaces the previous relay before binding the port.
 *
 * One relay serves every environment. Installers merge their gateway into
 * ~/.tdei-mcp/sso-callback-targets.json (most-recent-first); the relay reads
 * that file on every callback and redirects the browser to the first known
 * gateway. When that gateway has no login waiting, it bounces the browser
 * back with RELAY_TRY_PARAM so the relay can try the next one. Each hop is a
 * browser navigation, so the gateway receives its own origin-scoped login
 * cookie (a server-side proxy would lose it). That keeps dev + staging +
 * production side by side on one machine with a single loopback port.
 */
export const RELAY_PORT = 8765;
/** Idle time after which the relay exits so the loopback port is freed. */
export const RELAY_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const RELAY_SCRIPT_NAME = "sso-callback-relay.cjs";
export const RELAY_TARGETS_NAME = "sso-callback-targets.json";
export const RELAY_PID_NAME = "sso-callback-relay.pid";
const MAX_TARGETS = 5;
/** Bumped when the relay program changes; /health reports it so `doctor` can spot a stale relay. */
export const RELAY_VERSION = 2;
export const RELAY_WRAPPER_NAME = "run-relay.sh";
export const RELAY_LOG_NAME = "relay.log";
/** The service log is truncated at this size so it can never fill the disk. */
export const RELAY_LOG_MAX_BYTES = 512 * 1024;
export const RELAY_SERVICE_LABEL = "us.tdei.mcp.sso-relay";
export const RELAY_SYSTEMD_UNIT = "tdei-mcp-sso-relay.service";
export const RELAY_WINDOWS_TASK = "TdeiMcpSsoRelay";

/**
 * Query parameter the relay adds when it sends the browser to a gateway.
 * The gateway echoes it back to the relay when that gateway has no login
 * waiting, so the relay can try the next one. It must survive the redirect
 * chain but must not be forwarded to Keycloak (it never is: it is added
 * after Keycloak's callback).
 */
export const RELAY_TRY_PARAM = "tdei_relay_try";

/** Where the relay program and its files live on the client machine. */
export function relayDir(home: string): string {
  return join(home, ".tdei-mcp");
}

/** Most-recent-first list of gateway callback URLs the relay fans out to. */
export function mergeRelayTargets(existing: readonly string[], gatewayCallbackUrl: string): string[] {
  const next = [gatewayCallbackUrl.trim(), ...existing.map((entry) => entry.trim())].filter(
    (entry) => entry.length > 0,
  );
  return [...new Set(next)].slice(0, MAX_TARGETS);
}

function readRelayTargetsFile(dir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, RELAY_TARGETS_NAME), "utf-8"));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { callbacks?: unknown }).callbacks)) {
      return ((parsed as { callbacks: unknown }).callbacks as unknown[]).filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      );
    }
  } catch {
    // Missing or corrupt: fall back to the list baked into the script.
  }
  return [];
}

/**
 * The relay program source. Runs on plain Node 22+ with no dependencies.
 * `fallbackCallbackUrls` covers a fresh machine before any targets file
 * exists; afterwards the file (shared by every install on the machine) wins.
 */
export function buildRelayProgram(fallbackCallbackUrls: readonly string[], port: number): string {
  return `const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const FALLBACK = ${JSON.stringify([...fallbackCallbackUrls])};
const port = ${port};
const relayDir = path.join(os.homedir(), ".tdei-mcp");
const targetsFile = path.join(relayDir, ${JSON.stringify(RELAY_TARGETS_NAME)});
const pidFile = path.join(relayDir, ${JSON.stringify(RELAY_PID_NAME)});

// --persist: started by the login-time service (launchd/systemd/Task
// Scheduler), so it must stay up and never idle-exit. --install-autostart /
// --remove-autostart register or remove that service and exit.
const ARGS = process.argv.slice(2);
const PERSIST = ARGS.includes("--persist");
if (ARGS.includes("--install-autostart") || ARGS.includes("--remove-autostart")) {
  process.exit(manageAutostart(ARGS.includes("--remove-autostart")) ? 0 : 1);
}

function manageAutostart(remove) {
  const cp = require("node:child_process");
  const dry = process.env.TDEI_AUTOSTART_DRY_RUN === "1";
  const run = (cmd, args) => (dry ? 0 : cp.spawnSync(cmd, args, { stdio: "ignore" }).status);
  const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const home = os.homedir();
  const node = process.execPath;
  const script = __filename;
  const logFile = path.join(relayDir, ${JSON.stringify(RELAY_LOG_NAME)});
  const shq = (v) => "'" + String(v).replace(/'/g, "'\\\\''") + "'";
  // The service runs this wrapper instead of a hard-coded node path: if the
  // node that installed the relay is upgraded or removed (nvm, brew), the
  // wrapper finds another node at start time instead of dying silently.
  const wrapper = path.join(relayDir, ${JSON.stringify(RELAY_WRAPPER_NAME)});
  function writeWrapper() {
    const body = [
      "#!/bin/sh",
      "NODE=" + shq(node),
      '[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null)"',
      'if [ ! -x "$NODE" ]; then',
      '  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME"/.volta/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do',
      '    [ -x "$c" ] && NODE="$c" && break',
      "  done",
      "fi",
      '[ -x "$NODE" ] || { echo "tdei relay: node not found" >&2; exit 1; }',
      'exec "$NODE" ' + shq(script) + " --persist",
      "",
    ].join("\\n");
    fs.writeFileSync(wrapper, body, { mode: 0o755 });
  }
  try {
    if (process.platform === "darwin") {
      const label = "us.tdei.mcp.sso-relay";
      const file = path.join(home, "Library", "LaunchAgents", label + ".plist");
      const domain = "gui/" + (typeof process.getuid === "function" ? process.getuid() : 501);
      run("launchctl", ["bootout", domain + "/" + label]);
      if (remove) { try { fs.unlinkSync(file); } catch {} return true; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeWrapper();
      const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        "<key>Label</key><string>" + label + "</string>",
        "<key>ProgramArguments</key><array><string>/bin/sh</string><string>" + xml(wrapper) + "</string></array>",
        "<key>RunAtLoad</key><true/>",
        "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "<key>StandardOutPath</key><string>" + xml(logFile) + "</string>",
        "<key>StandardErrorPath</key><string>" + xml(logFile) + "</string>",
        "</dict></plist>",
        "",
      ].join("\\n");
      fs.writeFileSync(file, plist, "utf-8");
      return run("launchctl", ["bootstrap", domain, file]) === 0;
    }
    if (process.platform === "linux") {
      const file = path.join(home, ".config", "systemd", "user", "tdei-mcp-sso-relay.service");
      if (remove) {
        run("systemctl", ["--user", "disable", "--now", "tdei-mcp-sso-relay.service"]);
        try { fs.unlinkSync(file); } catch {}
        return true;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeWrapper();
      const unit = [
        "[Unit]",
        "Description=TDEI MCP SSO callback relay",
        "",
        "[Service]",
        "ExecStart=/bin/sh " + shq(wrapper),
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\\n");
      fs.writeFileSync(file, unit, "utf-8");
      if (run("systemctl", ["--user", "daemon-reload"]) !== 0) return false;
      return run("systemctl", ["--user", "enable", "--now", "tdei-mcp-sso-relay.service"]) === 0;
    }
    if (process.platform === "win32") {
      const task = "TdeiMcpSsoRelay";
      if (remove) { run("schtasks", ["/Delete", "/TN", task, "/F"]); return true; }
      const ps = "$n='" + node + "'; if (-not (Test-Path $n)) { $n=(Get-Command node -ErrorAction Stop).Source }; & $n '" + script + "' --persist";
      const command = "powershell.exe -NoProfile -WindowStyle Hidden -Command \\"" + ps + "\\"";
      if (run("schtasks", ["/Create", "/TN", task, "/SC", "ONLOGON", "/TR", command, "/F"]) !== 0) return false;
      return run("schtasks", ["/Run", "/TN", task]) === 0;
    }
  } catch {}
  return false;
}

function targets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(targetsFile, "utf-8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.callbacks)) {
      const list = parsed.callbacks.filter((entry) => typeof entry === "string" && entry.length > 0);
      if (list.length > 0) return list;
    }
  } catch {}
  return FALLBACK;
}

// Long-lived while needed. Client-initiated OAuth (Claude Desktop/Cursor/VS
// Code) redirects the browser to this loopback URL without any chance for
// the agent to start a helper first, so the relay must already be listening
// when a sign-in starts. It is started by the installer (or re-started on
// demand at the next login) and exits after IDLE_TIMEOUT_MS without traffic
// so the shared loopback port is freed for other local tools. Every hop is
// a browser navigation (302), never a server-side proxy, because the
// gateway's pending login lives in an origin-scoped tdei_oauth cookie that
// only the browser can send.
try { fs.mkdirSync(relayDir, { recursive: true }); } catch {}
const logPath = path.join(relayDir, ${JSON.stringify(RELAY_LOG_NAME)});
function capLog() {
  try {
    if (fs.statSync(logPath).size > ${RELAY_LOG_MAX_BYTES}) fs.truncateSync(logPath, 0);
  } catch {}
}
capLog();
if (PERSIST) setInterval(capLog, 60 * 60 * 1000).unref();
try { fs.writeFileSync(pidFile, String(process.pid), "utf-8"); } catch {}

const TRY_PARAM = ${JSON.stringify(RELAY_TRY_PARAM)};
const IDLE_TIMEOUT_MS = ${RELAY_IDLE_TIMEOUT_MS};
let idleTimer = null;
function armIdleTimer() {
  if (PERSIST) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    try {
      const recorded = fs.readFileSync(pidFile, "utf-8").trim();
      if (recorded === String(process.pid)) { try { fs.unlinkSync(pidFile); } catch {} }
    } catch {}
    server.close(() => process.exit(0));
    // If connections keep the server open, force out shortly after.
    setTimeout(() => process.exit(0), 1000).unref();
  }, IDLE_TIMEOUT_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function noPendingPage() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>TDEI sign-in needs attention</title></head>' +
    '<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;line-height:1.5">' +
    '<main style="max-width:520px;margin:10vh auto;text-align:center;border:1px solid #8884;border-radius:16px;padding:36px 32px">' +
    '<h1 style="font-size:24px;margin:16px 0 8px">No sign-in in progress</h1>' +
    '<p>No TDEI gateway on this machine had a login waiting for that callback. It may have finished already or timed out.</p>' +
    '<p><strong>Go back to your client</strong> and start the sign-in again. You can close this tab.</p>' +
    '</main></body></html>';
}

function forward(url, res) {
  const list = targets();
  const requested = Number.parseInt(url.searchParams.get(TRY_PARAM) || "0", 10);
  let index = Number.isFinite(requested) && requested > 0 ? requested : 0;
  let dest = null;
  while (index < list.length && !dest) {
    try {
      dest = new URL(list[index]);
    } catch {
      index += 1;
    }
  }
  if (!dest) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(noPendingPage());
    return;
  }
  dest.search = url.search;
  // Next hop for a gateway that has no pending login (it bounces the browser
  // back here with this marker). The marker is an index into this machine's
  // targets file, so it can never turn into an open redirect.
  dest.searchParams.set(TRY_PARAM, String(index + 1));
  res.writeHead(302, { Location: dest.toString(), "Cache-Control": "no-store" });
  res.end();
}

const server = http.createServer((req, res) => {
  armIdleTimer();
  const url = new URL(req.url || "/", "http://127.0.0.1:" + port);
  if (req.method === "GET" && (url.pathname === "/callback" || url.pathname === "/auth/callback")) {
    forward(url, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "tdei-mcp-sso-relay", version: ${RELAY_VERSION}, persist: PERSIST }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
let listenRetries = 0;
server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    // A reinstall kills the previous relay just before starting this one; a
    // different local backend (for example TDEI-Orchestrator) may also hold
    // the shared port for its own login. The service keeps retrying with
    // backoff, so the relay takes the port back as soon as it is released
    // instead of staying dead until the next login. A detached (non-service)
    // relay gives up after about 5 seconds so it never lingers.
    listenRetries += 1;
    if (!PERSIST && listenRetries > 20) process.exit(0);
    if (listenRetries === 1 || listenRetries % 20 === 0) console.log("port " + port + " is busy; retrying until it is free");
    setTimeout(() => server.listen(port, "127.0.0.1"), Math.min(15000, 250 * Math.pow(2, Math.min(listenRetries, 6))));
    return;
  }
  console.log("relay error: " + (error && error.message));
  process.exit(1);
});
server.on("listening", () => console.log("relay v${RELAY_VERSION} listening on 127.0.0.1:" + port));
server.listen(port, "127.0.0.1");
armIdleTimer();
`;
}

export function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Writes ~/.tdei-mcp/sso-callback-relay.cjs (fan-out over every gateway
 * installed on this machine) and refreshes the shared targets file.
 * No process is started.
 */
export function writeRelayFiles(
  home: string,
  gatewayOrigin: string,
  port: number,
): { script: string; targets: string[] } {
  const dir = relayDir(home);
  mkdirSync(dir, { recursive: true });
  const targetsPath = join(dir, RELAY_TARGETS_NAME);
  const merged = mergeRelayTargets(readRelayTargetsFile(dir), publicAuthCallbackUrl(gatewayOrigin));
  writeFileSync(targetsPath, `${JSON.stringify({ callbacks: merged }, null, 2)}\n`, "utf-8");
  const script = join(dir, RELAY_SCRIPT_NAME);
  writeFileSync(script, buildRelayProgram(merged, port), "utf-8");
  return { script, targets: merged };
}

/**
 * Stops the relay this machine's previous install started, if it is still
 * running. The pid is written next to the relay script. Used before starting
 * a fresh relay so an install picks up the current program instead of leaving
 * a stale listener bound to 127.0.0.1:8765.
 */
export function stopCallbackRelay(home: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(join(relayDir(home), RELAY_PID_NAME), "utf-8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the relay files and makes the relay available. By default it also
 * registers a login-time service (launchd, systemd user unit or Task
 * Scheduler) that keeps the relay running, so a client-initiated first
 * sign-in always finds it listening. If that is unsupported, fails or is
 * disabled (autostart=false or TDEI_NO_AUTOSTART), the relay is started
 * detached instead; that one exits after 10 minutes idle (see
 * RELAY_IDLE_TIMEOUT_MS) and is restarted on demand. Returns the script path.
 */
export function startCallbackRelay(
  home: string,
  gatewayOrigin: string,
  port = RELAY_PORT,
  autostart = !process.env["TDEI_NO_AUTOSTART"],
): string {
  stopCallbackRelay(home);
  const { script } = writeRelayFiles(home, gatewayOrigin, port);
  if (autostart) {
    const installed = spawnSync(process.execPath, [script, "--install-autostart"], {
      stdio: "ignore",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    if (installed.status === 0) return script;
  }
  spawn(process.execPath, [script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return script;
}

/**
 * On-demand restart: ensure the loopback relay is listening, starting it
 * when a TDEI tool call finds the client signed out and the relay has
 * exited after its idle timeout (or was never installed). Returns true when
 * the relay is (now) listening, false when the port is held by something
 * else (for example another backend such as TDEI-Orchestrator) or the relay
 * could not be started.
 */
export async function ensureCallbackRelay(
  home: string,
  gatewayOrigin: string,
  port = RELAY_PORT,
  fetchImpl: typeof fetch = fetch,
): Promise<{ listening: boolean; started: boolean }> {
  try {
    const health = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (health.ok) return { listening: true, started: false };
  } catch {
    // Not listening: fall through and start it.
  }
  try {
    startCallbackRelay(home, gatewayOrigin, port, false);
  } catch {
    return { listening: false, started: false };
  }
  // Wait briefly for the listen socket (or a foreign holder to win).
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const health = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      await health.body?.cancel().catch(() => undefined);
      if (health.ok) return { listening: true, started: true };
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { listening: false, started: true };
}
