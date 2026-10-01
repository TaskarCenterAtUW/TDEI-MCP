import { strict as assert } from "node:assert";
import test from "node:test";
import { checkPreflight, uvInstallCommand } from "../src/init/preflight.js";

function fakeExec(opts: { uvxAfterInstall?: "path" | "candidate" | "never"; installFails?: boolean }) {
  const calls: string[] = [];
  let installed = false;
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "node") return { stdout: "v22.1.0\n" };
    if (cmd === "powershell" || cmd === "sh") {
      if (opts.installFails) throw new Error("network down");
      installed = true;
      return { stdout: "" };
    }
    if (cmd === "uvx") {
      if (installed && opts.uvxAfterInstall === "path") return { stdout: "uvx 0.9.0\n" };
      throw new Error("ENOENT");
    }
    if (cmd.endsWith("uvx") || cmd.endsWith("uvx.exe")) {
      if (installed && opts.uvxAfterInstall === "candidate") return { stdout: "uvx 0.9.0\n" };
      throw new Error("ENOENT");
    }
    throw new Error(`unexpected ${cmd}`);
  };
  return { exec, calls };
}

test("uv installer commands are the official astral.sh ones", () => {
  assert.match(uvInstallCommand("win32").display, /irm https:\/\/astral\.sh\/uv\/install\.ps1 \| iex/);
  assert.match(uvInstallCommand("linux").display, /curl -LsSf https:\/\/astral\.sh\/uv\/install\.sh \| sh/);
});

test("missing uvx + no consent => error with manual install command and docs", async () => {
  const { exec, calls } = fakeExec({});
  await assert.rejects(checkPreflight(exec, { platform: "linux", confirmInstall: async () => false }), /uvx not found.*docs\.astral\.sh\/uv.*curl -LsSf/s);
  assert.ok(!calls.some((c) => c.startsWith("sh ")));
});

test("missing uvx + consent => installs, re-checks PATH", async () => {
  const { exec, calls } = fakeExec({ uvxAfterInstall: "path" });
  const r = await checkPreflight(exec, { platform: "linux", confirmInstall: async () => true });
  assert.equal(r.uvxVersion, "uvx 0.9.0");
  assert.ok(calls.some((c) => c.startsWith("sh -c")));
});

test("installed but not on PATH => finds ~/.local/bin and warns to restart", async () => {
  const { exec } = fakeExec({ uvxAfterInstall: "candidate" });
  const logs: string[] = [];
  const r = await checkPreflight(exec, { platform: "win32", home: "C:/Users/me", confirmInstall: async () => true, log: (m) => logs.push(m) });
  assert.equal(r.uvxVersion, "uvx 0.9.0");
  assert.match(logs.join("\n"), /not on this shell's PATH.*restart your MCP client/s);
});

test("installer failure and still-missing uvx are reported with next steps", async () => {
  await assert.rejects(checkPreflight(fakeExec({ installFails: true }).exec, { platform: "linux", confirmInstall: async () => true }), /uv installation failed: network down.*docs\.astral\.sh/s);
  await assert.rejects(checkPreflight(fakeExec({ uvxAfterInstall: "never" }).exec, { platform: "linux", confirmInstall: async () => true }), /installer finished but uvx was not found/);
});

test("node missing gives an install hint instead of a raw ENOENT", async () => {
  await assert.rejects(checkPreflight(async () => { throw new Error("ENOENT"); }), /node not found on PATH.*nodejs\.org/s);
});
