import { strict as assert } from "node:assert";
import test from "node:test";
import { runInit, runSwitch } from "../src/init/commands.js";
import { assertPort, findFreePort, portInUseHint } from "../src/init/ports.js";
import { assertCallbackUrl, assertHttpsUrl, resolveApiUrl } from "../src/init/envs.js";

const exec = async (cmd: string) => ({ stdout: cmd === "node" || cmd === process.execPath ? "v22.0.0\n" : "uvx 0.1\n" });
const mem = () => ({ readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, writeFile: async () => {}, mkdir: async () => {} });
const prompter = { chooseEnv: async () => ({ env: "prod" }), chooseClient: async () => "custom" as const, confirm: async () => false };
const baseObj = (isPortFree: (p: number) => Promise<boolean> = async () => true) => ({ exec, verify: async () => {}, ...mem(), prompter, log: () => {}, isPortFree });
const base = (isPortFree?: (p: number) => Promise<boolean>) => baseObj(isPortFree) as never;

test("URL errors name the src/config.ts rule and echo the bad value", () => {
  assert.throws(() => assertHttpsUrl("not a url", "TDEI_API_URL"), /valid absolute URL.*not a url.*src\/config\.ts/s);
  assert.throws(() => assertHttpsUrl("http://x.test", "TDEI_API_URL"), /must use HTTPS.*src\/config\.ts/s);
  assert.throws(() => assertCallbackUrl("http://localhost:8765/callback"), /127\.0\.0\.1.*src\/config\.ts/s);
  assert.throws(() => assertCallbackUrl("garbage"), /src\/config\.ts/);
  assert.throws(() => resolveApiUrl({}), /--env stage\|prod or --url/);
});

test("--port validation and in-use messages tell the user how to free the port", async () => {
  for (const bad of ["abc", 80, 70000, 1.5, ""]) assert.throws(() => assertPort(bad), /--port must be an integer between 1024 and 65535/);
  assert.equal(assertPort("9000"), 9000);
  assert.match(portInUseHint(8765, "win32"), /netstat -ano \| findstr :8765.*taskkill/s);
  assert.match(portInUseHint(8765, "linux"), /lsof -i :8765.*kill/s);
  await assert.rejects(runInit(base(async () => false), { url: "https://api.tdei.us", client: "custom", port: 8765, home: "/h" }), /Port 8765 is in use.*--port/s);
  await assert.rejects(findFreePort(9000, async () => false), /No free loopback port found in 9000-9099/);
});

test("init rejects busy default callback instead of choosing an unregistered port", async () => {
  await assert.rejects(runInit(base(async (p) => p !== 8765), { url: "https://api.tdei.us", client: "custom", home: "/h" }), /Port 8765 is in use/);
});

test("unknown --client is rejected by init and switch", async () => {
  await assert.rejects(runInit(base(), { url: "https://api.tdei.us", client: "emacs" as never, home: "/h" }), /unknown client "emacs" \(expected one of: codex, claude, vscode, custom\)/);
  await assert.rejects(runSwitch(base(), { url: "https://api.tdei.us", client: "emacs" as never, home: "/h" }), /unknown client "emacs"/);
});

test("corrupt client JSON config gives an actionable error", async () => {
  const files: Record<string, string> = {};
  const d = { ...baseObj(), readFile: async (p: string) => { if (p.endsWith("mcp.json")) return "{oops"; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, writeFile: async (p: string, c: string) => { files[p] = c; } } as never;
  await assert.rejects(runInit(d, { url: "https://api.tdei.us", client: "vscode", port: 8765, home: "/h", cwd: "/proj" }), /mcp\.json is not valid JSON.*re-run init/s);
});
