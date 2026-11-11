/**
 * Pre-commit regression tests for the two installers real users run:
 *
 *  1. `npx -y github:TaskarCenterAtUW/TDEI-MCP#<sha> setup ...` — the command the
 *     status/gateway pages show. Only the parts that can be checked offline are
 *     covered here (package spec + the setup CLI it launches); a live end-to-end
 *     run against GitHub is opt-in with TDEI_INSTALLER_E2E=1.
 *  2. `curl ... | sh` (the served install.sh) — the generated shell wrapper is
 *     executed for real against a throwaway HOME, so shell quoting, the embedded
 *     Node program and the install/update/uninstall/cleanup flows are exercised.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  renderClientSetupPowershell,
  renderClientSetupScript,
  type SetupClientTarget,
} from "../src/http-setup-script.js";
import { configPath, type HostEnv, type SetupClient } from "../src/setup/clients.js";
import { npxPackageSpec, npxSetupCommand } from "../src/setup/targets.js";

const GATEWAY = "https://gw.example.org";
const CORE = "tdei-core-dev";
const WORKSPACE = "tdei-workspace-dev";
const BASE_PATH = `/${CORE}/mcp`;
const CLIENTS: SetupClient[] = ["codex", "opencode", "claude-cli", "claude-desktop", "vscode", "cursor"];

/** npm's own full-SHA test (pacote/lib/git.js): the form that breaks npm 10's npx. */
const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA = "fe14c294021b4d5f8a1c0a0d9b3b7c2e6f1a8d90";

// build-info reads this at import time, so set it before any dynamic import of
// the status page (no static import here pulls build-info in).
process.env["TDEI_MCP_BUILD_SHA"] = SHA;

function tempHome(label = "tdei-install"): string {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

function hostFor(home: string): HostEnv {
  return { home, platform: process.platform };
}

function installerEnv(home: string): NodeJS.ProcessEnv {
  // The relay is a long-lived detached process; tests never need it.
  return { ...process.env, HOME: home, USERPROFILE: home, TDEI_NO_RELAY: "1" };
}

function runShellInstaller(
  client: SetupClientTarget,
  home: string,
  options: { action?: "install" | "update" | "uninstall" | "cleanup"; extraNames?: string[] } = {},
): string {
  const script = renderClientSetupScript(
    client,
    GATEWAY,
    8765,
    options.action ?? "install",
    BASE_PATH,
    CORE,
    "core",
    options.extraNames ?? [],
  );
  const file = join(home, `${client}-${options.action ?? "install"}.sh`);
  writeFileSync(file, script);
  return execFileSync("sh", [file], { env: installerEnv(home), encoding: "utf-8" });
}

/** The map that holds entries in the client's config. */
function entryMap(client: SetupClient, home: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(configPath(client, hostFor(home)), "utf-8")) as Record<string, unknown>;
  const parent = {
    opencode: "mcp",
    "claude-cli": "mcpServers",
    "claude-desktop": "mcpServers",
    vscode: "servers",
    cursor: "mcpServers",
  }[client as Exclude<SetupClient, "codex">] as string;
  return (doc[parent] ?? {}) as Record<string, unknown>;
}

function codexConfig(home: string): string {
  return readFileSync(configPath("codex", hostFor(home)), "utf-8");
}

test("npx specs never pin a full 40-character SHA (npm 10 cannot pack those)", () => {
  // npm 10's npx shortcut: a full SHA is fetched as a hosted tarball, then the
  // package's `prepare` script needs an Arborist that npm exec never passes
  // ("GitFetcher requires an Arborist constructor to pack a tarball").
  const spec = npxPackageSpec(SHA, {});
  const committish = spec.slice(spec.indexOf("#") + 1);
  assert.doesNotMatch(committish, FULL_SHA);
  assert.match(committish, /^[a-f0-9]{7,39}$/);
  assert.ok(SHA.startsWith(committish), "the abbreviated pin must still identify the deployed commit");

  // Shorter pins are already safe: keep them as-is. Invalid values fall back to dev.
  assert.equal(npxPackageSpec("fe14c29", {}), "github:TaskarCenterAtUW/TDEI-MCP#fe14c29");
  assert.equal(npxPackageSpec(SHA.toUpperCase(), {}), "github:TaskarCenterAtUW/TDEI-MCP#fe14c294021b");
  assert.equal(npxPackageSpec("0.1.5+abc", {}), "github:TaskarCenterAtUW/TDEI-MCP#dev");
  assert.doesNotMatch(npxSetupCommand(SHA, {}), /[a-f0-9]{40}/);
});

