import { strict as assert } from "node:assert";
import test from "node:test";
import { runInit, runSwitch } from "../src/init/commands.js";

function memFs(initial: Record<string, string> = {}) {
  // Keys are POSIX-style so assertions pass on Windows, where path.join emits backslashes.
  const norm = (p: string) => p.replace(/\\/g, "/");
  const files = new Map(Object.entries(initial).map(([k, v]) => [norm(k), v]));
  return {
    files,
    readFile: async (p: string) => { const v = files.get(norm(p)); if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
    writeFile: async (p: string, c: string) => { files.set(norm(p), c); },
    mkdir: async (_p: string) => {},
  };
}
const exec = async (cmd: string) => ({ stdout: cmd === "node" || cmd === "/usr/bin/node" ? "v22.0.0\n" : cmd === process.execPath ? "v22.0.0\n" : "uvx 0.1\n" });
const logs: string[] = [];
const deps = (fs: ReturnType<typeof memFs>, prompter: unknown) => ({ exec, verify: async () => {}, ...fs, prompter, log: (m: string) => { logs.push(m); }, isPortFree: async () => true });

test("runInit writes codex entry end to end", async () => {
  const fs = memFs();
  const summary = await runInit(deps(fs, { chooseEnv: async () => ({ env: "prod" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", serverPath: "/repo/dist/index.js" });
  assert.equal(summary.apiUrl, "https://api.tdei.us");
  assert.equal(summary.client, "codex");
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /api\.tdei\.us/);
  assert.match(logs.join("\n"), /tdei_sso_login/);
});

test("runInit custom prints manual and writes only the default config", async () => {
  const fs = memFs();
  const summary = await runInit(deps(fs, { chooseEnv: async () => ({ url: "https://example.com/" }), chooseClient: async () => "custom" as const }) as never, { home: "/h", serverPath: "/repo/dist/index.js", port: 9999 });
  assert.equal(summary.callbackUrl, "http://127.0.0.1:9999/callback");
  assert.deepEqual([...fs.files.keys()], ["/h/.tdei-mcp/tdei.config.json"]);
  assert.match(logs.join("\n"), /Manual MCP setup/);
});

test("runSwitch rewrites API URL, keeps port, demands restart", async () => {
  const fs = memFs();
  await runInit(deps(fs, { chooseEnv: async () => ({ env: "prod" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", serverPath: "/repo/dist/index.js", port: 8765 });
  logs.length = 0;
  const summary = await runSwitch(deps(fs, {}) as never, { client: "codex", env: "stage", home: "/h" });
  assert.equal(summary.apiUrl, "https://api-stage.tdei.us");
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /api-stage\.tdei\.us/);
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /127\.0\.0\.1:8765/);
  assert.match(logs.join("\n"), /restart your MCP client/);
  await assert.rejects(runSwitch(deps(fs, {}) as never, { client: "claude", env: "prod", home: "/h" }), /no tdei entry found/);
});

test("runInit from a checkout writes node + dist/index.js and scaffolds config beside it", async () => {
  const fs = memFs();
  await runInit(deps(fs, { chooseEnv: async () => ({ env: "prod" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", nodePath: "/usr/bin/node", port: 8765, local: { root: "/repo", indexPath: "/repo/dist/index.js" } });
  const toml = (fs.files.get("/h/.codex/config.toml") ?? "").replace(/\\\\/g, "/");
  assert.match(toml, /command = "\/usr\/bin\/node"/);
  assert.match(toml, /args = \["\/repo\/dist\/index\.js"\]/);
  assert.match(toml, /TDEI_CONFIG_PATH = "\/repo\/tdei\.config\.json"/);
  assert.match(fs.files.get("/repo/tdei.config.json") ?? "", /"mode": "all"/);
});

test("init never overwrites an existing tdei.config.json", async () => {
  const fs = memFs({ "/h/.tdei-mcp/tdei.config.json": '{"endpoints":{"mode":"deny","deny":["x"]}}' });
  await runInit(deps(fs, { chooseEnv: async () => ({ env: "prod" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", serverPath: "/repo/dist/index.js", port: 8765 });
  assert.match(fs.files.get("/h/.tdei-mcp/tdei.config.json") ?? "", /"deny":\["x"\]/);
});

test("failed handshake leaves existing config untouched", async () => {
  const fs = memFs({ "/h/.codex/config.toml": "[mcp_servers.other]\ncommand = \"other\"\n" });
  const d = deps(fs, {});
  d.verify = async () => { throw new Error("initialize failed"); };
  await assert.rejects(runInit(d as never, { home: "/h", env: "prod", client: "codex", port: 9876 }), /initialize failed/);
  assert.equal(fs.files.get("/h/.codex/config.toml.tdei.bak"), undefined);
  assert.match(fs.files.get("/h/.codex/config.toml")!, /other/);
});

test("repeat setup and switch preserve launch paths and unrelated settings", async () => {
  const fs = memFs({ "/h/.codex/config.toml": "[mcp_servers.other]\ncommand = \"other\"\n" });
  const d = deps(fs, {});
  const opts = { home: "/h", env: "prod", client: "codex" as const, port: 9877, serverPath: "/path with spaces/dist/index.js" };
  await runInit(d as never, opts);
  const first = fs.files.get("/h/.codex/config.toml")!;
  await runInit(d as never, opts);
  assert.equal(fs.files.get("/h/.codex/config.toml"), first);
  fs.files.set("/h/.codex/config.toml", first.replace("startup_timeout_sec = 120", "startup_timeout_sec = 250\nenabled = false"));
  await runSwitch(d as never, { home: "/h", client: "codex", env: "stage" });
  const switched = fs.files.get("/h/.codex/config.toml")!;
  assert.match(switched, /path with spaces/);
  assert.match(switched, /command = "other"/);
  assert.doesNotMatch(switched, /-y/);
  assert.match(switched, /startup_timeout_sec = 250/);
  assert.match(switched, /enabled = false/);
  assert.equal(fs.files.get("/h/.codex/config.toml.tdei.bak"), first.replace("startup_timeout_sec = 120", "startup_timeout_sec = 250\nenabled = false"));
});
