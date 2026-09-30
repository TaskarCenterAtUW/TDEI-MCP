import { strict as assert } from "node:assert";
import test from "node:test";
import { runInit, runSwitch } from "../src/init/commands.js";

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (p: string) => { const v = files.get(p); if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
    writeFile: async (p: string, c: string) => { files.set(p, c); },
    mkdir: async (_p: string) => {},
  };
}
const exec = async (cmd: string) => ({ stdout: cmd === "node" ? "v22.0.0\n" : cmd === process.execPath ? "/usr/bin/node\n" : "uvx 0.1\n" });
const logs: string[] = [];
const deps = (fs: ReturnType<typeof memFs>, prompter: unknown) => ({ exec, ...fs, prompter, log: (m: string) => { logs.push(m); } });

test("runInit writes codex entry end to end", async () => {
  const fs = memFs();
  const summary = await runInit(deps(fs, { chooseEnv: async () => ({ env: "dev" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", nodePath: "/usr/bin/node" });
  assert.equal(summary.apiUrl, "https://api-dev.tdei.us");
  assert.equal(summary.client, "codex");
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /api-dev\.tdei\.us/);
  assert.match(logs.join("\n"), /tdei_sso_login/);
});

test("runInit custom prints manual and writes nothing", async () => {
  const fs = memFs();
  const summary = await runInit(deps(fs, { chooseEnv: async () => ({ url: "https://example.com/" }), chooseClient: async () => "custom" as const }) as never, { home: "/h", nodePath: "/usr/bin/node", port: 9999 });
  assert.equal(summary.callbackUrl, "http://127.0.0.1:9999/callback");
  assert.equal(fs.files.size, 0);
  assert.match(logs.join("\n"), /Manual MCP setup/);
});

test("runSwitch rewrites API URL, keeps port, demands restart", async () => {
  const fs = memFs();
  await runInit(deps(fs, { chooseEnv: async () => ({ env: "dev" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", nodePath: "/usr/bin/node", port: 8765 });
  logs.length = 0;
  const summary = await runSwitch(deps(fs, {}) as never, { client: "codex", env: "stage", home: "/h" });
  assert.equal(summary.apiUrl, "https://api-stage.tdei.us");
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /api-stage\.tdei\.us/);
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /127\.0\.0\.1:8765/);
  assert.match(logs.join("\n"), /restart your MCP client/);
  await assert.rejects(runSwitch(deps(fs, {}) as never, { client: "claude", env: "prod", home: "/h" }), /no tdei entry found/);
});
