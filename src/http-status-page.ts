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
<div><h3>Codex</h3><pre>curl -fsSL ${e(urls.setupBase)}/codex | sh</pre></div>
<div><h3>OpenCode</h3><pre>curl -fsSL ${e(urls.setupBase)}/opencode | sh</pre></div>
<div><h3>Claude Code</h3><pre>curl -fsSL ${e(urls.setupBase)}/claude-cli | sh</pre></div>
<div><h3>Claude Desktop</h3><pre>curl -fsSL ${e(urls.setupBase)}/claude-desktop | sh</pre></div>
<div><h3>VS Code</h3><pre>curl -fsSL ${e(urls.setupBase)}/vscode | sh</pre></div>
</div>
<h3>Windows PowerShell</h3>
<pre>Set-ExecutionPolicy Bypass -Scope Process -Force; irm ${e(urls.setupBase)}/codex.ps1 | iex</pre>
<p class="muted">Replace <code>codex</code> with <code>opencode</code>, <code>claude-cli</code>, <code>claude-desktop</code>, or <code>vscode</code>. Full catalogue: <code>${e(urls.setupBase)}</code></p>
<h3>Details</h3>
<table>
<tbody>
<tr><th>MCP endpoint</th><td><code>${e(urls.mcpUrl)}</code></td></tr>
<tr><th>SSO callback (this server)</th><td><code>${e(urls.callbackUrl)}</code></td></tr>
<tr><th>Health JSON</th><td><code>${e(urls.healthUrl)}</code></td></tr>
<tr><th>Setup catalogue</th><td><code>${e(urls.setupBase)}</code></td></tr>
</tbody>
</table>
</section>

<section class="card" aria-label="Readme">
<h2>Installation readme (short)</h2>
<ol>
<li>Run one installer above on the <em>client</em> machine (needs <code>sh</code> + <code>node 22+</code>).</li>
<li>Restart the MCP client so it picks up the new <code>tdei</code> entry.</li>
<li>Ask the agent to log in: it calls <code>tdei_sso_login</code> and gives you a browser URL.</li>
<li>Complete SSO in the browser, then call tools (health: <code>tdei_health</code>, status: <code>tdei_auth_status</code>).</li>
</ol>
<p class="muted">Full guide lives in <code>README.md</code> of the TDEI-MCP repo (quickstart via <code>npx -y tdei-mcp init</code>, HTTP mode, Docker, troubleshooting). Hosted validation/upload accepts <code>inline_base64</code> up to 10MB; local stdio accepts absolute <code>local_path</code> assets.</p>
</section>
</main>
<script>
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