test("npx setup command is what the pages show and the CLI accepts", () => {
  const command = npxSetupCommand(SHA, {});
  assert.match(
    command,
    /^npx -y github:TaskarCenterAtUW\/TDEI-MCP#[a-f0-9]{7,39} setup$/,
    "users copy this verbatim; it must stay a runnable npx git spec",
  );
});

test("a published npm spec replaces the git fallback everywhere", async () => {
  // The standard path once the CLI is on npm: a registry spec with an exact
  // version. It needs no git, no client-side build, and no SHA workaround.
  assert.equal(npxPackageSpec(SHA, { TDEI_NPX_PACKAGE: "tdei-mcp@0.1.42" }), "tdei-mcp@0.1.42");
  assert.equal(npxSetupCommand(SHA, { TDEI_NPX_PACKAGE: "  tdei-mcp@0.1.42  " }), "npx -y tdei-mcp@0.1.42 setup");

  process.env["TDEI_NPX_PACKAGE"] = "tdei-mcp@0.1.42";
  try {
    const { renderStatusPage } = await import("../src/http-status-page.js");
    const page = renderStatusPage(GATEWAY, "/mcp", CORE, "core");
    assert.match(page, /npx -y tdei-mcp@0\.1\.42 setup --env dev --gateway/);
    assert.doesNotMatch(page, /github:TaskarCenterAtUW\/TDEI-MCP/);
  } finally {
    delete process.env["TDEI_NPX_PACKAGE"];
  }
});

