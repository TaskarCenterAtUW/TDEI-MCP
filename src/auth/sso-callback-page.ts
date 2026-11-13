export interface SsoErrorPageOptions {
  /** Ordered fallback actions rendered as a numbered list (HTML allowed, trusted text only). */
  steps?: string[];
  /** Replaces the default "go back to your client" footer. */
  guidance?: string;
}

/** The three ways a browser sign-in can end badly, each with its own wording and fallbacks. */
export type SsoFailureKind = "failed" | "expired" | "declined";

export const RELAY_START_COMMAND = "node ~/.tdei-mcp/sso-callback-relay.cjs";

const FAILURE_PAGES: Record<SsoFailureKind, { heading: string; message: string; steps: string[] }> = {
  failed: {
    heading: "Sign-in failed",
    message: "TDEI could not finish this sign-in, so no session was created.",
    steps: [
      "Go back to your client and start the sign-in again.",
      "Approve it in the same browser and the same TDEI account you normally use.",
      "If it fails again, restart your client so it starts a fresh login.",
    ],
  },
  expired: {
    heading: "This sign-in has expired",
    message:
      "Sign-in links work once and only for a few minutes. This one was already used or timed out. Nothing is wrong with your account.",
    steps: [
      "If your client already shows you as signed in, close this tab.",
      "Otherwise go back to your client and start the sign-in again, then open the new link right away.",
      "Do not reload or reopen an old sign-in tab; each attempt needs a fresh link.",
    ],
  },
  declined: {
    heading: "Sign-in was cancelled",
    message: "The TDEI sign-in was declined before it finished, so you are not signed in.",
    steps: [
      "Go back to your client and start the sign-in again when you are ready.",
      "Choose Allow or Approve on the TDEI screen to finish.",
    ],
  },
};

