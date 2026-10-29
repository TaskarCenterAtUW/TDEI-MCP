import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getClientSetupJs,
  isSetupClientTarget,
  isSetupScriptAction,
  normalizeSetupClientTarget,
  renderClientSetupPowershell,
  renderClientSetupScript,
  renderSetupOverview,
  setupActionPath,
  type SetupClientTarget,
} from "../src/http-setup-script.js";
import { renderStatusPage } from "../src/http-status-page.js";
import { resolvePublicBaseUrl } from "../src/http.js";
import { serveTestHttp } from "./helpers/test-http-server.js";

// Installer runs below spawn a detached SSO callback relay for remote servers;
// suppress it in tests so no relay process outlives the suite and holds port 8765.
process.env.TDEI_NO_RELAY = "1";

const CLIENTS: SetupClientTarget[] = ["codex", "opencode", "claude-cli", "claude-desktop", "vscode", "cursor"];

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
  // Restart instructions must be in clear view, not buried.
  assert.match(overview, /RESTART REQUIRED/);
  assert.match(overview, /Claude Desktop:.*Cmd\+Q/);
  assert.match(overview, /tdei_sso_login/);
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
      mcpServers: { tdei: { command: string; args: string[]; type?: string; url?: string } };
    };
    // Claude Desktop rejects remote ({type:"http",url}) entries outright, so the
    // installer must register a stdio mcp-remote bridge instead.
    assert.equal(doc.mcpServers.tdei.command, "npx");
    assert.deepEqual(doc.mcpServers.tdei.args, [
      "-y",
      "mcp-remote",
      "http://192.168.50.11:8080/mcp",
      "--allow-http",
    ]);
    assert.equal(doc.mcpServers.tdei.type, undefined);
    assert.equal(doc.mcpServers.tdei.url, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude-desktop bridge omits --allow-http for https endpoints", () => {
  const ps = renderClientSetupPowershell("claude-desktop", "https://tdei.example.org", 8765);
  const js = `${ps.split("$setupJs = @'\n")[1]!.split("\n'@")[0]!}\n`;
  const home = mkdtempSync(join(tmpdir(), "tdei-desktop-https-"));
  try {
    const tmp = join(home, "setup.cjs");
    writeFileSync(tmp, js);
    execFileSync(
      process.execPath,
      [tmp, "claude-desktop", "https://tdei.example.org/mcp", "https://tdei.example.org/auth/callback", "8765"],
      { env: { ...process.env, HOME: home } },
    );
    const expected =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : process.platform === "win32"
          ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
          : join(home, ".config", "Claude", "claude_desktop_config.json");
    const doc = JSON.parse(readFileSync(expected, "utf-8")) as {
      mcpServers: { tdei: { command: string; args: string[] } };
    };
    assert.deepEqual(doc.mcpServers.tdei.args, ["-y", "mcp-remote", "https://tdei.example.org/mcp"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer stdout prints a clear restart step for every client", () => {
  const home = mkdtempSync(join(tmpdir(), "tdei-restart-"));
  try {
    const tmp = join(home, "setup.cjs");
    writeFileSync(tmp, getClientSetupJs());
    const expected: Record<SetupClientTarget, RegExp> = {
      codex: /Quit and reopen Codex/,
      opencode: /Quit and reopen OpenCode/,
      "claude-cli": /Exit Claude Code/,
      "claude-desktop": /Fully quit Claude Desktop.*Cmd\+Q/,
      vscode: /Reload VS Code|Reload Window/,
      cursor: /reopen Cursor/,
    };
    for (const client of CLIENTS) {
      const out = execFileSync(
        process.execPath,
        [tmp, client, "https://tdei.example.org/mcp", "https://tdei.example.org/auth/callback", "8765"],
        { env: { ...process.env, HOME: home } },
      ).toString();
      assert.match(out, /RESTART REQUIRED/, `${client} must print a restart banner`);
      assert.match(out, expected[client], `${client} must print its own restart step`);
      assert.match(out, /tdei_sso_login/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status page shows per-client restart steps in clear view", () => {
  const html = renderStatusPage("http://192.168.50.11:3000", "/mcp");
  assert.match(html, /Restart required/);
  assert.match(html, /Cmd\+Q/);
  assert.match(html, /Reload Window/);
  assert.match(html, /tdei_sso_login/);
});

test("status page builder generates install/update/uninstall commands with no manual edits", () => {
  const html = renderStatusPage("http://192.168.50.11:3000", "/mcp");
  for (const id of ["tdei-harness", "tdei-os", "tdei-action", "tdei-command", "tdei-hint"]) {
    assert.match(html, new RegExp(`id="${id}"`), `builder must render #${id}`);
  }
  for (const client of ["codex", "opencode", "claude-cli", "claude-desktop", "vscode", "cursor"]) {
    assert.match(html, new RegExp(`<option value="${client}">`), `client dropdown must offer ${client}`);
  }
  for (const action of ["install", "update", "uninstall"]) {
    assert.match(html, new RegExp(`<option value="${action}">`), `command dropdown must offer ${action}`);
  }
  assert.match(html, /<option value="sh">/, "os dropdown must offer macOS / Linux");
  assert.match(html, /<option value="ps1">/, "os dropdown must offer Windows");
  // Default (no-JS) command is a working installer, and the live builder
  // covers every combination without the user editing the command text.
  assert.match(html, /curl -fsSL http:\/\/192\.168\.50\.11:3000\/mcp\/setup\/codex \| sh/);
  assert.match(html, /TDEI_SETUP_BASE/);
  assert.match(html, /action \+ '\/' \+ client|action === 'install' \? client/);
  assert.match(html, /\.ps1 \| iex/);
});

test("setup endpoints serve sh + ps1 installers and reject unknown clients", async () => {
  const handle = await serveTestHttp({});
  const escapedOrigin = handle.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    assert.match(psText, new RegExp(`${escapedOrigin}/mcp`));

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

    const update = await fetch(`${handle.url}/mcp/setup/update/codex`);
    assert.equal(update.status, 200);
    assert.match(await update.text(), /ACTION="update"/);

    const uninstall = await fetch(`${handle.url}/mcp/setup/uninstall/cursor`);
    assert.equal(uninstall.status, 200);
    assert.match(await uninstall.text(), /ACTION="uninstall"/);

    const uninstallPs = await fetch(`${handle.url}/mcp/setup/uninstall/vscode.ps1`);
    assert.equal(uninstallPs.status, 200);
    assert.match(await uninstallPs.text(), /\$Action = 'uninstall'/);

    const updateBogus = await fetch(`${handle.url}/mcp/setup/update/bogus`);
    assert.equal(updateBogus.status, 404);
    assert.match(await updateBogus.text(), /TDEI_SETUP_CLIENT_UNKNOWN/);
  } finally {
    await handle.close();
  }
});

test("setup action helpers accept install/update/uninstall paths", () => {
  assert.equal(isSetupScriptAction("install"), true);
  assert.equal(isSetupScriptAction("update"), true);
  assert.equal(isSetupScriptAction("uninstall"), true);
  assert.equal(isSetupScriptAction("bogus"), false);
  assert.equal(setupActionPath("codex"), "codex");
  assert.equal(setupActionPath("codex", "install"), "codex");
  assert.equal(setupActionPath("codex", "update"), "update/codex");
  assert.equal(setupActionPath("cursor", "uninstall"), "uninstall/cursor");
});

test("overview advertises update and uninstall commands", () => {
  const overview = renderSetupOverview("http://192.168.50.11:8080", "/mcp");
  assert.match(overview, /curl -fsSL http:\/\/192\.168\.50\.11:8080\/mcp\/setup\/update\/codex \| sh/);
  assert.match(overview, /curl -fsSL http:\/\/192\.168\.50\.11:8080\/mcp\/setup\/uninstall\/codex \| sh/);
  assert.match(overview, /irm http:\/\/192\.168\.50\.11:8080\/mcp\/setup\/update\/codex\.ps1 \| iex/);
  assert.match(overview, /irm http:\/\/192\.168\.50\.11:8080\/mcp\/setup\/uninstall\/codex\.ps1 \| iex/);
});

test("sh and ps1 wrappers pass the action through to the node program", () => {
  for (const client of CLIENTS) {
    const uninstallSh = renderClientSetupScript(client, "http://h:1", 8765, "uninstall");
    assert.match(uninstallSh, /ACTION="uninstall"/);
    assert.match(uninstallSh, /"\$ACTION" <<'EOF'/);

    const updatePs = renderClientSetupPowershell(client, "http://h:1", 8765, "update");
    assert.match(updatePs, /\$Action = 'update'/);
    assert.match(updatePs, /"\$CallbackPort" \$Action/);
    // The embedded program is identical across actions — only the wrapper arg differs.
    const js = `${updatePs.split("$setupJs = @'\n")[1]!.split("\n'@")[0]!}\n`;
    assert.equal(js, getClientSetupJs());
  }
});

test("update reinstalls and uninstall removes only the tdei entry", () => {
  const home = mkdtempSync(join(tmpdir(), "tdei-update-"));
  try {
    const tmp = join(home, "setup.cjs");
    writeFileSync(tmp, getClientSetupJs());
    const run = (args: string[]) =>
      execFileSync(process.execPath, [tmp, ...args], { env: { ...process.env, HOME: home } }).toString();

    // JSON client: install, poison the entry + add a sibling, update, uninstall.
    run(["opencode", "http://old:1/mcp", "http://old:1/auth/callback", "8765", "install"]);
    const opencodeFile = join(home, ".config", "opencode", "opencode.json");
    const doc = JSON.parse(readFileSync(opencodeFile, "utf-8")) as {
      mcp: { tdei: { url: string }; other: { type: string } };
    };
    doc.mcp.tdei.url = "http://stale:9/mcp";
    doc.mcp.other = { type: "local" };
    writeFileSync(opencodeFile, JSON.stringify(doc, null, 2));
    const updated = run(["opencode", "http://new:2/mcp", "http://new:2/auth/callback", "8765", "update"]);
    assert.match(updated, /Updated opencode/);
    const afterUpdate = JSON.parse(readFileSync(opencodeFile, "utf-8")) as {
      mcp: { tdei: { url: string }; other: { type: string } };
    };
    assert.equal(afterUpdate.mcp.tdei.url, "http://new:2/mcp");
    assert.deepEqual(afterUpdate.mcp.other, { type: "local" });

    const removed = run(["opencode", "http://new:2/mcp", "http://new:2/auth/callback", "8765", "uninstall"]);
    assert.match(removed, /Removed tdei entry/);
    assert.match(removed, /RESTART REQUIRED/);
    const afterUninstall = JSON.parse(readFileSync(opencodeFile, "utf-8")) as {
      mcp: { tdei?: unknown; other: { type: string } };
    };
    assert.equal(afterUninstall.mcp.tdei, undefined);
    assert.deepEqual(afterUninstall.mcp.other, { type: "local" });

    const noop = run(["opencode", "http://new:2/mcp", "http://new:2/auth/callback", "8765", "uninstall"]);
    assert.match(noop, /nothing to do/);

    // TOML client: sibling sections survive update + uninstall.
    run(["codex", "http://old:1/mcp", "http://old:1/auth/callback", "8765", "install"]);
    const codexFile = join(home, ".codex", "config.toml");
    writeFileSync(codexFile, `[other]\nfoo = 1\n\n${readFileSync(codexFile, "utf-8")}`);
    run(["codex", "http://new:2/mcp", "http://new:2/auth/callback", "8765", "update"]);
    const afterCodexUpdate = readFileSync(codexFile, "utf-8");
    assert.match(afterCodexUpdate, /\[other\]/);
    assert.match(afterCodexUpdate, /url = "http:\/\/new:2\/mcp"/);
    run(["codex", "http://new:2/mcp", "http://new:2/auth/callback", "8765", "uninstall"]);
    const afterCodexUninstall = readFileSync(codexFile, "utf-8");
    assert.doesNotMatch(afterCodexUninstall, /mcp_servers\.tdei/);
    assert.match(afterCodexUninstall, /\[other\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolvePublicBaseUrl prefers env override, then X-Forwarded-Proto", () => {
  assert.equal(
    resolvePublicBaseUrl({ hostHeader: "h:1", fallbackHost: "f:2" }),
    "http://h:1",
  );
  assert.equal(
    resolvePublicBaseUrl({ hostHeader: "h", forwardedProto: "https", fallbackHost: "f:2" }),
    "https://h",
  );
  assert.equal(
    resolvePublicBaseUrl({ hostHeader: "h", forwardedProto: ["https", "http"], fallbackHost: "f:2" }),
    "https://h",
  );
  assert.equal(
    resolvePublicBaseUrl({ hostHeader: "h", forwardedProto: "https, http", fallbackHost: "f:2" }),
    "https://h",
  );
  assert.equal(
    resolvePublicBaseUrl({ hostHeader: "h", forwardedProto: "gopher", fallbackHost: "f:2" }),
    "http://h",
  );
  assert.equal(
    resolvePublicBaseUrl({ fallbackHost: "f:2" }),
    "http://f:2",
  );
  assert.equal(
    resolvePublicBaseUrl({ hostHeader: "h", forwardedProto: "http", envOverride: "https://mcp.example.com/", fallbackHost: "f:2" }),
    "https://mcp.example.com",
  );
  assert.equal(
    resolvePublicBaseUrl({ hostHeader: "h", forwardedProto: "https", envOverride: "ftp://mcp.example.com", fallbackHost: "f:2" }),
    "https://h",
  );
});

test("status page and setup catalogue advertise https behind a TLS proxy", async () => {
  const handle = await serveTestHttp({});
  const actualPort = new URL(handle.url).port;
  try {
    const headers = { "x-forwarded-proto": "https" };
    const html = await (await fetch(`${handle.url}/`, { headers })).text();
    assert.match(html, new RegExp(`https://127\\.0\\.0\\.1:${actualPort}/mcp`));
    assert.doesNotMatch(html, new RegExp(`curl -fsSL http://127\\.0\\.0\\.1:${actualPort}`));

    const overview = await (await fetch(`${handle.url}/mcp/setup`, { headers })).text();
    assert.match(overview, new RegExp(`curl -fsSL https://127\\.0\\.0\\.1:${actualPort}/mcp/setup/codex \\| sh`));
    assert.match(overview, new RegExp(`irm https://127\\.0\\.0\\.1:${actualPort}/mcp/setup/codex\\.ps1 \\| iex`));

    const sh = await (await fetch(`${handle.url}/mcp/setup/codex`, { headers })).text();
    assert.match(sh, new RegExp(`https://127\\.0\\.0\\.1:${actualPort}/mcp`));

    // Without the proxy header the container-local http origin is kept.
    const plain = await (await fetch(`${handle.url}/mcp/setup`)).text();
    assert.match(plain, new RegExp(`curl -fsSL http://127\\.0\\.0\\.1:${actualPort}/mcp/setup/codex \\| sh`));
  } finally {
    await handle.close();
  }
});

test("TDEI_PUBLIC_BASE_URL override wins over proxy headers", async () => {
  const handle = await serveTestHttp({});
  const prev = process.env.TDEI_PUBLIC_BASE_URL;
  process.env.TDEI_PUBLIC_BASE_URL = "https://mcp.example.com";
  try {
    const headers = { "x-forwarded-proto": "http" };
    const overview = await (await fetch(`${handle.url}/mcp/setup`, { headers })).text();
    assert.match(overview, /curl -fsSL https:\/\/mcp\.example\.com\/mcp\/setup\/codex \| sh/);
    const html = await (await fetch(`${handle.url}/`, { headers })).text();
    assert.match(html, /https:\/\/mcp\.example\.com\/mcp/);
  } finally {
    if (prev === undefined) delete process.env.TDEI_PUBLIC_BASE_URL;
    else process.env.TDEI_PUBLIC_BASE_URL = prev;
    await handle.close();
  }
});
