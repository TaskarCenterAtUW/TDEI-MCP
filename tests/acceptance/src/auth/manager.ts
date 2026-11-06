// Per-environment-label token lifecycle: use stored token, refresh with skew under lock, else login or exit 3.
import type { Config, SlugConfig } from "../config.ts";
import { interactiveLogin, ReauthRequired, refresh } from "./oauth.ts";
import { readToken, tokenPath, withLock, writeToken, deleteToken, type StoredToken } from "./store.ts";
import { http } from "../http.ts";
import { registerSecret } from "../redact.ts";

export const EXIT_REAUTH = 3;
export class AuthManager {
  private cfg: Config; private say: (m: string) => void;
  constructor(cfg: Config, say: (m: string) => void = (m) => console.error(m)) { this.cfg = cfg; this.say = say; }
  path(label: string) { return tokenPath(this.cfg.tokenDir, label, this.cfg.profile); }
  stored(label: string) { return readToken(this.path(label)); }
  status(label: string): string {
    const t = this.stored(label); if (!t) return "no token";
    const left = Math.round((t.expiresAt - Date.now()) / 1000);
    return `${left > 0 ? `access valid ${left}s` : `access expired ${-left}s ago`}; refresh token ${t.refreshToken ? "present" : "absent"}; obtained via ${t.slug}`;
  }
  logout(label: string) { return deleteToken(this.path(label)); }

  /** Returns a usable access token, or throws ReauthRequired (CLI maps to exit code 3 when unattended). */
  async token(c: SlugConfig, force = false): Promise<string> {
    const p = this.path(c.label);
    return withLock(p, async () => {
      let t = readToken(p);
      const fresh = (x: StoredToken) => x.expiresAt - Date.now() > this.cfg.refreshSkewSec * 1000;
      if (t && !force && fresh(t)) return t.accessToken;
      if (t?.refreshToken) {
        try { t = await refresh(c, t); writeToken(p, t); return t.accessToken; }
        catch (e) { if (!(e instanceof ReauthRequired)) throw e; }
      }
      if (this.cfg.interactive === "never" || !process.stdin.isTTY && this.cfg.interactive !== "auto") throw new ReauthRequired(`login required for "${c.label}" (run: acceptance auth login --env ${c.label})`);
      if (!process.stdout.isTTY && process.env.ACCEPT_ALLOW_NON_TTY_LOGIN !== "1") throw new ReauthRequired(`login required for "${c.label}" and no terminal is attached (run: acceptance auth login --env ${c.label})`);
      t = await interactiveLogin(c, { relayPort: this.cfg.relayPort, timeoutSec: this.cfg.loginTimeoutSec, say: this.say });
      writeToken(p, t); registerSecret(t.accessToken);
      return t.accessToken;
    });
  }
  /** One-shot probe: does the gateway accept the token? */
  async accepted(c: SlugConfig, token: string): Promise<boolean> {
    const r = await http(c.mcpUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), timeoutMs: 30000 });
    return r.status !== 401;
  }
}
