import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { publicAuthCallbackUrl } from "../sso-public-callback.js";

/**
 * Loopback relay: the Keycloak client only accepts
 * http://127.0.0.1:8765/callback, so a small relay on the CLIENT machine
 * forwards that hit to the hosted gateway(s).
 *
 * Lifecycle is strictly on-demand: nothing starts the relay except an
 * install/update (covers the first login right after setup) or the agent at
 * login time (`tdei_sso_login` tells it the one-line start command). The
 * relay quits after 300s idle and is never kept running. Starting it twice is
 * safe: the second copy exits silently when the port is already held.
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
export const RELAY_SCRIPT_NAME = "sso-callback-relay.cjs";
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

export function readRelayTargetsFile(dir: string): string[] {
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

// One-shot: quit after 5 minutes without a callback. The relay stays up long
// enough to bounce the browser between gateways: every hop is a browser
// navigation (302), never a server-side proxy, because the gateway's pending
// login lives in an origin-scoped tdei_oauth cookie that only the browser can
// send. Proxying the callback drops that cookie and the gateway answers
// "No sign-in in progress".
const IDLE_MS = 300000;
setTimeout(() => process.exit(0), IDLE_MS);
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
server.on("error", () => process.exit(0));
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
 * Writes the relay files and starts the relay detached. The relay quits by
 * itself after one callback or 300s idle. Returns the script path.
 */
export function startCallbackRelay(home: string, gatewayOrigin: string, port = RELAY_PORT): string {
  const { script } = writeRelayFiles(home, gatewayOrigin, port);
  spawn(process.execPath, [script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return script;
}
