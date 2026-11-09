#!/usr/bin/env node
// Generate a small nginx reverse-proxy config + gateway landing page from mcps.json.
// Each server keeps its exact basePath (src/http.ts matches basePath exactly),
// so nginx forwards the full prefix: /<slug>/mcp -> 127.0.0.1:<port>/<slug>/mcp
//
// Usage (Docker/ACA single image — server{} snippet for conf.d):
//   pnpm build && node scripts/generate-nginx-conf.mjs \
//     --file mcps.json --out nginx/nginx.conf --direct
// Host-local full config (deploy:node) — runnable via nginx -p <prefix>:
//   node scripts/generate-nginx-conf.mjs --file mcps.json \
//     --out .gateway/nginx.conf --html-out .gateway/html/gateway.html \
//     --root .gateway/html --direct --standalone
// Standalone nginx in front of remote children: omit --direct and use
// --upstream-host <host> (e.g. host.docker.internal).
//
// Flags: --file --out --html-out --upstream-host --listen (default 3000)
//   --root (html root, default /usr/share/nginx/html)
//   --direct (localhost upstreams, no resolver) --standalone (full config)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function flagValue(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (inline !== undefined) return inline.trim();
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1]?.trim();
  return undefined;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const file = flagValue("--file") ?? process.env.TDEI_MCPS_FILE?.trim() ?? "mcps.json";
const out = flagValue("--out") ?? "nginx/nginx.conf";
const htmlOut = flagValue("--html-out") ?? `${dirname(out)}/gateway.html`;
// --direct: single-container image — nginx and node share localhost, so emit
// plain `proxy_pass http://127.0.0.1:<port>` with no `resolver` (Docker
// embedded DNS 127.0.0.11 does not exist in Azure Container Apps).
// Without --direct (standalone nginx only): proxy targets are variables
// resolved per request via the Docker embedded DNS.
// --standalone: wrap the server block in events{}/http{} so the output is a
// complete config runnable via `nginx -p <prefix> -c nginx.conf` (host-local
// deploy, no Docker). Log paths are relative so -p governs them.
// --root <dir>: html root for the gateway page (default /usr/share/nginx/html).
// --listen <port>: public listen port, baked into the config (default 3000).
const direct = process.argv.includes("--direct");
const upstreamHost = flagValue("--upstream-host") ?? (direct ? "127.0.0.1" : "host.docker.internal");
const listen = flagValue("--listen") ?? "3000";
const standalone = process.argv.includes("--standalone");
const rootDir = flagValue("--root") ?? "/usr/share/nginx/html";

// Full build version baked into the gateway page: package.json version plus
// the commit SHA that CI passed as the GIT_SHA build arg (Docker exposes it as
// TDEI_MCP_BUILD_SHA in the runtime stage, and the entrypoint regenerates this
// page on every boot). Without a SHA (local generation) only the version is
// baked; the page's health fetch then fills in version + full SHA at runtime.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const buildSha = (process.env.TDEI_MCP_BUILD_SHA ?? "").trim();
const baseVersion = (process.env.TDEI_MCP_BUILD_VERSION ?? "").trim() || pkg.version;
const buildVersion = buildSha && buildSha !== "unknown" ? `${baseVersion}+${buildSha}` : baseVersion;

let multiConfig;
try {
  multiConfig = await import("../dist/multi-config.js");
} catch {
  console.error("[nginx] dist/multi-config.js not found — run `pnpm build` first.");
  process.exit(1);
}

let setupTargets;
try {
  setupTargets = await import("../dist/setup/targets.js");
} catch {
  console.error("[nginx] dist/setup/targets.js not found — run `pnpm build` first.");
  process.exit(1);
}

const filePath = resolve(process.cwd(), file);
const parsed = multiConfig.loadMultiMcpFile(filePath);
const servers = multiConfig.resolveMultiMcp(parsed);

const varName = (slug) => slug.replace(/[^a-zA-Z0-9_]/g, "_");

