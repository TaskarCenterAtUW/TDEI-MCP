import { clientMcpName } from "./http-setup-script.js";
import { publicAuthCallbackUrl, REGISTERED_SSO_REDIRECT_URI } from "./sso-public-callback.js";

interface StatusPageUrls {
  origin: string;
  mcpUrl: string;
  setupBase: string;
  healthUrl: string;
  callbackUrl: string;
}

function statusPageUrls(publicBaseUrl: string, basePath = "/mcp", _gatewaySlug?: string): StatusPageUrls {
  const origin = publicBaseUrl.replace(/\/$/, "");
  const prefix = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return {
    origin,
    mcpUrl: `${origin}${prefix || "/mcp"}`,
    setupBase: `${origin}${prefix || "/mcp"}/setup`,
    healthUrl: `${origin}/health`,
    callbackUrl: REGISTERED_SSO_REDIRECT_URI,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Self-contained status + install dashboard.
 * Live values are fetched client-side from GET /health so the HTML
 * itself needs no templated secrets and has no new dependencies.
 */
export function renderStatusPage(publicBaseUrl: string, basePath = "/mcp", gatewaySlug?: string): string {
  const urls = statusPageUrls(publicBaseUrl, basePath, gatewaySlug);
  const mcpName = clientMcpName(gatewaySlug);
  const e = escapeHtml;
  const copyIcons = `<svg class="icon-copy" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.5v-3a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3" stroke="currentColor" stroke-width="1.5"/></svg><svg class="icon-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TDEI-MCP status</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; line-height: 1.5; }
main { max-width: 860px; margin: 0 auto; }
.card { border: 1px solid #8884; border-radius: 12px; padding: 16px 20px; margin: 16px 0; }
.dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; vertical-align: baseline; }
.ok { background: #22a06b; } .bad { background: #d64545; } .pending { background: #c9a227; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8883; font-size: 14px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow-x: auto; padding: 12px; border: 1px solid #8884; border-radius: 8px; }
button { cursor: pointer; }
.muted { opacity: 0.75; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.cmd { position: relative; }
.cmd pre { padding-right: 52px; margin: 0; }
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
</style>
</head>
<body>
<main>
<h1>TDEI-MCP</h1>
<p class="muted">Streamable HTTP connector &mdash; live status + client install. MCP endpoint: <code>${e(urls.mcpUrl)}</code></p>

<section class="card" aria-label="Server status">
<h2><span id="dot" class="dot pending"></span>Server status <span id="ok" class="muted">checking&hellip;</span></h2>
<table>
<tbody id="rows"><tr><td>Loading <code>/health</code>&hellip;</td></tr></tbody>
</table>
<p class="muted">Auto-refreshes every 15s. Source: <code>${e(urls.healthUrl)}</code> &middot; <span id="updated"></span></p>
</section>

<section class="card" aria-label="Install">
<h2>Install on a client machine</h2>
<p>No tokens are written to disk. Pick your client, OS, and command below — copy the generated command and run it as-is on the client machine. After setup, ask your agent to call <code>tdei_sso_login</code> and open the login URL.</p>
<div class="builder" role="group" aria-label="Command builder">
<label>Client / harness
<select id="tdei-harness">
<option value="codex">Codex</option>
<option value="opencode">OpenCode</option>
<option value="claude-cli">Claude Code</option>
<option value="claude-desktop">Claude Desktop</option>
<option value="vscode">VS Code</option>
<option value="cursor">Cursor</option>
</select>
</label>
<label>Operating system
<select id="tdei-os">
<option value="sh">macOS / Linux</option>
<option value="ps1">Windows</option>
</select>
</label>
<label>Command
<select id="tdei-action">
<option value="install">Install</option>
<option value="update">Update / reinstall (fixes most issues)</option>
<option value="uninstall">Uninstall</option>
</select>
</label>
</div>
<div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy title="Copy" aria-label="Copy generated command">${copyIcons}</button><pre id="tdei-command">curl -fsSL ${e(urls.setupBase)}/codex | sh</pre></div>
<p class="muted" id="tdei-hint">Writes the ${e(mcpName)} entry for your client. Needs sh + node 22+ on the client machine.</p>
<h3>Restart required — do this right after the installer</h3>
<p>The client only picks up the new <code>${e(mcpName)}</code> entry on a full restart. Closing a chat window is not enough — restart the app, then start a <strong>new</strong> chat/session:</p>
<table>
<tbody>
<tr><th>Codex</th><td>Quit and reopen Codex, then new chat (run <code>/mcp</code> to verify <code>${e(mcpName)}</code>).</td></tr>
<tr><th>OpenCode</th><td>Quit and reopen OpenCode, then start a new session.</td></tr>
<tr><th>Claude Code</th><td>Exit Claude Code and start a new session (reloads <code>~/.claude.json</code>).</td></tr>
<tr><th>Claude Desktop</th><td>Fully quit with <code>Cmd+Q</code> (macOS) or <code>File &gt; Exit</code> (Windows), reopen it, then start a new chat.</td></tr>
<tr><th>VS Code</th><td><code>Cmd/Ctrl+Shift+P</code> &rarr; <code>Developer: Reload Window</code> (or quit + reopen).</td></tr>
<tr><th>Cursor</th><td>Quit and reopen Cursor, then start a new chat (open Cursor Settings &gt; MCP to verify <code>${e(mcpName)}</code>).</td></tr>
</tbody>
</table>
<h3>Details</h3>
<table>
<tbody>
<tr><th>MCP endpoint</th><td class="detail-cell" data-copy-wrap><code>${e(urls.mcpUrl)}</code><button type="button" class="copy-btn inline" data-copy title="Copy" aria-label="Copy MCP endpoint">${copyIcons}</button></td></tr>
<tr><th>Keycloak redirect</th><td class="detail-cell" data-copy-wrap><code>${e(urls.callbackUrl)}</code><button type="button" class="copy-btn inline" data-copy title="Copy" aria-label="Copy Keycloak redirect URL">${copyIcons}</button></td></tr>
<tr><th>Gateway receives relay at</th><td class="detail-cell"><code>${e(publicAuthCallbackUrl(publicBaseUrl))}</code></td></tr>
<tr><th>Health JSON</th><td class="detail-cell" data-copy-wrap><code>${e(urls.healthUrl)}</code><button type="button" class="copy-btn inline" data-copy title="Copy" aria-label="Copy health URL">${copyIcons}</button></td></tr>
<tr><th>Setup catalogue</th><td class="detail-cell" data-copy-wrap><code>${e(urls.setupBase)}</code><button type="button" class="copy-btn inline" data-copy title="Copy" aria-label="Copy setup catalogue URL">${copyIcons}</button></td></tr>
</tbody>
</table>
</section>

<section class="card" aria-label="Readme">
<h2>Installation readme (short)</h2>
<ol>
<li>Pick your client, OS, and command in the builder above, copy the generated command, and run it on the <em>client</em> machine (macOS/Linux needs <code>sh</code> + <code>node 22+</code>; Windows needs PowerShell + <code>node</code>).</li>
<li><strong>Restart the app (required):</strong> Codex/OpenCode — quit + reopen; Claude Code — new session; <strong>Claude Desktop — fully quit with <code>Cmd+Q</code> / <code>File &gt; Exit</code>, reopen, new chat</strong>; VS Code — <code>Developer: Reload Window</code>; Cursor — quit + reopen.</li>
<li>Ask the agent to log in: it calls <code>tdei_sso_login</code> and gives you a browser URL.</li>
<li>Complete SSO in the browser, then call tools (health: <code>tdei_health</code>, status: <code>tdei_auth_status</code>).</li>
<li>MCP broken later (server moved, entry stale)? Pick <em>Update / reinstall</em> in the builder, run it, restart the app, start a new chat. To remove TDEI instead, pick <em>Uninstall</em>.</li>
</ol>
<p class="muted">Full guide lives in <code>README.md</code> of the TDEI-MCP repo. File bytes never go through MCP — run curl from the client machine for any size, then poll with tdei_list_jobs; local stdio also accepts absolute <code>local_path</code> assets.</p>
</section>
</main>
<script>
async function copyTextFromButton(btn) {
  const wrap = btn.closest('[data-copy-wrap]');
  const el = wrap ? wrap.querySelector('code, pre') : null;
  const text = el ? el.innerText : '';
  if (!text) return;
  try {
    let done = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        done = true;
      } catch {
        done = false;
      }
    }
    if (!done) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const prevLabel = btn.getAttribute('aria-label') || 'Copy';
    btn.classList.add('copied');
    btn.setAttribute('aria-label', 'Copied');
    btn.title = 'Copied';
    setTimeout(() => { btn.classList.remove('copied'); btn.setAttribute('aria-label', prevLabel); btn.title = 'Copy'; }, 1500);
  } catch (err) {
    const prevLabel = btn.getAttribute('aria-label') || 'Copy';
    btn.setAttribute('aria-label', 'Failed to copy');
    btn.title = 'Failed';
    setTimeout(() => { btn.setAttribute('aria-label', prevLabel); btn.title = 'Copy'; }, 1500);
  }
}
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyTextFromButton(btn));
});
const TDEI_SETUP_BASE = ${JSON.stringify(urls.setupBase).replace(/</g, "\\u003c")};
const TDEI_MCP_NAME = ${JSON.stringify(mcpName).replace(/</g, "\\u003c")};
const TDEI_ACTION_HINTS = {
  install: 'Writes the ' + TDEI_MCP_NAME + ' entry for your client. Needs sh + node 22+ on the client machine (PowerShell + node on Windows).',
  update: 'Safe to re-run — replaces only the ' + TDEI_MCP_NAME + ' entry, keeps every other entry. Run it, restart the app, start a new chat.',
  uninstall: 'Removes only the ' + TDEI_MCP_NAME + ' entry — every other MCP server entry is kept. Restart the app afterwards.'
};
function tdeiBuildCommand() {
  const client = document.getElementById('tdei-harness').value;
  const os = document.getElementById('tdei-os').value;
  const action = document.getElementById('tdei-action').value;
  const scriptPath = action === 'install' ? client : action + '/' + client;
  const cmd = os === 'ps1'
    ? 'Set-ExecutionPolicy Bypass -Scope Process -Force; irm ' + TDEI_SETUP_BASE + '/' + scriptPath + '.ps1 | iex'
    : 'curl -fsSL ' + TDEI_SETUP_BASE + '/' + scriptPath + ' | sh';
  document.getElementById('tdei-command').textContent = cmd;
  document.getElementById('tdei-hint').textContent = TDEI_ACTION_HINTS[action] || '';
}
['tdei-harness', 'tdei-os', 'tdei-action'].forEach((id) => {
  document.getElementById(id).addEventListener('change', tdeiBuildCommand);
});
tdeiBuildCommand();
async function load() {
  const dot = document.getElementById('dot');
  const ok = document.getElementById('ok');
  const rows = document.getElementById('rows');
  const updated = document.getElementById('updated');
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const h = await res.json();
    const good = !!h.ok;
    dot.className = 'dot ' + (good ? 'ok' : 'bad');
    ok.textContent = h.ok ? 'healthy' : 'needs attention';
    const row = (k, v) => '<tr><th>' + k + '</th><td><code>' + String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</code></td></tr>';
    rows.innerHTML =
      row('auth', (h.auth && h.auth.state) || 'unknown') +
      row('openapi.loaded', h.openapi && h.openapi.loaded) +
      row('spec', (h.spec && h.spec.url || '') + ' reachable=' + (h.spec && h.spec.reachable) + (h.spec && h.spec.latencyMs != null ? ' ' + h.spec.latencyMs + 'ms' : '')) +
      row('callback', (h.callback && h.callback.url || '') + ' portFree=' + (h.callback && h.callback.portFree)) +
      row('config', JSON.stringify(h.config || {}));
    updated.textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    dot.className = 'dot bad';
    ok.textContent = 'unreachable';
    rows.innerHTML = '<tr><td>Could not fetch /health: ' + String(err).replace(/</g,'&lt;') + '</td></tr>';
  }
}
load();
setInterval(load, 15000);
</script>
</body>
</html>
`;
}
