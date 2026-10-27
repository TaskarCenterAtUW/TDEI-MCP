import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getClientSetupJs,
  isSetupClientTarget,
  normalizeSetupClientTarget,
  renderClientSetupPowershell,
  renderClientSetupScript,
  renderSetupOverview,
  type SetupClientTarget,
} from "../src/http-setup-script.js";
import { serveHttp } from "../src/http.js";

const CLIENTS: SetupClientTarget[] = ["codex", "opencode", "claude-cli", "claude-desktop", "vscode"];

test("sh and ps1 installers embed the identical node program", () => {
  const shared = getClientSetupJs();
  assert.ok(shared.length > 1000);
  for (const client of CLIENTS) {
    const sh = renderClientSetupScript(client, "http://192.168.50.11:8080", 8765);
    const shJs = `${sh.split(`<<'EOF'\n`)[1]!.split("\nEOF")[0]!}\n`;
    assert.equal(shJs, shared, `sh wrapper diverged for ${client}`);

    const ps = renderClientSetupPowershell(client, "http://192.168.50.11:8080", 8765);
    const psJs = `${ps.split("$setupJs = @'\n")[1]!.split("\n'@")[0]!}\n`;
    assert.equal(psJs, shared, `ps1 wrapper diverged for ${client}`);
  }
});

test("shared node program is here-string safe for PowerShell", () => {
  for (const line of getClientSetupJs().split("\n")) {
    assert.notEqual(line, "'@", "a line would terminate the PowerShell here-string early");
  }
});

test("unknown setup client is rejected, legacy claude aliases to claude-cli", () => {
  assert.equal(isSetupClientTarget("bogus"), false);
  assert.equal(isSetupClientTarget("codex.ps1"), false);
  assert.equal(isSetupClientTarget("claude"), false);
  assert.equal(normalizeSetupClientTarget("claude"), "claude-cli");
  assert.equal(normalizeSetupClientTarget("CLAUDE-DESKTOP"), "claude-desktop");
  assert.equal(normalizeSetupClientTarget("bogus"), undefined);
});

test("overview advertises sh (mac/ubuntu) and ps1 (windows) installers", () => {
  const overview = renderSetupOverview("http://192.168.50.11:8080", "/mcp");
  for (const client of CLIENTS) {
    assert.match(overview, new RegExp(`curl -fsSL http://192\\.168\\.50\\.11:8080/mcp/setup/${client} \\| sh`));
    assert.match(overview, new RegExp(`irm http://192\\.168\\.50\\.11:8080/mcp/setup/${client}\\.ps1 \\| iex`));
  }
  const custom = renderSetupOverview("http://h:1", "/custom");
  assert.match(custom, /\/custom\/setup\/codex \| sh/);
  assert.match(custom, /\/custom\/setup\/codex\.ps1 \| iex/);
});

test("ps1 installer carries defaults and cleans up its temp file", () => {
  const ps = renderClientSetupPowershell("vscode", "http://192.168.50.11:8080", 8765);
  assert.match(ps, /\$ErrorActionPreference = "Stop"/);
  assert.match(ps, /Get-Command node/);
  assert.match(ps, /\$McpUrl = 'http:\/\/192\.168\.50\.11:8080\/mcp'/);
  assert.match(ps, /& node \$tempFile \$Client \$McpUrl \$RemoteCallbackUrl "\$CallbackPort"/);
  assert.match(ps, /Remove-Item -Path \$tempFile/);
});

test("ps1-embedded program configures a client exactly like the sh one", () => {
  // Simulates what the .ps1 does on Windows: drop the here-string body to a
  // temp .cjs file and run `node <tmp> <client> <mcpUrl> <callbackUrl> <port>`.
  const ps = renderClientSetupPowershell("codex", "http://192.168.50.11:8080", 8765);
  const js = `${ps.split("$setupJs = @'\n")[1]!.split("\n'@")[0]!}\n`;
  const home = mkdtempSync(join(tmpdir(), "tdei-ps1-"));
  try {
    const tmp = join(home, "setup.cjs");
    writeFileSync(tmp, js);
    execFileSync(
      process.execPath,
      [tmp, "codex", "http://192.168.50.11:8080/mcp", "http://192.168.50.11:8080/auth/callback", "8765"],
      { env: { ...process.env, HOME: home } },
    );
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    assert.match(toml, /\[mcp_servers\.tdei\]/);
    assert.match(toml, /url = "http:\/\/192\.168\.50\.11:8080\/mcp"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude-desktop program targets the Desktop config, not the CLI file", () => {
  const ps = renderClientSetupPowershell("claude-desktop", "http://192.168.50.11:8080", 8765);
  const js = `${ps.split("$setupJs = @'\n")[1]!.split("\n'@")[0]!}\n`;
  const home = mkdtempSync(join(tmpdir(), "tdei-desktop-"));
  try {
    const tmp = join(home, "setup.cjs");
    writeFileSync(tmp, js);
    execFileSync(
      process.execPath,
      [tmp, "claude-desktop", "http://192.168.50.11:8080/mcp", "http://192.168.50.11:8080/auth/callback", "8765"],
      { env: { ...process.env, HOME: home } },
    );
    const expected =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : process.platform === "win32"
          ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
          : join(home, ".config", "Claude", "claude_desktop_config.json");
    const doc = JSON.parse(readFileSync(expected, "utf-8")) as {
      mcpServers: { tdei: { type: string; url: string } };
    };
    assert.equal(doc.mcpServers.tdei.url, "http://192.168.50.11:8080/mcp");
    assert.equal(doc.mcpServers.tdei.type, "http");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const SETUP_PORT = 18090;

test("setup endpoints serve sh + ps1 installers and reject unknown clients", async () => {
  const handle = await serveHttp({}, { port: SETUP_PORT });
  try {
    const overview = await fetch(`${handle.url}/mcp/setup`);
    assert.equal(overview.status, 200);
    const overviewText = await overview.text();
    assert.match(overviewText, /\.ps1 \| iex/);

    const sh = await fetch(`${handle.url}/mcp/setup/codex`);
    assert.equal(sh.status, 200);
    assert.match(sh.headers.get("content-type") ?? "", /shellscript/);

    const ps = await fetch(`${handle.url}/mcp/setup/codex.ps1`);
    assert.equal(ps.status, 200);
    const psText = await ps.text();
    assert.match(psText, /\$ErrorActionPreference/);
    assert.match(psText, /configureCodex/);
    assert.match(psText, /http:\/\/127\.0\.0\.1:18090\/mcp/);

    const bogus = await fetch(`${handle.url}/mcp/setup/bogus.ps1`);
    assert.equal(bogus.status, 404);
    assert.match(await bogus.text(), /TDEI_SETUP_CLIENT_UNKNOWN/);

    const cli = await fetch(`${handle.url}/mcp/setup/claude-cli.ps1`);
    assert.equal(cli.status, 200);
    assert.match(await cli.text(), /\.claude\.json/);

    const desktop = await fetch(`${handle.url}/mcp/setup/claude-desktop`);
    assert.equal(desktop.status, 200);
    assert.match(await desktop.text(), /claude_desktop_config\.json/);

    const legacy = await fetch(`${handle.url}/mcp/setup/claude`);
    assert.equal(legacy.status, 200);
    assert.match(await legacy.text(), /\.claude\.json/);
  } finally {
    await handle.close();
  }
});