// NOTE: variable proxy_pass targets resolve via `resolver` per request,
// so a literal hostname never blocks nginx startup on DNS. In --direct
// (single-container) mode there is no Docker DNS, so targets are plain
// 127.0.0.1:port literals with no resolver needed.
const locations = servers
  .map((s) => {
    if (direct) {
      const target = `${upstreamHost}:${s.port}`;
      return `    # ${s.name} -> ${s.apiUrl}
    location = ${s.basePath} {
        proxy_pass http://${target};
    }
    # installer scripts: ${s.basePath}/setup[/<action>]/<client>[.ps1] -> child
    location = ${s.basePath}/setup {
        proxy_pass http://${target};
    }
    location ^~ ${s.basePath}/setup/ {
        proxy_pass http://${target};
    }
    # per-server health: /<slug>/health -> child /health
    location = /${s.slug}/health {
        proxy_pass http://${target}/health;
    }
    # MCP OAuth. The client sends the access token on later tool calls.
    location = /.well-known/oauth-protected-resource${s.basePath} {
        proxy_pass http://${target};
    }
    location = /.well-known/oauth-authorization-server/${s.slug} {
        proxy_pass http://${target};
    }
    location ^~ /${s.slug}/oauth/ {
        proxy_pass http://${target};
    }`;
    }
    const v = `tdei_upstream_${varName(s.slug)}`;
    const target = `${upstreamHost}:${s.port}`;
    return `    # ${s.name} -> ${s.apiUrl}
    location = ${s.basePath} {
        set $${v} ${target};
        proxy_pass http://$${v};
    }
    # installer scripts: ${s.basePath}/setup[/<action>]/<client>[.ps1] -> child
    location = ${s.basePath}/setup {
        set $${v} ${target};
        proxy_pass http://$${v};
    }
    location ^~ ${s.basePath}/setup/ {
        set $${v} ${target};
        proxy_pass http://$${v};
    }
    # per-server health: /<slug>/health -> child /health
    location = /${s.slug}/health {
        set $${v} ${target};
        proxy_pass http://$${v}/health;
    }
    # MCP OAuth. The client sends the access token on later tool calls.
    location = /.well-known/oauth-protected-resource${s.basePath} {
        set $${v} ${target};
        proxy_pass http://$${v};
    }
    location = /.well-known/oauth-authorization-server/${s.slug} {
        set $${v} ${target};
        proxy_pass http://$${v};
    }
    location ^~ /${s.slug}/oauth/ {
        set $${v} ${target};
        proxy_pass http://$${v};
    }`;
  })
  .join("\n\n");

const callbackUpstream = `upstream tdei_sso_callback {
${servers.map((s) => `    server ${upstreamHost}:${s.port} max_fails=0;`).join("\n")}
}
`;

const callbackLocation = `    # SSO browser return. Keycloak redirects to the loopback callback;
    # the local relay forwards that hit here.
    # Children without a pending login return
    # 404 and nginx tries the next child. The child that started login
    # exchanges the code once.
    location = /auth/callback {
        proxy_buffering on;
        proxy_next_upstream error timeout http_404;
        proxy_next_upstream_tries ${servers.length};
        proxy_pass http://tdei_sso_callback/auth/callback;
    }`;

const resolverBlock = direct
  ? ""
  : `    # Docker embedded DNS — required because proxy_pass targets are
    # variables (resolved per request, not once at startup).
    resolver 127.0.0.11 valid=10s ipv6=off;

`;

const regenFlags = `--file ${file} --out ${out}${direct ? " --direct" : ""}${standalone ? " --standalone" : ""}${rootDir !== "/usr/share/nginx/html" ? ` --root ${rootDir}` : ""}${listen !== "3000" ? ` --listen ${listen}` : ""}`;
const conf = `# Auto-generated from ${file} — do not edit by hand.
# Regenerate: pnpm build && node scripts/generate-nginx-conf.mjs ${regenFlags}
#
# Path-based reverse proxy: each /<slug>/mcp prefix routes to exactly one
# multi-serve child. The URI is forwarded unchanged because src/http.ts
# matches basePath exactly (no trailing-slash normalization).
#
# Single-image usage (nginx + node in one container, upstreams on localhost):
#   docker build -t tdei-mcp .
#   docker run --rm -p ${listen}:${listen} tdei-mcp
# Then open http://127.0.0.1:${listen}/ for the gateway page, or POST MCP
# JSON-RPC to http://127.0.0.1:${listen}${servers[0]?.basePath ?? "/<slug>/mcp"} etc.
${callbackUpstream}
server {
    listen ${listen};
    server_name _;

    root ${rootDir};

${resolverBlock}    client_max_body_size 25m;

    # MCP Streamable HTTP needs streaming + long-lived GET (SSE).
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    # $http_host keeps the gateway port (e.g. :3000) so installer scripts
    # and status pages served through the proxy advertise the public URL.
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Preserve the outer scheme: a TLS-terminating proxy (e.g. Azure
    # Container Apps) sets X-Forwarded-Proto: https, and src/http.ts
    # auto-identifies the public URL from it. $scheme here is always
    # http (nginx->node inside the container) so it must not overwrite
    # the incoming header; when absent (direct local access) node falls
    # back to http.
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

${locations}

${callbackLocation}

    # Gateway landing page (generated ${htmlOut}).
    location = / {
        try_files /gateway.html =404;
    }
}
`;

