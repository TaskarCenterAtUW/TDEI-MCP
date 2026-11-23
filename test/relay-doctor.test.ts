import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDoctor } from "../src/setup/doctor.js";
import { RELAY_VERSION, writeRelayFiles } from "../src/setup/relay.js";
import { renderSsoPreflightPage } from "../src/auth/sso-callback-page.js";

const healthy = (version: number | undefined, service = "tdei-mcp-sso-relay") =>
  (async () => new Response(JSON.stringify({ ok: true, service, version }))) as unknown as typeof fetch;
const down = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "tdei-doctor-"));
  writeRelayFiles(home, "https://gw.example", 8765);
  return home;
}

test("doctor passes when script, targets, service and relay version are all good", async () => {
  const home = setup();
  try {
    const lines: string[] = [];
    const code = await runDoctor([], {
      home,
      platform: "darwin",
      log: (m) => lines.push(m),
      fetchImpl: healthy(RELAY_VERSION),
      run: () => ({ status: 0, stdout: "" }),
    });
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes("healthy")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reports a stale relay and a foreign port holder, and --fix restarts the relay", async () => {
  const home = setup();
  try {
    const lines: string[] = [];
    assert.equal(
      await runDoctor([], {
        home,
        platform: "linux",
        log: (m) => lines.push(m),
        fetchImpl: healthy(1),
        run: () => ({ status: 0, stdout: "" }),
      }),
      1,
    );
    assert.ok(lines.some((l) => l.includes("old relay")));

    const foreign: string[] = [];
    await runDoctor([], {
      home,
      platform: "linux",
      log: (m) => foreign.push(m),
      fetchImpl: healthy(undefined, "something-else"),
      run: (cmd) => ({ status: 0, stdout: cmd === "lsof" ? "node 123 holder" : "" }),
    });
    assert.ok(foreign.some((l) => l.includes("held by another program") && l.includes("holder")));

    let restarted = "";
    let up = false;
    const fixed = await runDoctor(["--fix"], {
      home,
      platform: "linux",
      log: () => undefined,
      run: () => ({ status: 0, stdout: "" }),
      restart: (_h, origin) => {
        restarted = origin;
        up = true;
      },
      fetchImpl: (async () => (up ? healthy(RELAY_VERSION)("") : down(""))) as unknown as typeof fetch,
      waitMs: 1500,
    });
    assert.equal(restarted, "https://gw.example");
    assert.equal(fixed, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor --fix cannot repair without a recorded gateway, and says autostart is unsupported elsewhere", async () => {
  const home = mkdtempSync(join(tmpdir(), "tdei-doctor-empty-"));
  try {
    const lines: string[] = [];
    const code = await runDoctor(["--fix"], {
      home,
      platform: "freebsd" as NodeJS.Platform,
      log: (m) => lines.push(m),
      fetchImpl: down,
      run: () => ({ status: 1, stdout: "" }),
    });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("no gateway is recorded")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("autostart wrapper finds node at start time and the service points at it", () => {
  const home = setup();
  try {
    const script = join(home, ".tdei-mcp", "sso-callback-relay.cjs");
    execFileSync(process.execPath, [script, "--install-autostart"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, TDEI_AUTOSTART_DRY_RUN: "1" },
    });
    if (process.platform === "win32") return;
    const wrapper = join(home, ".tdei-mcp", "run-relay.sh");
    assert.ok(existsSync(wrapper));
    const body = readFileSync(wrapper, "utf-8");
    assert.match(body, /command -v node/);
    assert.match(body, /--persist/);
    assert.ok((statSync(wrapper).mode & 0o111) !== 0);
    execFileSync("sh", ["-n", wrapper]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preflight continues on timeout and Safari, retries fast failures, and names the doctor command", () => {
  const page = renderSsoPreflightPage("https://auth.example/x", "http://127.0.0.1:8765/health");
  assert.match(page, /AbortError/);
  assert.match(page, /safari/i);
  assert.match(page, /attempts < 4/);
  assert.match(page, /doctor --fix/);
});
