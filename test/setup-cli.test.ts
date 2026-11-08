import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { configPath, removeEntries, upsertEntry, type HostEnv } from "../src/setup/clients.js";
import { runSetup, parseSetupArgs } from "../src/setup/cli.js";
import { SetupUsageError } from "../src/setup/errors.js";
import { detectClients, type DetectProbe } from "../src/setup/detect.js";
import { npxPackageSpec, npxSetupCommand, resolveGateway, resolveTargets } from "../src/setup/targets.js";

function withHome<T>(fn: (host: HostEnv) => T): T {
  const home = mkdtempSync(join(tmpdir(), "tdei-setup-"));
  const done = () => rmSync(home, { recursive: true, force: true });
  let result: T;
  try {
    result = fn({ home, platform: "darwin" });
  } catch (error) {
    done();
    throw error;
  }
  if (result instanceof Promise) return result.finally(done) as T;
  done();
  return result;
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const URL_DEV = "https://gw.example.org/tdei-core-dev/mcp";

test("upsert writes each client's remote shape and keeps other entries", () =>
  withHome((host) => {
    put(configPath("cursor", host), JSON.stringify({ mcpServers: { other: { url: "x" } } }));
    upsertEntry("cursor", host, "tdei-core-dev", URL_DEV);
    upsertEntry("claude-cli", host, "tdei-core-dev", URL_DEV);
    upsertEntry("vscode", host, "tdei-core-dev", URL_DEV);
    upsertEntry("opencode", host, "tdei-core-dev", URL_DEV);
    upsertEntry("claude-desktop", host, "tdei-core-dev", URL_DEV);
    upsertEntry("codex", host, "tdei-core-dev", URL_DEV);

    const read = (c: Parameters<typeof configPath>[0]) => JSON.parse(readFileSync(configPath(c, host), "utf-8"));
    assert.deepEqual(read("cursor").mcpServers, { other: { url: "x" }, "tdei-core-dev": { url: URL_DEV } });
    assert.deepEqual(read("claude-cli").mcpServers["tdei-core-dev"], { type: "http", url: URL_DEV });
    assert.deepEqual(read("vscode").servers["tdei-core-dev"], { type: "http", url: URL_DEV });
    assert.equal(read("opencode").mcp["tdei-core-dev"].type, "remote");
    assert.deepEqual(read("claude-desktop").mcpServers["tdei-core-dev"], {
      command: "npx",
      args: ["-y", "mcp-remote", URL_DEV],
    });
    assert.match(readFileSync(configPath("codex", host), "utf-8"), /\[mcp_servers\.tdei-core-dev\]\nurl = /);
  }));

test("upsert is idempotent and replaces only the named codex block", () =>
  withHome((host) => {
    put(
      configPath("codex", host),
      '[mcp_servers.keep]\nurl = "k"\n\n[mcp_servers.tdei-core-dev]\nurl = "old"\n\n[mcp_servers.tdei-core-dev.env]\nA = "1"\n',
    );
    upsertEntry("codex", host, "tdei-core-dev", URL_DEV);
    upsertEntry("codex", host, "tdei-core-dev", URL_DEV);
    const toml = readFileSync(configPath("codex", host), "utf-8");
    assert.equal(toml.match(/\[mcp_servers\.tdei-core-dev\]/g)?.length, 1);
    assert.doesNotMatch(toml, /old|tdei-core-dev\.env/);
    assert.match(toml, /\[mcp_servers\.keep\]/);
  }));

test("a config file that is not plain JSON is skipped, never overwritten", () =>
  withHome((host) => {
    const path = configPath("vscode", host);
    put(path, '{ // comment\n "servers": {} }');
    assert.equal(upsertEntry("vscode", host, "tdei-core-dev", URL_DEV).status, "skipped");
    assert.equal(removeEntries("vscode", host).reason !== undefined, true);
    assert.match(readFileSync(path, "utf-8"), /\/\/ comment/);
  }));

test("remove deletes only tdei / tdei-* entries, including claude project scope and codex sub-tables", () =>
  withHome((host) => {
    put(
      configPath("claude-cli", host),
      JSON.stringify({
        mcpServers: { tdei: {}, "tdei-core-dev": {}, tdeiish: {}, github: {} },
        projects: { "/p": { mcpServers: { "tdei-workspace-prod": {}, mine: {} } } },
      }),
    );
    put(
      configPath("codex", host),
      '[mcp_servers.tdei]\nurl = "a"\n\n[mcp_servers.tdei.env]\nA = "1"\n\n[mcp_servers.keep]\nurl = "k"\n',
    );
    const cli = removeEntries("claude-cli", host);
    assert.deepEqual(cli.removed.sort(), ["tdei", "tdei-core-dev", "tdei-workspace-prod"]);
    const doc = JSON.parse(readFileSync(configPath("claude-cli", host), "utf-8"));
    assert.deepEqual(Object.keys(doc.mcpServers).sort(), ["github", "tdeiish"]);
    assert.deepEqual(Object.keys(doc.projects["/p"].mcpServers), ["mine"]);

    assert.deepEqual(removeEntries("codex", host).removed, ["tdei"]);
    const toml = readFileSync(configPath("codex", host), "utf-8");
    assert.doesNotMatch(toml, /tdei/);
    assert.match(toml, /\[mcp_servers\.keep\]/);
  }));

test("detection reports directories and executables on PATH", () => {
  const host: HostEnv = { home: "/h", platform: "darwin" };
  const probe: DetectProbe = {
    exists: (p) => p === "/h/.cursor" || p === "/h/Library/Application Support/Claude",
    which: (b) => (b === "codex" ? "/usr/bin/codex" : undefined),
  };
  assert.deepEqual(
    detectClients(host, probe).map((d) => d.client),
    ["codex", "claude-desktop", "cursor"],
  );
});

test("targets resolve to <gateway>/<name>/mcp on one shared gateway for every env", () => {
  const gw = resolveGateway();
  assert.deepEqual(
    resolveTargets("dev", "both", gw).map((t) => t.name),
    ["tdei-core-dev", "tdei-workspace-dev"],
  );
  assert.equal(
    resolveTargets("prod", "core", "https://g.example").at(0)?.url,
    "https://g.example/tdei-core-production/mcp",
  );
  for (const env of ["dev", "stage", "prod"] as const) {
    for (const target of resolveTargets(env, "both", gw)) assert.ok(target.url.startsWith(`${gw}/`));
  }
  assert.equal(resolveGateway("https://g.example/"), "https://g.example");
});

test("arg parsing gives actionable messages", () => {
  assert.throws(() => parseSetupArgs(["--env", "nope"]), /Invalid --env "nope"\. Choose one of: dev, stage, prod/);
  assert.throws(() => parseSetupArgs(["--profile", "x"]), /Invalid --profile/);
  assert.throws(() => parseSetupArgs(["--client", "emacs"]), /Unknown client emacs.*Choose from: codex/);
  assert.throws(() => parseSetupArgs(["--bogus"]), /Unknown option --bogus/);
  assert.throws(() => parseSetupArgs(["--env"]), /Missing value for --env\. Example: --env dev/);
  assert.throws(() => parseSetupArgs(["--env", "--yes"]), /Missing value for --env/);
  assert.throws(() => parseSetupArgs(["install"]), /Unexpected argument "install".*cleanup/);
  assert.equal(parseSetupArgs(["--env=stage", "--client=codex,cursor"]).env, "stage");
});

test("missing --env and a bad --gateway give clear errors", async () => {
  await assert.rejects(runSetup(["--yes"], { isTty: false, log: () => {} }), (error: unknown) => {
    assert.ok(error instanceof SetupUsageError);
    assert.match(
      error.message,
      /Missing required option --env.*dev, stage, prod[\s\S]*Example: npx -y github:TaskarCenterAtUW\/TDEI-MCP#[^ ]+ setup --env dev/,
    );
    return true;
  });
  assert.throws(() => resolveGateway("not a url"), /full URL/);
  assert.throws(() => resolveGateway("ftp://x"), /https:\/\//);
});

test("no detected client explains how to name one", async () => {
  const lines: string[] = [];
  const probe: DetectProbe = { exists: () => false, which: () => undefined };
  const code = await runSetup(["--env", "dev", "--yes"], {
    host: { home: "/nowhere", platform: "darwin" },
    probe,
    log: (m) => lines.push(m),
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /No supported MCP client was detected[\s\S]*--client codex\|/);
});

test("setup auto-detects, honours --dry-run, needs --yes off a TTY, then installs and cleans up", async () => {
  await withHome(async (host) => {
    const lines: string[] = [];
    const relays: string[] = [];
    put(join(host.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { url: "x" } } }));
    const probe: DetectProbe = { exists: (p) => p === join(host.home, ".cursor"), which: () => undefined };
    const deps = {
      host,
      probe,
      log: (m: string) => lines.push(m),
      isTty: false,
      startRelay: (_h: string, g: string) => (relays.push(g), ""),
    };
    const base = ["--env", "dev"];

    assert.equal(await runSetup([...base, "--dry-run"], deps), 0);
    assert.doesNotMatch(readFileSync(configPath("cursor", host), "utf-8"), /tdei/);

    assert.equal(await runSetup(base, deps), 1);
    assert.match(lines.join("\n"), /Re-run with --yes/);

    assert.equal(await runSetup([...base, "--yes"], deps), 0);
    const doc = JSON.parse(readFileSync(configPath("cursor", host), "utf-8"));
    assert.deepEqual(Object.keys(doc.mcpServers).sort(), ["other", "tdei-core-dev", "tdei-workspace-dev"]);
    assert.equal(relays.length, 1);
    assert.match(lines.join("\n"), /RESTART REQUIRED/);

    // No --env: prompts when a chooser is available, errors otherwise.
    await assert.rejects(runSetup(["--yes"], deps), /Missing required option --env/);
    assert.equal(await runSetup(["--yes", "--dry-run"], { ...deps, chooseEnv: async () => "dev" }), 0);
    assert.match(lines.join("\n"), /tdei-workspace-dev/);

    assert.equal(await runSetup(["cleanup", "--yes"], deps), 0);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(configPath("cursor", host), "utf-8")).mcpServers), ["other"]);

    assert.equal(
      await runSetup(["--env", "dev", "--yes"], { ...deps, probe: { exists: () => false, which: () => undefined } }),
      1,
    );
  });
});

test("npx package spec pins the deployed commit, falls back to dev, and can be overridden", () => {
  const sha = "fe14c294021b4d5f8a1c0a0d9b3b7c2e6f1a8d90";
  assert.equal(npxPackageSpec(sha, {}), `github:TaskarCenterAtUW/TDEI-MCP#${sha}`);
  assert.equal(npxPackageSpec("unknown", {}), "github:TaskarCenterAtUW/TDEI-MCP#dev");
  assert.equal(npxPackageSpec(undefined, {}), "github:TaskarCenterAtUW/TDEI-MCP#dev");
  assert.equal(npxPackageSpec(sha, { TDEI_NPX_PACKAGE: "tdei-mcp" }), "tdei-mcp");
  assert.equal(npxSetupCommand(sha, {}), `npx -y github:TaskarCenterAtUW/TDEI-MCP#${sha} setup`);
});