const serverBody = conf.slice(conf.indexOf("upstream tdei_sso_callback"));
const output = standalone
  ? `# Auto-generated standalone nginx config — run with: nginx -p <prefix> -c ${out}
# Regenerate: pnpm build && node scripts/generate-nginx-conf.mjs ${regenFlags}
# Log/pid paths are relative so the -p prefix governs them.
worker_processes 1;
error_log logs/error.log;
pid logs/nginx.pid;
events { worker_connections 1024; }
http {
    access_log logs/access.log;
    default_type text/html;
${serverBody}}
`
  : conf;

const serverEntries = servers.map((s) => ({
  id: s.slug,
  name: s.name,
  names: [s.name],
  slug: s.slug,
  apiUrl: s.apiUrl,
  mcps: [s.basePath],
  health: `/${s.slug}/health`,
  setup: `${s.basePath}/setup`,
  with: [],
  npxEnv: setupTargets.setupEnvForServer(s.name) ?? "",
  npxProfile: s.profile === "workspace" ? "workspace" : "core",
}));

// Per-environment installer targets: the core setup base carries a combined
// install (?with=<workspace name>), so "both" installs the two connectors.
const envSetup = {};
for (const env of setupTargets.SETUP_ENVS) {
  // Build from serverEntries, not the raw resolved servers: `setup` is a
  // page-only field derived from basePath. Reading it off the raw server
  // yields `undefined`, which the page then concatenates onto the origin
  // (e.g. https://host.ioundefined/claude-desktop).
  const core = serverEntries.find(
    (s) => s.npxProfile !== "workspace" && setupTargets.setupEnvForServer(s.name) === env,
  );
  const workspace = serverEntries.find(
    (s) => s.npxProfile === "workspace" && setupTargets.setupEnvForServer(s.name) === env,
  );
  if (core && workspace) {
    envSetup[env] = {
      core: { name: core.name, setup: core.setup },
      workspace: { name: workspace.name, setup: workspace.setup },
    };
  }
}
// npx runs this repository from GitHub, pinned to the deployed commit (no npm publish).
const npxPrefix = setupTargets.npxSetupCommand(buildSha);
const serversJson = JSON.stringify(serverEntries).replace(/</g, "\\u003c");
const envSetupJson = JSON.stringify(envSetup).replace(/</g, "\\u003c");

const copyIcons = `<svg class="icon-copy" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.5v-3a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3" stroke="currentColor" stroke-width="1.5"/></svg><svg class="icon-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const serverCards = servers
  .map(
    (
      s,
    ) => `<section class="card" aria-label="Server status ${escapeHtml(s.name)}" data-server-card="${escapeHtml(s.slug)}">
