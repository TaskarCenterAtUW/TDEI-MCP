export interface StatusPageUrls {
  origin: string;
  mcpUrl: string;
  setupBase: string;
  healthUrl: string;
  callbackUrl: string;
}

export function statusPageUrls(publicBaseUrl: string, basePath = "/mcp"): StatusPageUrls {
  const origin = publicBaseUrl.replace(/\/$/, "");
  const prefix = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return {
    origin,
    mcpUrl: `${origin}${prefix || "/mcp"}`,
    setupBase: `${origin}${prefix || "/mcp"}/setup`,
    healthUrl: `${origin}/health`,
    callbackUrl: `${origin}/auth/callback`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Self-contained status + install dashboard.
 * Live values are fetched client-side from GET /health so the HTML
 * itself needs no templated secrets and has no new dependencies.
 */
export function renderStatusPage(publicBaseUrl: string, basePath = "/mcp"): string {
  const urls = statusPageUrls(publicBaseUrl, basePath);
  const e = escapeHtml;
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
.cmd pre { padding-right: 72px; margin: 0; }
.copy-btn { position: absolute; top: 8px; right: 8px; font-size: 12px; line-height: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid #8886; background: #8882; color: inherit; }
.copy-btn:hover { background: #8884; }
.copy-btn.inline { position: static; margin-left: 8px; padding: 3px 8px; vertical-align: middle; }
.detail-cell code { word-break: break-all; }
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
<p>No tokens are written to disk. After setup, ask your agent to call <code>tdei_sso_login</code> and open the login URL.</p>
<div class="grid">
<div><h3>Codex</h3><div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy aria-label="Copy Codex install command">Copy</button><pre>curl -fsSL ${e(urls.setupBase)}/codex | sh</pre></div></div>
<div><h3>OpenCode</h3><div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy aria-label="Copy OpenCode install command">Copy</button><pre>curl -fsSL ${e(urls.setupBase)}/opencode | sh</pre></div></div>
<div><h3>Claude Code</h3><div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy aria-label="Copy Claude Code install command">Copy</button><pre>curl -fsSL ${e(urls.setupBase)}/claude-cli | sh</pre></div></div>
<div><h3>Claude Desktop</h3><div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy aria-label="Copy Claude Desktop install command">Copy</button><pre>curl -fsSL ${e(urls.setupBase)}/claude-desktop | sh</pre></div></div>
<div><h3>VS Code</h3><div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy aria-label="Copy VS Code install command">Copy</button><pre>curl -fsSL ${e(urls.setupBase)}/vscode | sh</pre></div></div>
</div>
<h3>Windows PowerShell</h3>
<div class="cmd" data-copy-wrap><button type="button" class="copy-btn" data-copy aria-label="Copy Windows PowerShell install command">Copy</button><pre>Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${e(urls.setupBase)}/codex.ps1 | iex</pre></div>
<p class="muted">Replace <code>codex</code> with <code>opencode</code>, <code>claude-cli</code>, <code>claude-desktop</code>, or <code>vscode</code>. Full catalogue: <code>${e(urls.setupBase)}</code></p>
<h3>Restart required — do this right after the installer</h3>
<p>The client only picks up the new <code>tdei</code> entry on a full restart. Closing a chat window is not enough — restart the app, then start a <strong>new</strong> chat/session:</p>
<table>
<tbody>
<tr><th>Codex</th><td>Quit and reopen Codex, then new chat (run <code>/mcp</code> to verify <code>tdei</code>).</td></tr>
<tr><th>OpenCode</th><td>Quit and reopen OpenCode, then start a new session.</td></tr>
<tr><th>Claude Code</th><td>Exit Claude Code and start a new session (reloads <code>~/.claude.json</code>).</td></tr>
<tr><th>Claude Desktop</th><td>Fully quit with <code>Cmd+Q</code> (macOS) or <code>File &gt; Exit</code> (Windows), reopen it, then start a new chat.</td></tr>
<tr><th>VS Code</th><td><code>Cmd/Ctrl+Shift+P</code> &rarr; <code>Developer: Reload Window</code> (or quit + reopen).</td></tr>
</tbody>
</table>
<h3>Details</h3>
<table>
<tbody>
<tr><th>MCP endpoint</th><td class="detail-cell" data-copy-wrap><code>${e(urls.mcpUrl)}</code><button type="button" class="copy-btn inline" data-copy aria-label="Copy MCP endpoint">Copy</button></td></tr>
<tr><th>SSO callback (this server)</th><td class="detail-cell" data-copy-wrap><code>${e(urls.callbackUrl)}</code><button type="button" class="copy-btn inline" data-copy aria-label="Copy SSO callback URL">Copy</button></td></tr>
<tr><th>Health JSON</th><td class="detail-cell" data-copy-wrap><code>${e(urls.healthUrl)}</code><button type="button" class="copy-btn inline" data-copy aria-label="Copy health URL">Copy</button></td></tr>
<tr><th>Setup catalogue</th><td class="detail-cell" data-copy-wrap><code>${e(urls.setupBase)}</code><button type="button" class="copy-btn inline" data-copy aria-label="Copy setup catalogue URL">Copy</button></td></tr>
</tbody>
</table>
</section>

<section class="card" aria-label="Readme">
<h2>Installation readme (short)</h2>
<ol>
<li>Run one installer above on the <em>client</em> machine (needs <code>sh</code> + <code>node 22+</code>).</li>
<li><strong>Restart the app (required):</strong> Codex/OpenCode — quit + reopen; Claude Code — new session; <strong>Claude Desktop — fully quit with <code>Cmd+Q</code> / <code>File &gt; Exit</code>, reopen, new chat</strong>; VS Code — <code>Developer: Reload Window</code>.</li>
<li>Ask the agent to log in: it calls <code>tdei_sso_login</code> and gives you a browser URL.</li>
<li>Complete SSO in the browser, then call tools (health: <code>tdei_health</code>, status: <code>tdei_auth_status</code>).</li>
</ol>
<p class="muted">Full guide lives in <code>README.md</code> of the TDEI-MCP repo (quickstart via <code>npx -y tdei-mcp init</code>, HTTP mode, Docker, troubleshooting). Hosted validation/upload accepts <code>inline_base64</code> up to 10MB; local stdio accepts absolute <code>local_path</code> assets.</p>
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
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  } catch (err) {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }
}
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyTextFromButton(btn));
});
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
