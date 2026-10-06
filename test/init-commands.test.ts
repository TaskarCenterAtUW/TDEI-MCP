import { strict as assert } from "node:assert";
import test from "node:test";
import { runInit, runSwitch, clientConfigDropHint } from "../src/init/commands.js";

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (p: string) => { const v = files.get(p); if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
    writeFile: async (p: string, c: string) => { files.set(p, c); },
    mkdir: async (_p: string) => {},
  };
}
const exec = async (cmd: string) => ({
  stdout: cmd === "node" || cmd === process.execPath || cmd.endsWith("/node")
    ? "v22.0.0\n"
    : "uvx 0.1\n",
});
const logs: string[] = [];
const deps = (fs: ReturnType<typeof memFs>, prompter: unknown) => ({
  exec,
  verify: async () => {},
  isPortFree: async () => true,
  ...fs,
  prompter,
  log: (m: string) => { logs.push(m); },
});

test("runInit writes codex entry end to end", async () => {
  const fs = memFs();
  const summary = await runInit(deps(fs, { chooseEnv: async () => ({ env: "dev" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", serverPath: "/repo/dist/index.js", nodePath: "/usr/bin/node" });
  assert.equal(summary.apiUrl, "https://api-dev.tdei.us");
  assert.equal(summary.client, "codex");
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /api-dev\.tdei\.us/);
  assert.doesNotMatch(fs.files.get("/h/.codex/config.toml") ?? "", /TDEI_SPEC_URL/);
  assert.doesNotMatch(fs.files.get("/h/.codex/config.toml") ?? "", /TDEI_SSO_CLIENT_ID/);
  assert.doesNotMatch(fs.files.get("/h/.codex/config.toml") ?? "", /TDEI_SSO_CALLBACK_URL/);
  assert.match(logs.join("\n"), /TDEI-MCP  ·  Codex Desktop  ·  ready/);
  assert.match(logs.join("\n"), /Fully quit and reopen Codex Desktop/);
  assert.match(logs.join("\n"), /tdei_sso_login/);
  assert.match(logs.join("\n"), /If tools disappear later/);
  assert.match(logs.join("\n"), /may rewrite ~\/\.codex\/config\.toml/);
  assert.match(logs.join("\n"), /node dist\/index\.js init --client codex --env-file \.env\.dev/);
});

test("runInit configures Codex to launch with the selected environment file", async () => {
  const envFile = "TDEI_API_URL=https://api-dev.tdei.us\n";
  const fs = memFs({ "/repo/.env.dev": envFile });
  let verifiedEntry: { args: string[]; env: Record<string, string> } | undefined;
  const d = {
    ...deps(fs, {
      chooseEnv: async () => { throw new Error("environment prompt should not run"); },
      chooseClient: async () => "codex" as const,
    }),
    verify: async (entry: { args: string[]; env: Record<string, string> }) => { verifiedEntry = entry; },
  };

  const summary = await runInit(d as never, {
    client: "codex",
    envFile: "/repo/.env.dev",
    home: "/h",
    local: { root: "/repo", indexPath: "/repo/dist/index.js" },
    nodePath: "/usr/bin/node",
  } as never);

  assert.equal(summary.apiUrl, "https://api-dev.tdei.us");
  assert.equal(summary.callbackUrl, "http://127.0.0.1:8765/callback");
  assert.deepEqual(verifiedEntry?.args, ["--env-file=/repo/.env.dev", "/repo/dist/index.js"]);
  assert.equal(verifiedEntry?.env.TDEI_API_URL, undefined);
  const toml = fs.files.get("/h/.codex/config.toml") ?? "";
  assert.match(toml, /--env-file=\/repo\/\.env\.dev/);
  assert.doesNotMatch(toml, /TDEI_API_URL/);
  await assert.rejects(
    runSwitch(d as never, { client: "codex", env: "stage", home: "/h" }),
    /uses --env-file/,
  );
});

test("runInit rejects conflicting env-file selection flags", async () => {
  const fs = memFs({ "/repo/.env.dev": "TDEI_API_URL=https://api-dev.tdei.us\n" });
  await assert.rejects(
    runInit(deps(fs, {}) as never, {
      client: "codex",
      env: "dev",
      envFile: "/repo/.env.dev",
      home: "/h",
      serverPath: "/repo/dist/index.js",
      nodePath: "/usr/bin/node",
    } as never),
    /--env-file cannot be combined with --env, --url, or --port/,
  );
});

test("runInit custom prints manual and writes nothing", async () => {
  logs.length = 0;
  const fs = memFs();
  const summary = await runInit(deps(fs, { chooseEnv: async () => ({ url: "https://example.com/" }), chooseClient: async () => "custom" as const }) as never, { home: "/h", serverPath: "/repo/dist/index.js", nodePath: "/usr/bin/node", port: 9999 });
  assert.equal(summary.callbackUrl, "http://127.0.0.1:9999/callback");
  assert.deepEqual([...fs.files.keys()], ["/h/.tdei-mcp/tdei.config.json"]);
  assert.match(logs.join("\n"), /Manual MCP setup/);
  assert.match(logs.join("\n"), /re-apply the command, args, working directory, and env/i);
  assert.doesNotMatch(logs.join("\n"), /claude_desktop_config/);
});

test("runInit prints Claude Desktop config-drop recovery", async () => {
  logs.length = 0;
  const fs = memFs();
  const summary = await runInit(deps(fs, {
    chooseEnv: async () => ({ env: "dev" }),
    chooseClient: async () => "claude" as const,
  }) as never, { home: "/h", cwd: "/repo", serverPath: "/repo/dist/index.js", nodePath: "/usr/bin/node" });
  assert.equal(summary.client, "claude");
  assert.match(logs.join("\n"), /may rewrite claude_desktop_config\.json/);
  assert.match(logs.join("\n"), /node dist\/index\.js init --client claude --env-file \.env\.dev/);
});

test("clientConfigDropHint covers vscode without claiming a Desktop rewrite", () => {
  const hint = clientConfigDropHint("vscode");
  assert.match(hint, /\.vscode\/mcp\.json/);
  assert.match(hint, /--client vscode --env-file \.env\.dev/);
  assert.doesNotMatch(hint, /That rewrite cannot be blocked/);
});

test("runSwitch rewrites API URL, keeps port, demands restart", async () => {
  const fs = memFs();
  await runInit(deps(fs, { chooseEnv: async () => ({ env: "dev" }), chooseClient: async () => "codex" as const }) as never, { home: "/h", serverPath: "/repo/dist/index.js", nodePath: "/usr/bin/node", port: 8765 });
  logs.length = 0;
  const summary = await runSwitch(deps(fs, {}) as never, { client: "codex", env: "stage", home: "/h" });
  assert.equal(summary.apiUrl, "https://api-stage.tdei.us");
  assert.match(fs.files.get("/h/.codex/config.toml") ?? "", /api-stage\.tdei\.us/);
  assert.doesNotMatch(fs.files.get("/h/.codex/config.toml") ?? "", /TDEI_SPEC_URL/);
  assert.match(logs.join("\n"), /TDEI-MCP  ·  Codex Desktop  ·  environment updated/);
  assert.match(logs.join("\n"), /may rewrite ~\/\.codex\/config\.toml/);
  await assert.rejects(runSwitch(deps(fs, {}) as never, { client: "claude", env: "prod", home: "/h" }), /no tdei entry found/);
});

test("runSwitch preserves Codex launch fields and unrelated settings", async () => {
  const original = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.tdei]",
    'command = "/custom/node"',
    'args = ["/custom/runtime/dist/index.js"]',
    'cwd = "/custom/runtime"',
    "startup_timeout_sec = 240",
    "tool_timeout_sec = 360",
    "",
    "[mcp_servers.tdei.env]",
    'TDEI_API_URL = "https://api-dev.tdei.us"',
    'TDEI_SPEC_URL = "https://custom/spec.json"',
    'TDEI_SSO_CALLBACK_URL = "http://127.0.0.1:8765/callback"',
    'CUSTOM_VALUE = "keep-me"',
    "",
    "[mcp_servers.other]",
    'command = "other"',
    "",
  ].join("\n");
  const fs = memFs({ "/h/.codex/config.toml": original });

  await runSwitch(deps(fs, {}) as never, { client: "codex", env: "prod", home: "/h" });

  const updated = fs.files.get("/h/.codex/config.toml") ?? "";
  assert.match(updated, /command = "\/custom\/node"/);
  assert.match(updated, /args = \["\/custom\/runtime\/dist\/index\.js"\]/);
  assert.match(updated, /cwd = "\/custom\/runtime"/);
  assert.match(updated, /startup_timeout_sec = 240/);
  assert.match(updated, /tool_timeout_sec = 360/);
  assert.match(updated, /CUSTOM_VALUE = "keep-me"/);
  assert.match(updated, /\[mcp_servers\.other\]/);
  assert.match(updated, /TDEI_API_URL = "https:\/\/api\.tdei\.us"/);
  assert.equal(fs.files.get("/h/.codex/config.toml.tdei.bak"), original);
});

test("checkout init writes absolute Node launch config and scaffolds tdei config", async () => {
  const fs = memFs();
  const d = {
    ...deps(fs, {
      chooseEnv: async () => ({ env: "prod" }),
      chooseClient: async () => "codex" as const,
      confirm: async () => false,
    }),
    verify: async () => {},
    isPortFree: async () => true,
  };
  await runInit(d as never, {
    home: "/h",
    nodePath: "/usr/bin/node",
    port: 8765,
    local: { root: "/repo", indexPath: "/repo/dist/index.js" },
  } as never);

  const toml = fs.files.get("/h/.codex/config.toml") ?? "";
  assert.match(toml, /command = "\/usr\/bin\/node"/);
  assert.match(toml, /args = \["\/repo\/dist\/index\.js"\]/);
  assert.match(toml, /TDEI_CONFIG_PATH = "\/repo\/tdei\.config\.json"/);
  assert.doesNotMatch(toml, /TDEI_SPEC_URL/);
  assert.doesNotMatch(toml, /TDEI_SSO_CALLBACK_URL/);
  assert.match(fs.files.get("/repo/tdei.config.json") ?? "", /"mode": "all"/);
});

test("failed MCP verification leaves the existing Codex config unchanged", async () => {
  const existing = '[mcp_servers.other]\ncommand = "other"\n';
  const fs = memFs({ "/h/.codex/config.toml": existing });
  const d = {
    ...deps(fs, {
      chooseEnv: async () => ({ env: "prod" }),
      chooseClient: async () => "codex" as const,
      confirm: async () => false,
    }),
    verify: async () => { throw new Error("initialize failed"); },
    isPortFree: async () => true,
  };
  await assert.rejects(
    runInit(d as never, {
      home: "/h",
      serverPath: "/repo/dist/index.js",
      port: 8765,
    } as never),
    /initialize failed/,
  );
  assert.equal(fs.files.get("/h/.codex/config.toml"), existing);
  assert.equal(fs.files.get("/h/.codex/config.toml.tdei.bak"), undefined);
});