<h2><span class="dot pending" data-dot></span>${escapeHtml(s.name)} <span class="muted" data-state>checking&hellip;</span></h2>
<p class="muted">MCP endpoint: <code data-mcp>${escapeHtml(s.basePath)}</code> &middot; API: <code>${escapeHtml(s.apiUrl)}</code></p>
<table>
<tbody data-rows><tr><td>Loading <code>${escapeHtml(`/${s.slug}/health`)}</code>&hellip;</td></tr></tbody>
</table>
</section>`,
  )
  .join("\n\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TDEI-MCP gateway</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; line-height: 1.5; }
main { max-width: 880px; margin: 0 auto; }
.card { border: 1px solid #8884; border-radius: 12px; padding: 16px 20px; margin: 16px 0; }
.dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; vertical-align: baseline; }
.ok { background: #22a06b; } .bad { background: #d64545; } .pending { background: #c9a227; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8883; font-size: 14px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { white-space: pre-wrap; word-break: break-all; padding: 12px; border: 1px solid #8884; border-radius: 8px; }
button { cursor: pointer; }
.muted { opacity: 0.75; font-size: 13px; }
.build-line { font-size: 13px; margin: -4px 0 14px; }
.build-line code { word-break: break-all; }
.cmd { position: relative; }
.cmd pre { padding-right: 52px; margin: 0; }
.cmd-label { margin: 14px 0 6px; font-size: 14px; }
.copy-btn { position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; padding: 0; border-radius: 6px; border: 1px solid #8886; background: #fff; color: #606060; opacity: 0; transition: opacity 0.15s ease-in-out; }
@media (prefers-color-scheme: dark) { .copy-btn { background: #28282e; color: #b8b8c0; border-color: #555; } }
.cmd:hover .copy-btn, .cmd:focus-within .copy-btn, .copy-btn:focus-visible { opacity: 1; }
@media (hover: none) { .copy-btn { opacity: 1; } }
.copy-btn:hover { background: #ececee; }
@media (prefers-color-scheme: dark) { .copy-btn:hover { background: #3a3a42; } }
.copy-btn svg { width: 16px; height: 16px; display: block; }
.copy-btn .icon-check { display: none; }
.copy-btn.copied { opacity: 1; color: #22a06b; }
.copy-btn.copied .icon-check { display: block; }
.copy-btn.copied .icon-copy { display: none; }
.copy-btn.inline { position: static; margin-left: 8px; width: 28px; height: 28px; vertical-align: middle; opacity: 1; }
.detail-cell code { word-break: break-all; }
.builder { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 12px 0; }
.builder label { display: block; font-size: 13px; font-weight: 600; }
.builder select { display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font-size: 14px; border-radius: 8px; border: 1px solid #8886; background: inherit; color: inherit; }
.step { margin: 20px 0 4px; font-size: 16px; }
.step-num { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: #8883; font-size: 13px; margin-right: 8px; vertical-align: baseline; }
.next ol { margin: 8px 0; padding-left: 22px; }
.next li { margin: 6px 0; }
/* Samples */
.samples-intro { margin: 8px 0 14px }
.samples { display: grid; gap: 22px; margin-top: 12px }
.sample-category h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.9 }
.sample-category h3 span { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 12px; opacity: 0.6; margin-left: 6px }
.sample-list { display: grid; gap: 8px }
.sample-item { position: relative; border: 1px solid #8883; border-radius: 10px; padding: 10px 44px 10px 12px; background: #8881; transition: background 0.15s, border-color 0.15s; cursor: text }
.sample-item:hover { background: #8882; border-color: #8885 }
.sample-item code { display: block; font-size: 13px; white-space: normal; word-break: break-word; line-height: 1.45 }
.sample-item .copy-btn { opacity: 0; top: 6px; right: 6px }
.sample-item:hover .copy-btn, .sample-item:focus-within .copy-btn, .sample-item .copy-btn:focus-visible { opacity: 1 }
@media (hover: none) { .sample-item .copy-btn { opacity: 1 } }
.sample-tag { font-size: 10px; padding: 2px 6px; border-radius: 999px; margin-left: 8px; vertical-align: middle; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; display: inline-block }
.tag-yes { background: #22a06b22; border: 1px solid #22a06b44; color: #22a06b }
.tag-partial { background: #c9a22722; border: 1px solid #c9a22744; color: #c9a227 }
@media (prefers-color-scheme: dark) { .tag-yes { color: #6bdcab } .tag-partial { color: #e8c85a } }
.sample-item code .placeholder { opacity: 0.6; font-style: italic }
</style>
</head>
<body>
<main>
<h1>TDEI-MCP gateway</h1>
<p class="build-line">Deployed build: <code id="tdei-build">${escapeHtml(buildVersion)}</code></p>
<p class="muted">Install the MCP server on your client first, copy a starter question to test your setup, then check live status for each server at the bottom.</p>

<section class="card" aria-label="Install">
<h2>Install on a client machine</h2>
<p class="muted">No tokens are written to disk. Three steps, about two minutes.</p>
<h3 class="step"><span class="step-num">1</span>What to install</h3>
<div class="builder" role="group" aria-label="Environment and connectors">
<label>Environment
<select id="tdei-env">
<option value="dev">Development (dev)</option>
<option value="stage">Staging (stage)</option>
<option value="prod">Production (prod)</option>
</select>
</label>
<label>Connectors
<select id="tdei-spec">
<option value="both">Both: core + workspace (recommended)</option>
<option value="core">Core only</option>
<option value="workspace">Workspace only</option>
</select>
</label>
</div>
<h3 class="step"><span class="step-num">2</span>How to install</h3>
<div class="builder" role="group" aria-label="Install method">
<label>Method
<select id="tdei-method">
<option value="npx">Automatic with npx (recommended)</option>
<option value="script">Per-client script</option>
</select>
</label>
<label>Purpose
<select id="tdei-action">
<option value="install">Install (first-time setup)</option>
<option value="update">Update / reinstall (fixes most issues)</option>
<option value="uninstall">Remove (uninstall)</option>
</select>
</label>
<label data-script-only>Client / harness
<select id="tdei-harness">
<option value="codex">Codex</option>
<option value="opencode">OpenCode</option>
<option value="claude-cli">Claude Code</option>
<option value="claude-desktop">Claude Desktop</option>
<option value="vscode">VS Code</option>
<option value="cursor">Cursor</option>
</select>
</label>
<label data-script-only>Operating system
<select id="tdei-os">
<option value="sh">macOS / Linux</option>
<option value="ps1">Windows</option>
</select>
</label>
</div>
<h3 class="step"><span class="step-num">3</span>Run this command</h3>
<p class="muted">Copy and run it as-is on the client machine. Needs <code>node 22+</code> (<code>sh</code> on macOS / Linux, PowerShell on Windows).</p>
<div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy generated command">${copyIcons}</button><pre id="tdei-command"></pre></div>
<p class="muted" id="tdei-hint"></p>
<h3>What happens next</h3>
<div class="next">
<ol>
<li><strong>Restart required.</strong> The client only picks up the new <code data-entry-name>server</code> entry on a full restart. Closing a chat window is not enough &mdash; quit the app fully, reopen it, then start a <strong>new</strong> chat/session.</li>
<li><strong>Sign in when asked.</strong> Ask your agent to use any TDEI tool. The first call starts the TDEI sign-in &mdash; approve the browser login and the call is retried. (Claude Code: run <code>/mcp</code> and authenticate the server if no prompt appears.)</li>
</ol>
<table>
<tbody>
<tr><th>Codex</th><td>Quit and reopen Codex, then new chat (run <code>/mcp</code> to verify <code data-entry-name>server</code>).</td></tr>
<tr><th>OpenCode</th><td>Quit and reopen OpenCode, then start a new session.</td></tr>
<tr><th>Claude Code</th><td>Exit Claude Code and start a new session (reloads <code>~/.claude.json</code>).</td></tr>
<tr><th>Claude Desktop</th><td>Fully quit with <code>Cmd+Q</code> (macOS) or <code>File &gt; Exit</code> (Windows), reopen it, then start a new chat.</td></tr>
<tr><th>VS Code</th><td><code>Cmd/Ctrl+Shift+P</code> &rarr; <code>Developer: Reload Window</code> (or quit + reopen).</td></tr>
<tr><th>Cursor</th><td>Quit and reopen Cursor, then start a new chat (open Cursor Settings &gt; MCP to verify <code data-entry-name>server</code>).</td></tr>
</tbody>
</table>
</div>
</section>

<section class="card" aria-label="Sample questions">
<h2>Try these example questions</h2>
<p class="muted samples-intro">Once installed and signed in (the first question starts the sign-in), ask your agent any of these. Replace placeholders like <code>[dataset-id]</code> with real values. Top 10 tested use cases only.</p>
<div class="samples">

<div class="sample-category">
<h3>Find datasets <span>fully tested – city / bbox / project group</span></h3>
<div class="sample-list">
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Find all sidewalk (OSW) datasets in Seattle, WA</code></div>
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Find flex datasets in Seattle, WA</code></div>
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Find datasets in a bounding box around Seattle, WA</code></div>
</div>
</div>

<div class="sample-category">
<h3>Recent uploads & status <span>tested – uploadedAfter + released / pre-release</span></h3>
<div class="sample-list">
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Show me datasets uploaded in the last 7 days in Seattle, WA</code></div>
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Is dataset <span class="placeholder">[dataset-id]</span> released or still pre-released?</code></div>
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Get full metadata and status table for dataset <span class="placeholder">[dataset-id]</span></code></div>
</div>
</div>

<div class="sample-category">
<h3>Validate & Jobs <span>tested – ZIP validation, job polling</span></h3>
<div class="sample-list">
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Validate this OSW ZIP: ./my-sidewalk-dataset.zip</code></div>
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Show all my still-running jobs</code></div>
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>What's the status of job <span class="placeholder">[job-id]</span>?</code></div>
<div class="sample-item" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy question">${copyIcons}</button><code>Show my last 5 jobs across all accessible project groups</code></div>
</div>
</div>

</div>
<p class="muted" style="margin-top:16px">Tip: Combine filters – e.g. "Find recent pre-released OSW datasets in Seattle uploaded in last 7 days".</p>
</section>

${serverCards}

</main>
<script>
const TDEI_SERVERS = ${serversJson};
const TDEI_ENV_SETUP = ${envSetupJson};
const TDEI_NPX_PREFIX = ${JSON.stringify(npxPrefix).replace(/</g, "\\u003c")};
function tdeiTarget(env, spec) {
  const pair = TDEI_ENV_SETUP[env] || TDEI_ENV_SETUP.dev;
  if (spec === 'core') return { primary: pair.core, extra: [] };
  if (spec === 'workspace') return { primary: pair.workspace, extra: [] };
  return { primary: pair.core, extra: [pair.workspace] };
}
function tdeiHint(method, action, entryNames) {
  if (method === 'npx') {
    if (action === 'uninstall') return 'Removes every tdei / tdei-* entry from the detected clients (all environments) and keeps all other servers. Only run this to uninstall.';
    if (action === 'update') return 'Re-run of the install for ' + entryNames + ': replaces only those entries, keeps every other entry. Restart the app afterwards.';
    return 'Installs ' + entryNames + '. Detects your MCP clients, shows what it will change, and asks before writing. Needs Node 22+.';
  }
  if (action === 'update') return 'Safe to re-run — replaces only the ' + entryNames + ' entry, keeps every other entry. Run it, restart the app, start a new chat.';
  if (action === 'uninstall') return 'Removes only the ' + entryNames + ' entry — every other MCP server entry is kept. Restart the app afterwards.';
  return 'Writes the ' + entryNames + ' entry for your client. Needs sh + node 22+ on the client machine (PowerShell + node on Windows).';
}
function tdeiQuote(url) {
  return url.indexOf('?') === -1 ? url : "'" + url + "'";
}
function tdeiBuildCommand() {
  const env = document.getElementById('tdei-env').value;
  const spec = document.getElementById('tdei-spec').value;
  const method = document.getElementById('tdei-method').value;
  const action = document.getElementById('tdei-action').value;
  const client = document.getElementById('tdei-harness').value;
  const os = document.getElementById('tdei-os').value;
  const target = tdeiTarget(env, spec);
  const entryNames = spec === 'both'
    ? target.primary.name + ', ' + target.extra.map((w) => w.name).join(', ')
    : target.primary.name;
  let cmd;
  if (method === 'npx') {
    cmd = action === 'uninstall'
      ? TDEI_NPX_PREFIX + ' cleanup'
      : TDEI_NPX_PREFIX + ' --env ' + env + (spec === 'both' ? '' : ' --profile ' + spec) + ' --gateway ' + location.origin;
  } else {
    const setupBase = location.origin + target.primary.setup;
    const scriptPath = action === 'install' ? client : action + '/' + client;
    const withQuery = target.extra.length > 0 ? '?with=' + target.extra.map((w) => w.name).join(',') : '';
    const url = setupBase + '/' + scriptPath + withQuery;
    cmd = os === 'ps1'
      ? 'Set-ExecutionPolicy Bypass -Scope Process -Force; irm ' + tdeiQuote(url + '.ps1') + ' | iex'
      : 'curl -fsSL ' + tdeiQuote(url) + ' | sh';
  }
  document.getElementById('tdei-command').textContent = cmd;
  document.getElementById('tdei-hint').textContent = tdeiHint(method, action, entryNames);
  document.querySelectorAll('[data-entry-name]').forEach((el) => { el.textContent = entryNames; });
  const showClient = method === 'script';
  document.querySelectorAll('[data-script-only]').forEach((el) => { el.style.display = showClient ? '' : 'none'; });
}
['tdei-env', 'tdei-spec', 'tdei-method', 'tdei-harness', 'tdei-os', 'tdei-action'].forEach((id) => {
  document.getElementById(id).addEventListener('change', tdeiBuildCommand);
});
async function copyTextFromButton(btn) {
  const wrap = btn.closest('[data-copy-wrap]');
  const el = wrap ? wrap.querySelector('code, pre') : null;
  const text = el ? el.innerText : '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch (err) {
    btn.title = 'Copy failed';
  }
}
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyTextFromButton(btn));
});
async function loadServer(card, server) {
  const dot = card.querySelector('[data-dot]');
  const state = card.querySelector('[data-state]');
  const rows = card.querySelector('[data-rows]');
  try {
    const res = await fetch(server.health, { cache: 'no-store' });
    const h = await res.json();
    const good = !!h.ok;
    dot.className = 'dot ' + (good ? 'ok' : 'bad');
    state.textContent = h.ok ? 'healthy' : 'needs attention';
    const row = (k, v) => '<tr><th>' + k + '</th><td><code>' + String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</code></td></tr>';
    // Full deployed version: package.json version + the full commit SHA that
    // CI baked into the image (GIT_SHA -> TDEI_MCP_BUILD_SHA), e.g.
    // 0.1.0+f3bda3c63fdd426841f31d93a65f83bc046cd0ab. Every child runs the
    // same image, so one child's build fills the header for the whole page.
    const b = h.build || {};
    const build = b.version ? b.version + (b.sha && b.sha !== 'unknown' ? '+' + b.sha : '') : 'unknown';
    const buildEl = document.getElementById('tdei-build');
    if (buildEl && b.version) buildEl.textContent = build;
    rows.innerHTML =
      row('build', build) +
      row('auth', (h.auth && h.auth.state) || 'unknown') +
      row('openapi.loaded', h.openapi && h.openapi.loaded) +
      row('spec', (h.spec && h.spec.url || '') + ' reachable=' + (h.spec && h.spec.reachable) + (h.spec && h.spec.latencyMs != null ? ' ' + h.spec.latencyMs + 'ms' : '')) +
      row('callback', (h.callback && h.callback.url || '') + ' portFree=' + (h.callback && h.callback.portFree)) +
      row('config', JSON.stringify(h.config || {}));
  } catch (err) {
    dot.className = 'dot bad';
    state.textContent = 'unreachable';
    rows.innerHTML = '<tr><td>Could not fetch ' + server.health + ': ' + String(err).replace(/</g,'&lt;') + '</td></tr>';
  }
}
function loadAll() {
  document.querySelectorAll('[data-server-card]').forEach((card) => {
    const slug = card.getAttribute('data-server-card');
    const server = TDEI_SERVERS.find((s) => s.slug === slug);
    if (server) loadServer(card, server);
  });
}
tdeiBuildCommand();
loadAll();
setInterval(loadAll, 15000);
</script>
</body>
</html>
`;

mkdirSync(dirname(resolve(process.cwd(), out)), { recursive: true });
writeFileSync(resolve(process.cwd(), out), output);
mkdirSync(dirname(resolve(process.cwd(), htmlOut)), { recursive: true });
writeFileSync(resolve(process.cwd(), htmlOut), html);
console.log(`[nginx] wrote ${out} and ${htmlOut} with ${servers.length} servers from ${file}`);
for (const s of servers) {
  console.log(`[nginx] ${s.basePath} -> ${upstreamHost}:${s.port} (${s.name})`);
}
