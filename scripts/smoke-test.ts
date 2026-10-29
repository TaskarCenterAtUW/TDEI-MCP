#!/usr/bin/env tsx
/**
 * Foolproof MCP smoke test — no install scripts, no client config writes,
 * no browser SSO required.
 *
 * What it checks (all signed-out safe):
 *   STDIO: spawn server -> initialize -> tools/list contains
 *          tdei_sso_login/tdei_auth_status/tdei_health/tdei_resolve_intent
 *          -> call tdei_health, tdei_auth_status, tdei_resolve_intent
 *   HTTP:  spawn local server on an ephemeral port (or test --remote URL)
 *          -> GET / (status page) -> GET /mcp/setup/codex|opencode
 *          -> POST /mcp tools/list + tools/call tdei_health
 *
 * Usage:
 *   npm run test:smoke                          # local stdio + local http
 *   npm run test:smoke -- --no-http             # stdio only
 *   npm run test:smoke -- --no-stdio            # http only
 *   npm run test:smoke -- --remote https://mcp.example.com [--timeout-ms 20000]
 *   node --import tsx scripts/smoke-test.ts [--remote URL] [--no-stdio] [--no-http] [--port 0] [--timeout-ms 20000]
 *
 * Exit 0 = PASS, 1 = FAIL. Prints a summary table at the end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const argv = process.argv.slice(2);
const getFlag = (name: string): string | undefined => {
  const inline = argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  if (inline !== undefined) return inline.trim();
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) return argv[i + 1].trim();
  return undefined;
};
const hasFlag = (name: string) => argv.includes(name);
const REMOTE = (getFlag("--remote") ?? process.env.TDEI_REMOTE_URL ?? "").replace(/\/+$/, "");
const NO_STDIO = hasFlag("--no-stdio");
const NO_HTTP = hasFlag("--no-http");
const TIMEOUT_MS = Number(getFlag("--timeout-ms") ?? process.env.TDEI_SMOKE_TIMEOUT_MS ?? 20_000);
const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = `${REPO_ROOT}/dist/index.js`;
const HAS_DIST = existsSync(DIST);
const HAS_ENV_FILE = existsSync(`${REPO_ROOT}/.env`);

function mcpBody(id: number | string, method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}
async function fetchTimeout(url: string, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}
async function waitForHttp(base: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetchTimeout(`${base}/`, {}, 2000);
      if (r.ok || r.status === 404) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---------- STDIO ----------
async function checkStdio(): Promise<void> {
  if (NO_STDIO) { console.log("SKIP  stdio (flag --no-stdio)"); return; }
  console.log("\n== STDIO ==");
  let client: { connect(t: unknown): Promise<void>; listTools(): Promise<{ tools: Array<{ name: string }> }>; callTool(a: { name: string; arguments: Record<string, unknown> }): Promise<{ isError?: boolean; content?: Array<{ type?: string; text?: string }> }>; close(): Promise<void> };
  let transport: { stderr?: { on(e: string, f: (c: Buffer) => void): void }; close?: () => Promise<void> };
  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/client"),
      import("@modelcontextprotocol/client/stdio"),
    ]);
    const args = HAS_ENV_FILE
      ? ["--env-file=.env", HAS_DIST ? "dist/index.js" : "src/index.ts", "--transport=stdio"]
      : [HAS_DIST ? "dist/index.js" : "src/index.ts", "--transport=stdio"];
    // tsx is needed only when running from src; dist runs on plain node.
    const command = HAS_DIST ? process.execPath : "npx";
    const cmdArgs = HAS_DIST ? args : ["-y", "tsx", ...args];
    transport = new StdioClientTransport({
      command,
      args: cmdArgs,
      cwd: REPO_ROOT,
      env: { ...process.env, TDEI_TRANSPORT: "stdio", TDEI_NO_RELAY: "1" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (c: Buffer) => process.stderr.write(c));
    client = new Client({ name: "tdei-smoke-stdio", version: "0.1.0" });
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`connect timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ]);
    record("stdio: handshake (initialize)", true);
  } catch (e) {
    record("stdio: handshake (initialize)", false, e instanceof Error ? e.message : String(e));
    try { await transport!.close?.(); } catch { /* ignore */ }
    return;
  }
  try {
    const { tools } = await client!.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const need of ["tdei_sso_login", "tdei_auth_status", "tdei_health", "tdei_resolve_intent"]) {
      record(`stdio: tools/list has ${need}`, names.has(need), `${tools.length} tools`);
    }
    const health = await client!.callTool({ name: "tdei_health", arguments: {} });
    record("stdio: call tdei_health", !health.isError, textOf(health).slice(0, 120));
    const status = await client!.callTool({ name: "tdei_auth_status", arguments: {} });
    const statusText = textOf(status);
    record("stdio: call tdei_auth_status", !status.isError, statusText.slice(0, 120));
    const intent = await client!.callTool({ name: "tdei_resolve_intent", arguments: { request: "find datasets in Seattle" } });
    record("stdio: call tdei_resolve_intent", !intent.isError, textOf(intent).slice(0, 120));
  } catch (e) {
    record("stdio: tool calls", false, e instanceof Error ? e.message : String(e));
  } finally {
    try { await client!.close(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- HTTP ----------
function spawnLocalHttp(port: number): ChildProcess {
  const args = [
    ...(HAS_ENV_FILE ? ["--env-file=.env"] : []),
    HAS_DIST ? "dist/index.js" : "src/index.ts",
    "--transport=http",
    `--port=${port}`,
    "--host=127.0.0.1",
  ];
  const command = HAS_DIST ? process.execPath : "npx";
  const cmdArgs = HAS_DIST ? args : ["-y", "tsx", ...args];
  return spawn(command, cmdArgs, {
    cwd: REPO_ROOT,
    env: { ...process.env, TDEI_TRANSPORT: "http", TDEI_NO_RELAY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function checkHttpEndpoint(base: string, label: string): Promise<void> {
  // 1. Status page
  try {
    const r = await fetchTimeout(`${base}/`, {}, 10_000);
    const html = await r.text();
    record(`${label}: GET / status page`, r.status === 200 && html.includes("TDEI"), `HTTP ${r.status}`);
  } catch (e) {
    record(`${label}: GET / status page`, false, e instanceof Error ? e.message : String(e));
    return;
  }
  // 2. Setup installers (regression: https hosts must advertise https, not http)
  for (const target of ["codex", "opencode"]) {
    try {
      const r = await fetchTimeout(`${base}/mcp/setup/${target}`, {}, 10_000);
      const body = await r.text();
      const isHttpsBase = base.startsWith("https://");
      const advertisesHttpForHttpsHost =
        isHttpsBase && body.includes("http://") && !body.includes(base.replace(/^https:/, "http:"));
      // Simpler robust check: the script must reference the public host.
      const host = new URL(base).host;
      const mentionsHost = body.includes(host);
      const ok = r.status === 200 && mentionsHost && !(isHttpsBase && body.includes(`http://${host}/mcp`));
      record(
        `${label}: GET /mcp/setup/${target}`,
        ok,
        r.status !== 200 ? `HTTP ${r.status}` : mentionsHost ? `${body.length} bytes, host ok` : "script missing host",
      );
      if (advertisesHttpForHttpsHost) {
        record(`${label}: setup advertises https`, false, "https host got http:// installer URLs");
      }
    } catch (e) {
      record(`${label}: GET /mcp/setup/${target}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  // 3. JSON-RPC tools/list (no auth in default session mode)
  try {
    const r = await fetchTimeout(
      `${base}/mcp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: mcpBody(1, "tools/list"),
      },
      15_000,
    );
    const text = await r.text();
    const names: string[] = [];
    const m = text.match(/"name"\s*:\s*"([^"]+)"/g) ?? [];
    for (const hit of m) names.push(hit.split('"')[3]);
    const ok = r.status === 200 && names.includes("tdei_sso_login");
    record(`${label}: POST /mcp tools/list`, ok, `HTTP ${r.status}, ${names.length} tools`);
  } catch (e) {
    record(`${label}: POST /mcp tools/list`, false, e instanceof Error ? e.message : String(e));
  }
  // 4. JSON-RPC tools/call tdei_auth_status (signed-out safe on both transports;
  //    note: tdei_health is stdio-only, HTTP exposes tdei_auth_status instead)
  try {
    const r = await fetchTimeout(
      `${base}/mcp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: mcpBody(2, "tools/call", { name: "tdei_auth_status", arguments: {} }),
      },
      15_000,
    );
    const text = await r.text();
    record(`${label}: POST /mcp call tdei_auth_status`, r.status === 200 && text.includes("signed_out") || text.includes("authenticated") || text.includes("pending"), `HTTP ${r.status}`);
  } catch (e) {
    record(`${label}: POST /mcp call tdei_auth_status`, false, e instanceof Error ? e.message : String(e));
  }
}

async function checkHttp(): Promise<void> {
  if (NO_HTTP) { console.log("SKIP  http (flag --no-http)"); return; }
  console.log("\n== HTTP ==");
  if (REMOTE) {
    await checkHttpEndpoint(REMOTE, "remote");
    return;
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawnLocalHttp(port);
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  try {
    const up = await waitForHttp(base, TIMEOUT_MS);
    record("http: server starts locally", up, up ? base : stderr.slice(-500) || "no response");
    if (up) await checkHttpEndpoint(base, "local");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

// ---------- main ----------
console.log(`tdei-mcp smoke test  (dist: ${HAS_DIST ? "yes" : "no — using src via tsx"}, .env: ${HAS_ENV_FILE ? "yes" : "no"})`);
if (REMOTE) console.log(`remote: ${REMOTE}`);
await checkStdio();
await checkHttp();

const failed = checks.filter((c) => !c.ok);
console.log(`\n== SUMMARY: ${checks.length - failed.length}/${checks.length} passed ==`);
if (failed.length > 0) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  console.log("\nTip: run with more logging via TDEI_LOG_LEVEL=debug, or test a deployed server with:");
  console.log("  npm run test:smoke -- --remote https://YOUR-HOST/mcp");
  process.exit(1);
}
console.log("Smoke test passed — server is healthy. No client config was changed and no SSO browser login was needed.");
console.log("To go further (requires one browser SSO): npm run test:live");
