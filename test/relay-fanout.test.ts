import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildRelayProgram,
  mergeRelayTargets,
  RELAY_PORT,
  stopCallbackRelay,
  writeRelayFiles,
} from "../src/setup/relay.js";

const execFileAsync = promisify(execFile);

test("mergeRelayTargets keeps most-recent-first, deduped, capped", () => {
  assert.deepEqual(mergeRelayTargets([], "https://a/auth/callback"), ["https://a/auth/callback"]);
  assert.deepEqual(mergeRelayTargets(["https://a/auth/callback"], "https://b/auth/callback"), [
    "https://b/auth/callback",
    "https://a/auth/callback",
  ]);
  // Re-installing the same gateway moves it to the front without duplicating.
  assert.deepEqual(
    mergeRelayTargets(["https://a/auth/callback", "https://b/auth/callback"], "https://b/auth/callback"),
    ["https://b/auth/callback", "https://a/auth/callback"],
  );
  const many = ["1", "2", "3", "4", "5"].map((n) => `https://gw${n}/auth/callback`);
  assert.equal(mergeRelayTargets(many, "https://new/auth/callback").length, 5);
});

test("relay program is syntactically valid and pins the single loopback port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-relay-src-"));
  try {
    const file = join(dir, "relay.cjs");
    writeFileSync(file, buildRelayProgram(["https://gw.example/auth/callback"], RELAY_PORT), "utf-8");
    await execFileAsync(process.execPath, ["--check", file]);
    const src = readFileSync(file, "utf-8");
    assert.match(src, /const port = 8765;/);
    assert.match(src, /sso-callback-targets\.json/);
    assert.match(src, /sso-callback-relay\.pid/);
    // It must stay up: client-initiated OAuth cannot start it on demand.
    assert.doesNotMatch(src, /IDLE_MS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function startFakeGateway(
  handler: (url: URL, headers: Record<string, string | string[] | undefined>) => FakeResponse,
): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const out = handler(url, req.headers);
    res.writeHead(out.status, {
      "Content-Type": "text/html; charset=utf-8",
      ...out.headers,
    });
    res.end(out.body ?? "");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Minimal browser: follows redirects and keeps cookies per origin. */
async function browserVisit(
  startUrl: string,
  jar: Map<string, string>,
): Promise<{ status: number; body: string; url: string }> {
  let current = startUrl;
  for (let hop = 0; hop < 10; hop += 1) {
    const origin = new URL(current).origin;
    const cookie = jar.get(origin);
    const res = await fetch(current, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
    for (const setCookie of res.headers.getSetCookie()) {
      const value = setCookie.split(";")[0]?.trim();
      if (value) jar.set(origin, value);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`redirect without Location from ${current}`);
      current = new URL(location, current).toString();
      await res.arrayBuffer();
      continue;
    }
    return { status: res.status, body: await res.text(), url: current };
  }
  throw new Error(`too many redirects starting at ${startUrl}`);
}

async function runRelayOn(port: number, home: string, fallback: readonly string[]): Promise<ChildProcess> {
  const script = join(home, "relay-under-test.cjs");
  writeFileSync(script, buildRelayProgram(fallback, port), "utf-8");
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, HOME: home },
    stdio: "ignore",
  });
  // Wait for the listen socket.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return child;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`relay did not come up on 127.0.0.1:${port}`);
}

test("relay redirects the browser so each gateway receives its own login cookie", async () => {
  const home = mkdtempSync(join(tmpdir(), "tdei-relay-home-"));
  const relayPort = 18765;
  let relay: ChildProcess | undefined;
  const gateways: Server[] = [];
  try {
    // The first gateway has no pending login: it bounces the browser back to
    // the relay, exactly like the real gateway's no-pending-login page.
    const wrong = await startFakeGateway((url) => {
      const back = new URL(`http://127.0.0.1:${relayPort}/callback`);
      back.search = url.search;
      return { status: 302, headers: { Location: back.toString() } };
    });
    gateways.push(wrong.server);
    // The second gateway only completes when the BROWSER sends its own
    // origin-scoped tdei_oauth cookie. A server-side relay proxy cannot.
    const right = await startFakeGateway((_url, headers) =>
      headers.cookie === "tdei_oauth=ready"
        ? { status: 200, headers: { "Set-Cookie": "tdei_done=1; Path=/" }, body: "<h1>Login complete</h1>" }
        : { status: 404, body: "no pending login" },
    );
    gateways.push(right.server);
    // The relay reads its targets from HOME/.tdei-mcp on every callback; the
    // fallback list is empty so the file must be honored for success.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".tdei-mcp"), { recursive: true });
    writeFileSync(
      join(home, ".tdei-mcp", "sso-callback-targets.json"),
      JSON.stringify({ callbacks: [`${wrong.url}/auth/callback`, `${right.url}/auth/callback`] }),
      "utf-8",
    );
    relay = await runRelayOn(relayPort, home, []);

    // First hop is a redirect, not a proxied request.
    const first = await fetch(`http://127.0.0.1:${relayPort}/callback?code=abc&state=def`, { redirect: "manual" });
    assert.equal(first.status, 302);
    const location = new URL(first.headers.get("location") ?? "");
    assert.equal(location.origin, wrong.url);
    assert.equal(location.searchParams.get("tdei_relay_try"), "1");
    assert.equal(location.searchParams.get("code"), "abc");
    await first.arrayBuffer();

    // Browser-like follow: wrong gateway bounces, right gateway sees its cookie.
    const jar = new Map<string, string>([[right.url, "tdei_oauth=ready"]]);
    const result = await browserVisit(`http://127.0.0.1:${relayPort}/callback?code=abc&state=def`, jar);
    assert.equal(result.status, 200);
    assert.match(result.body, /Login complete/);
  } finally {
    relay?.kill();
    for (const server of gateways) await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test("stopCallbackRelay stops the pid recorded by the previous install", async () => {
  const home = mkdtempSync(join(tmpdir(), "tdei-relay-stop-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".tdei-mcp"), { recursive: true });
    writeFileSync(join(home, ".tdei-mcp", "sso-callback-relay.pid"), String(child.pid), "utf-8");
    assert.equal(stopCallbackRelay(home), true);
    await exited;
    assert.equal(child.signalCode, "SIGTERM");
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
});

test("relay files merge gateways across installs into one targets file", () => {
  const home = mkdtempSync(join(tmpdir(), "tdei-relay-install-"));
  try {
    // writeRelayFiles never spawns: no live listener is touched.
    const first = writeRelayFiles(home, "https://gw-dev.example", 18766);
    assert.match(first.script, /sso-callback-relay\.cjs$/);
    const second = writeRelayFiles(home, "https://gw-prod.example", 18767);
    assert.equal(second.script, first.script);
    assert.deepEqual(second.targets, ["https://gw-prod.example/auth/callback", "https://gw-dev.example/auth/callback"]);
    const targets = JSON.parse(readFileSync(join(home, ".tdei-mcp", "sso-callback-targets.json"), "utf-8")) as {
      callbacks: string[];
    };
    assert.deepEqual(targets.callbacks, second.targets);
    const script = readFileSync(first.script, "utf-8");
    assert.match(script, /gw-prod\.example\/auth\/callback/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
