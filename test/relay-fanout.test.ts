import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildRelayProgram, mergeRelayTargets, RELAY_PORT, writeRelayFiles } from "../src/setup/relay.js";

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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function startFakeGateway(handler: (url: URL) => { status: number; body: string; location?: string }): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const out = handler(url);
    res.writeHead(out.status, {
      "Content-Type": "text/html; charset=utf-8",
      ...(out.location ? { Location: out.location } : {}),
    });
    res.end(out.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
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

test("relay forwards one loopback callback to the gateway holding the login", async () => {
  const home = mkdtempSync(join(tmpdir(), "tdei-relay-home-"));
  let relay: ChildProcess | undefined;
  const gateways: Server[] = [];
  try {
    const wrong = await startFakeGateway(() => ({ status: 404, body: "no pending login here" }));
    gateways.push(wrong.server);
    const right = await startFakeGateway((url) =>
      url.pathname === "/auth/callback" && url.searchParams.has("code")
        ? { status: 200, body: "<h1>Login complete</h1>" }
        : { status: 404, body: "nope" },
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
    relay = await runRelayOn(18765, home, []);
    const res = await fetch("http://127.0.0.1:18765/callback?code=abc&state=def");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Login complete/);
  } finally {
    relay?.kill();
    for (const server of gateways) await new Promise((resolve) => server.close(resolve));
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
