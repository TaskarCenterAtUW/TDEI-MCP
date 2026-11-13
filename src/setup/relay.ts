import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { publicAuthCallbackUrl } from "../sso-public-callback.js";

/**
 * Loopback relay: the Keycloak client only accepts
 * http://127.0.0.1:8765/callback, so a small relay on the CLIENT machine
 * forwards that hit to the hosted gateway(s).
 *
 * Lifecycle: the installer starts the relay and it stays running. A
 * client-initiated OAuth flow opens the browser at the loopback callback with
 * no agent hook to start anything first, so an on-demand-only relay produces
 * ERR_CONNECTION_REFUSED on every later login. Starting it twice is safe: a
 * new install replaces the previous relay before binding the port.
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
const RELAY_SCRIPT_NAME = "sso-callback-relay.cjs";
export const RELAY_TARGETS_NAME = "sso-callback-targets.json";
export const RELAY_PID_NAME = "sso-callback-relay.pid";
const MAX_TARGETS = 5;

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

// Long-lived listener. Client-initiated OAuth (Claude Desktop/Cursor/VS Code)
// redirects the browser to this loopback URL without any chance for the agent
// to start a helper first, so the relay must already be listening. It is
// started by the installer and stays up until the machine restarts or another
// install replaces it. Every hop is a browser navigation (302), never a
// server-side proxy, because the gateway's pending login lives in an
// origin-scoped tdei_oauth cookie that only the browser can send.
try { fs.mkdirSync(relayDir, { recursive: true }); } catch {}
try { fs.writeFileSync(pidFile, String(process.pid), "utf-8"); } catch {}

const TRY_PARAM = ${JSON.stringify(RELAY_TRY_PARAM)};

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
  const url = new URL(req.url || "/", "http://127.0.0.1:" + port);
  if (req.method === "GET" && (url.pathname === "/callback" || url.pathname === "/auth/callback")) {
    forward(url, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "tdei-mcp-sso-relay" }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
let listenRetries = 0;
server.on("error", (error) => {
  // A reinstall kills the previous relay just before starting this one; give
  // that process a moment to release the port instead of silently exiting.
  if (error && error.code === "EADDRINUSE" && listenRetries < 20) {
    listenRetries += 1;
    setTimeout(() => server.listen(port, "127.0.0.1"), 250);
    return;
  }
  process.exit(0);
});
server.listen(port, "127.0.0.1");
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
 * Writes the relay files and starts the relay detached. It stays running so
 * a client-initiated sign-in can reach the loopback callback at any time.
 * Returns the script path.
 */
export function startCallbackRelay(home: string, gatewayOrigin: string, port = RELAY_PORT): string {
  stopCallbackRelay(home);
  const { script } = writeRelayFiles(home, gatewayOrigin, port);
  spawn(process.execPath, [script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return script;
}
