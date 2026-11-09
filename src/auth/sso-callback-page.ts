/**
 * Browser page shown when the SSO callback cannot complete the sign-in:
 * no login is in progress on this server, the user declined, or the code
 * exchange failed. Tells the user to go back to their client and start the
 * login again instead of staring at a bare error.
 */
export function renderSsoErrorPage(heading: string, message: string): string {
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
</style>
</head>
<body>
<main class="card">
<svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26" stroke="#c9a227" stroke-width="4"/><path d="M28 16v15" stroke="#c9a227" stroke-width="5" stroke-linecap="round"/><circle cx="28" cy="38" r="3" fill="#c9a227"/></svg>
<h1>${heading}</h1>
<p>${message}</p>
<p><strong>Go back to your client</strong> and start the sign-in again, then approve it in this browser. You can close this tab.</p>
<p class="muted">If it keeps failing, restart the login from your agent (tdei_sso_login) and retry.</p>
</main>
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
<p class="muted">You can close this tab.</p>
</main>
</body>
</html>`;
}
