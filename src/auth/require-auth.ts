import type { AuthManager } from "./auth-manager.js";
import type { SsoLoginOptions } from "./types.js";
import { SsoRequiredError } from "../mcp/errors.js";

type SessionAuth = Pick<AuthManager, "getAccessToken" | "startSsoLogin"> &
  Partial<Pick<AuthManager, "restoreSharedSession">>;

/**
 * Pre-call auth gate for MCP tool handlers. Resolves when this session holds
 * a usable SSO token; otherwise starts (or reuses the pending) browser login
 * and throws an SsoRequiredError carrying copy-pasteable URLs — so the tool
 * call never proceeds upstream without a session and the agent can show the
 * sign-in link instead of sending the user to client Settings.
 *
 * A fresh process holds no in-memory token even when a sibling login already
 * persisted a valid shared session to disk, so the gate adopts that shared
 * session first and only starts a browser login when nothing usable exists.
 * startSsoLogin is idempotent while a login is pending, so repeated
 * unauthenticated calls reuse the same loginUrl and never stack listeners.
 */
export async function ensureSessionAuth(auth: SessionAuth, options?: SsoLoginOptions): Promise<void> {
  try {
    await auth.getAccessToken();
    return;
  } catch {
    // No usable in-memory token (missing or refresh failed): a sibling MCP
    // may still hold a live shared session on disk. Adopting it here means
    // the agent never has to call the login tool for a token that is
    // already present.
    if (typeof auth.restoreSharedSession === "function") {
      const restored = await auth.restoreSharedSession().catch(() => false);
      if (restored) {
        try {
          await auth.getAccessToken();
          return;
        } catch {
          // Adoption reported success but yielded no usable token:
          // fall through to a browser login.
        }
      }
    }
  }
  let login: { loginUrl: string; callbackUrl: string };
  try {
    login = await auth.startSsoLogin({ preflight: true, ...options });
  } catch (error) {
    throw new SsoRequiredError(error instanceof Error ? error.message : String(error));
  }
  throw new SsoRequiredError(
    [
      "TDEI SSO login is required: this session holds no usable token, so the tool call was not started.",
      "1) Open this URL in your browser and approve the sign-in:",
      `   ${login.loginUrl}`,
      "2) If the browser cannot reach the local callback, copy the final callback",
      "   address-bar URL and paste it into tdei_sso_complete instead.",
      "3) Then retry the tool call.",
    ].join("\n"),
    { loginUrl: login.loginUrl, callbackUrl: login.callbackUrl },
  );
}