export function renderSsoFailurePage(kind: SsoFailureKind): string {
  const page = FAILURE_PAGES[kind];
  return renderSsoErrorPage(page.heading, page.message, {
    steps: page.steps,
    guidance: `<p class="muted">You can close this tab.</p>`,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Pre-login page. Sign-in ends with the browser being sent to the loopback
 * relay at 127.0.0.1; if that helper is not running the user would only see
 * ERR_CONNECTION_REFUSED after authenticating. This checks it first. A
 * reachable (or unverifiable) helper continues to the sign-in on its own;
 * an unreachable one shows how to start it, with Retry and Continue anyway.
 * Browsers that block the check (mixed content) land on the same page, so
 * Continue anyway is always offered.
 */
export function renderSsoPreflightPage(loginUrl: string, relayHealthUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Starting TDEI sign-in</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; line-height: 1.5; display: flex; min-height: 90vh; align-items: center; justify-content: center; }
.card { max-width: 560px; text-align: center; border: 1px solid #8884; border-radius: 16px; padding: 36px 32px; }
h1 { font-size: 24px; margin: 16px 0 8px; }
p { margin: 8px 0; }
.muted { opacity: 0.75; font-size: 14px; }
.steps { text-align: left; margin: 16px auto 8px; padding-left: 22px; }
.steps li { margin: 6px 0; }
code { background: #8883; border-radius: 6px; padding: 2px 6px; font-size: 13px; word-break: break-all; }
button, a.btn { display: inline-block; margin: 6px 4px; padding: 9px 16px; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; font: inherit; cursor: pointer; text-decoration: none; }
[hidden] { display: none; }
</style>
</head>
<body>
<main class="card">
<section id="checking">
<h1>Starting TDEI sign-in&hellip;</h1>
<p>Checking that this computer can receive the sign-in result.</p>
<noscript><p><a class="btn" href="${escapeHtml(loginUrl)}">Continue to sign in</a></p></noscript>
</section>
<section id="missing" hidden>
<h1>Sign-in helper is not running</h1>
<p>After you sign in, TDEI sends you back to a small helper on this computer (<code>127.0.0.1:8765</code>). It is not answering, so the sign-in would end on a &ldquo;can&rsquo;t reach this page&rdquo; screen.</p>
<ol class="steps">
<li>Start it in a terminal: <code>${escapeHtml(RELAY_START_COMMAND)}</code></li>
<li>If that file is missing, run the TDEI MCP setup again from your install page.</li>
<li>Check that nothing else is using port 8765: <code>lsof -nP -iTCP:8765</code></li>
</ol>
<p><button id="retry" type="button">Check again</button> <a class="btn" href="${escapeHtml(loginUrl)}">Continue anyway</a></p>
<p class="muted">Continue anyway is safe if your browser blocks this check (for example Safari).</p>
</section>
</main>
<script>
(function () {
  var loginUrl = ${jsString(loginUrl)};
  var healthUrl = ${jsString(relayHealthUrl)};
  var checking = document.getElementById("checking");
  var missing = document.getElementById("missing");
  function probe() {
    checking.hidden = false;
    missing.hidden = true;
    var timer = new AbortController();
    var cut = setTimeout(function () { timer.abort(); }, 2500);
    fetch(healthUrl, { mode: "no-cors", cache: "no-store", signal: timer.signal })
      .then(function () { clearTimeout(cut); location.replace(loginUrl); })
      .catch(function () { clearTimeout(cut); checking.hidden = true; missing.hidden = false; });
  }
  document.getElementById("retry").addEventListener("click", probe);
  probe();
})();
</script>
</body>
</html>`;
}

/**
 * Browser page shown when the SSO callback cannot complete the sign-in:
 * no login is in progress on this server, the user declined, or the code
 * exchange failed. Tells the user to go back to their client and start the
 * login again instead of staring at a bare error.
 */
export function renderSsoErrorPage(heading: string, message: string, options?: SsoErrorPageOptions): string {
  const steps = options?.steps ?? [];
  const stepsHtml = steps.length ? `<ol class="steps">${steps.map((step) => `<li>${step}</li>`).join("")}</ol>` : "";
  const guidance =
    options?.guidance ??
    `<p><strong>Go back to your client</strong> and start the sign-in again, then approve it in this browser. You can close this tab.</p>
<p class="muted">If it keeps failing, restart the login from your agent (tdei_sso_login) and retry.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TDEI sign-in needs attention</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; line-height: 1.5; display: flex; min-height: 90vh; align-items: center; justify-content: center; }
.card { max-width: 520px; text-align: center; border: 1px solid #8884; border-radius: 16px; padding: 36px 32px; }
h1 { font-size: 24px; margin: 16px 0 8px; }
p { margin: 8px 0; }
.muted { opacity: 0.75; font-size: 14px; }
.steps { text-align: left; margin: 16px auto 8px; padding-left: 22px; }
.steps li { margin: 6px 0; }
code { background: #8883; border-radius: 6px; padding: 2px 6px; font-size: 13px; word-break: break-all; }
</style>
</head>
<body>
<main class="card">
<svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26" stroke="#c9a227" stroke-width="4"/><path d="M28 16v15" stroke="#c9a227" stroke-width="5" stroke-linecap="round"/><circle cx="28" cy="38" r="3" fill="#c9a227"/></svg>
<h1>${heading}</h1>
<p>${message}</p>
${stepsHtml}
${guidance}
</main>
</body>
</html>`;
}

/**
 * Browser page served by a gateway that has no login waiting for a callback
 * that arrived through the loopback relay. It sends the browser back to the
 * relay with the same query so the relay can try the next known gateway.
 * Served with status 404: nginx must still offer the callback to sibling
 * connectors before this page is shown.
 */
export function renderSsoRelayRetryPage(nextUrl: string): string {
  const href = nextUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const jsonUrl = JSON.stringify(nextUrl).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0;url=${href}" />
<title>Trying the next TDEI gateway</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; line-height: 1.5; display: flex; min-height: 90vh; align-items: center; justify-content: center; }
.card { max-width: 520px; text-align: center; border: 1px solid #8884; border-radius: 16px; padding: 36px 32px; }
h1 { font-size: 24px; margin: 16px 0 8px; }
p { margin: 8px 0; }
.muted { opacity: 0.75; font-size: 14px; }
</style>
</head>
<body>
<main class="card">
<h1>Checking the next TDEI environment&hellip;</h1>
<p>This gateway had no sign-in waiting for that callback. Redirecting to the next TDEI gateway.</p>
<p class="muted">If nothing happens, <a href="${href}">continue</a>.</p>
</main>
<script>location.replace(${jsonUrl});</script>
</body>
</html>`;
}

/**
 * Browser page shown after the SSO callback finishes (login or logout).
 * Tells the user the sign-in worked and to go back to their client: the
 * agent retries the tool call that triggered the login, so nothing else is
 * needed in the browser. Self-contained (inline CSS, no JS, no external
 * resources) because it is served from a loopback listener.
 */
export function renderSsoResultPage(kind: "login" | "logout"): string {
  const login = kind === "login";
  const title = login ? "TDEI login complete" : "TDEI logout complete";
  const heading = login ? "Login complete" : "Logout complete";
  const accent = login ? "#22a06b" : "#60606a";
  const icon = login
    ? `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26" stroke="${accent}" stroke-width="4"/><path d="M17 29l8 8 15-17" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26" stroke="${accent}" stroke-width="4"/><path d="M23 18h-5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5M36 22l6 6-6 6M42 28H24" stroke="${accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const message = login
    ? "Your TDEI sign-in worked. <strong>Go back to your client</strong> &mdash; the app or terminal where your agent runs. The tool call that asked you to sign in will be retried automatically."
    : "You are signed out of TDEI. <strong>Go back to your client</strong> to sign in again whenever you need to.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; line-height: 1.5; display: flex; min-height: 90vh; align-items: center; justify-content: center; }
.card { max-width: 520px; text-align: center; border: 1px solid #8884; border-radius: 16px; padding: 36px 32px; }
h1 { font-size: 24px; margin: 16px 0 8px; }
p { margin: 8px 0; }
.muted { opacity: 0.75; font-size: 14px; }
</style>
</head>
<body>
<main class="card">
${icon}
<h1>${heading}</h1>
<p>${message}</p>
<p class="muted">If this tab did not close itself, you can close it.</p>
</main>
<script>
// Closes the tab when the harness opened it programmatically (its own
// popup/redirect round-trip). Browsers ignore this for manually opened tabs,
// where the message above is the fallback.
try { window.close(); } catch {}
</script>
</body>
</html>`;
}