test("the connector status page does not hand out a full-SHA npx command", async () => {
  const { renderStatusPage } = await import("../src/http-status-page.js");
  const page = renderStatusPage(GATEWAY, "/mcp", CORE, "core");
  assert.match(page, /npx -y github:TaskarCenterAtUW\/TDEI-MCP#[a-f0-9]{7,39} setup --env dev --gateway/);
  assert.doesNotMatch(page, new RegExp(`TDEI-MCP#${SHA}`));
});

test("install.sh configures every supported client and keeps other servers", () => {
  for (const client of CLIENTS) {
    const home = tempHome(`tdei-install-${client}`);
    try {
      if (client === "codex") {
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.other]\nurl = "keep-me"\n');
      } else {
        const file = configPath(client, hostFor(home));
        mkdirSync(dirname(file), { recursive: true });
        const parent = {
          opencode: "mcp",
          "claude-cli": "mcpServers",
          "claude-desktop": "mcpServers",
          vscode: "servers",
          cursor: "mcpServers",
        }[client as Exclude<SetupClient, "codex">];
        writeFileSync(file, JSON.stringify({ [parent]: { other: { url: "keep-me" } } }));
      }

      const output = runShellInstaller(client, home);
      assert.match(output, /RESTART REQUIRED/);
      assert.match(output, /no token is stored/);

      const url = `${GATEWAY}/${CORE}/mcp`;
      if (client === "codex") {
        const toml = codexConfig(home);
        assert.match(toml, new RegExp(`\\[mcp_servers\\.${CORE}\\]`));
        assert.match(toml, new RegExp(`url = "${url}"`));
        assert.match(toml, /keep-me/);
        // Re-running must replace, never duplicate, the block.
        runShellInstaller(client, home);
        assert.equal(codexConfig(home).match(new RegExp(`\\[mcp_servers\\.${CORE}\\]`, "g"))?.length, 1);
      } else {
        const entries = entryMap(client, home);
        assert.ok(entries[CORE], `${client}: ${CORE} entry missing`);
        assert.ok(entries["other"], `${client}: unrelated entry was dropped`);
        const entry = entries[CORE] as { url?: string; args?: string[] };
        if (client === "claude-desktop") {
          assert.deepEqual(entry.args, ["-y", "mcp-remote", url]);
        } else {
          assert.equal(entry.url, url);
        }
        runShellInstaller(client, home);
        assert.equal(Object.keys(entryMap(client, home)).filter((name) => name === CORE).length, 1);
      }

      // Uninstall removes only this entry.
      const removed = runShellInstaller(client, home, { action: "uninstall" });
      assert.match(removed, /Removed tdei-core-dev/);
      if (client === "codex") {
        assert.doesNotMatch(codexConfig(home), new RegExp(`mcp_servers\\.${CORE}`));
        assert.match(codexConfig(home), /keep-me/);
      } else {
        assert.equal(entryMap(client, home)[CORE], undefined);
        assert.ok(entryMap(client, home)["other"]);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("install.sh adds the combined core + workspace entries from one command", () => {
  const home = tempHome("tdei-install-with");
  try {
    const output = runShellInstaller("claude-cli", home, { extraNames: [WORKSPACE] });
    assert.match(output, /Configured claude-cli/);
    const entries = entryMap("claude-cli", home) as Record<string, { url: string }>;
    assert.equal(entries[CORE]?.url, `${GATEWAY}/${CORE}/mcp`);
    assert.equal(entries[WORKSPACE]?.url, `${GATEWAY}/${WORKSPACE}/mcp`);

    // Uninstall removes both entries of the combined install and nothing else.
    entries["other"] = { url: "keep-me" };
    writeFileSync(configPath("claude-cli", hostFor(home)), JSON.stringify({ mcpServers: entries }));
    const removed = runShellInstaller("claude-cli", home, { action: "uninstall", extraNames: [WORKSPACE] });
    assert.match(removed, /Removed tdei-core-dev/);
    assert.match(removed, /Removed tdei-workspace-dev/);
    assert.deepEqual(Object.keys(entryMap("claude-cli", home)), ["other"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install.sh works from a HOME with spaces in its path", () => {
  const home = mkdtempSync(join(tmpdir(), "tdei install spaces "));
  try {
    runShellInstaller("cursor", home);
    assert.equal((entryMap("cursor", home)[CORE] as { url: string }).url, `${GATEWAY}/${CORE}/mcp`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

test("the PowerShell installer writes the same entry as install.sh", { skip: !hasPwsh }, () => {
  const home = tempHome("tdei-install-ps1");
  try {
    const file = join(home, "install.ps1");
    writeFileSync(file, renderClientSetupPowershell("cursor", GATEWAY, 8765, "install", BASE_PATH, CORE));
    execFileSync("pwsh", ["-NoProfile", "-File", file], { env: installerEnv(home), encoding: "utf-8" });
    assert.equal((entryMap("cursor", home)[CORE] as { url: string }).url, `${GATEWAY}/${CORE}/mcp`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the CLI launched by npx detects, installs, dry-runs and cleans up", () => {
  const home = tempHome("tdei-install-cli");
  const entryPoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", entryPoint, ...args], {
      env: installerEnv(home),
      encoding: "utf-8",
    });
  try {
    assert.match(run("setup", "--help"), /Usage:[\s\S]*tdei-mcp setup --env dev/);

    // --dry-run prints the plan and writes nothing.
    const dry = run("setup", "--env", "dev", "--gateway", GATEWAY, "--client", "cursor", "--dry-run");
    assert.match(dry, /tdei-core-dev -> https:\/\/gw\.example\.org\/tdei-core-dev\/mcp/);
    assert.match(dry, /tdei-workspace-dev -> https:\/\/gw\.example\.org\/tdei-workspace-dev\/mcp/);
    assert.match(dry, /Dry run: nothing written/);
    assert.equal(existsSync(configPath("cursor", hostFor(home))), false);

    // The real install writes both connectors and tells the user to restart.
    const installed = run("setup", "--env", "dev", "--gateway", GATEWAY, "--client", "cursor", "--yes");
    assert.match(installed, /RESTART REQUIRED/);
    const entries = entryMap("cursor", home) as Record<string, { url: string }>;
    assert.equal(entries[CORE]?.url, `${GATEWAY}/${CORE}/mcp`);
    assert.equal(entries[WORKSPACE]?.url, `${GATEWAY}/${WORKSPACE}/mcp`);

    // cleanup removes every tdei / tdei-* entry.
    assert.match(run("setup", "cleanup", "--client", "cursor", "--yes"), /removed tdei-core-dev, tdei-workspace-dev/);
    assert.deepEqual(Object.keys(entryMap("cursor", home)), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Opt-in: really install the CLI from GitHub the way a user does. Kept out of
// pre-commit because it needs network, git, and HEAD pushed to the repository.
test(
  "npx installs the CLI straight from GitHub at HEAD",
  { skip: process.env["TDEI_INSTALLER_E2E"] !== "1", timeout: 10 * 60_000 },
  () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const home = tempHome("tdei-install-e2e");
    try {
      const output = execFileSync(
        "npx",
        [
          "-y",
          npxPackageSpec(sha, {}),
          "setup",
          "--env",
          "dev",
          "--gateway",
          GATEWAY,
          "--client",
          "cursor",
          "--dry-run",
        ],
        { env: installerEnv(home), encoding: "utf-8", timeout: 9 * 60_000 },
      );
      assert.match(output, /tdei-core-dev -> https:\/\/gw\.example\.org\/tdei-core-dev\/mcp/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
