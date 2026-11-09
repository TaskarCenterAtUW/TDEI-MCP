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
 * relay quits after the first callback or 300s idle and is never kept
 * running. Starting it twice is safe: the second copy exits silently when
 * the port is already held.
 *
 * One relay serves every environment. Installers merge their gateway into
 * ~/.tdei-mcp/sso-callback-targets.json (most-recent-first); the relay reads
 * that file on every callback and forwards to each known gateway in turn —
 * the first non-404 answer wins and is replayed to the browser. That keeps
 * dev + staging + production side by side on one machine with a single
 * loopback port.
 */
export const RELAY_PORT = 8765;
export const RELAY_SCRIPT_NAME = "sso-callback-relay.cjs";
export const RELAY_TARGETS_NAME = "sso-callback-targets.json";
export const RELAY_PID_NAME = "sso-callback-relay.pid";
const MAX_TARGETS = 5;

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

// One-shot: quit as soon as the browser has been handed the callback, or after 300s if no sign-in happens.
const IDLE_MS = 300000;
const idle = setTimeout(() => process.exit(0), IDLE_MS);
try { fs.mkdirSync(relayDir, { recursive: true }); } catch {}
try { fs.writeFileSync(pidFile, String(process.pid), "utf-8"); } catch {}

function forward(url, res) {
  const list = targets();
  let index = 0;
  let lastFailure = null;
  const tryNext = () => {
    if (index >= list.length) {
      if (lastFailure) {
        res.writeHead(lastFailure.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(lastFailure.body);
      } else {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("TDEI relay has no gateway to forward to. Re-run your TDEI install command.");
      }
      return;
    }
    const base = list[index++];
    let dest;
    try {
      dest = new URL(base);
    } catch {
      tryNext();
      return;
    }
    dest.search = url.search;
    const get = dest.protocol === "http:" ? require("node:http").get : require("node:https").get;
    const attempt = get(dest, { timeout: 15000 }, (upstream) => {
      // A 404 means "no sign-in is pending on this gateway" — try the next one.
      if (upstream.statusCode === 404) {
        collectFailure(upstream, tryNext);
        return;
      }
      const headers = {};
      for (const name of ["location", "content-type", "cache-control", "set-cookie"]) {
        const value = upstream.headers[name];
        if (typeof value === "string") headers[name] = value;
        else if (Array.isArray(value)) headers[name] = value;
      }
      res.writeHead(upstream.statusCode || 502, headers);
      upstream.pipe(res, { end: true });
      upstream.on("end", () => { clearTimeout(idle); setTimeout(() => process.exit(0), 200); });
    });
    attempt.on("timeout", () => { attempt.destroy(); tryNext(); });
    attempt.on("error", () => { tryNext(); });
  };
  const collectFailure = (upstream, done) => {
    const chunks = [];
    upstream.on("data", (chunk) => chunks.push(chunk));
    upstream.on("end", () => {
      lastFailure = { status: upstream.statusCode || 502, body: Buffer.concat(chunks) };
      done();
    });
  };
  tryNext();
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
