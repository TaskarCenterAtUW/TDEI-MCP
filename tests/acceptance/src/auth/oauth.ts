// Gateway MCP OAuth client: dynamic registration, PKCE S256 authorization-code, refresh.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { http } from "../http.ts";
import type { SlugConfig } from "../config.ts";
import { registerSecret } from "../redact.ts";
import type { StoredToken } from "./store.ts";

export class ReauthRequired extends Error { constructor(msg: string) { super(msg); } }

const b64u = (b: Buffer) => b.toString("base64url");
interface Endpoints { register: string; authorize: string; token: string; }
const endpoints = (c: SlugConfig): Endpoints => ({ register: `${c.base}/${c.slug}/oauth/register`, authorize: `${c.base}/${c.slug}/oauth/authorize`, token: `${c.base}/${c.slug}/oauth/token` });

async function tokenCall(c: SlugConfig, form: Record<string, string>): Promise<StoredToken> {
  const r = await http(endpoints(c).token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), timeoutMs: 30000 });
  const j = r.json as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | undefined;
  if (r.status !== 200 || !j?.access_token) throw new ReauthRequired(`token endpoint ${r.status} ${j?.error ?? ""}`.trim());
  registerSecret(j.access_token); registerSecret(j.refresh_token);
  const now = Date.now();
  return { accessToken: j.access_token, ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}), expiresAt: now + (j.expires_in ?? 1800) * 1000, slug: c.slug, obtainedAt: now };
}

export async function refresh(c: SlugConfig, prev: StoredToken): Promise<StoredToken> {
  if (!prev.refreshToken) throw new ReauthRequired("no refresh token stored");
  const next = await tokenCall(c, { grant_type: "refresh_token", refresh_token: prev.refreshToken, client_id: "tdei-acceptance" });
  return { ...next, refreshToken: next.refreshToken ?? prev.refreshToken };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref(); } catch { /* user opens manually */ }
}

/** Relay for the one redirect URI Keycloak accepts: http://127.0.0.1:<port>/callback -> gateway /auth/callback. */
async function ensureRelay(c: SlugConfig, port: number): Promise<{ close(): void; started: boolean }> {
  const srv: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
    res.writeHead(302, { Location: `${c.base}/${c.slug}/auth/callback${u.search}` }).end();
  });
  return new Promise((resolve) => {
    srv.once("error", () => resolve({ close() {}, started: false })); // port busy: assume an existing relay
    srv.listen(port, "127.0.0.1", () => resolve({ close: () => srv.close(), started: true }));
  });
}

export async function interactiveLogin(c: SlugConfig, o: { relayPort: number; timeoutSec: number; say: (m: string) => void }): Promise<StoredToken> {
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const state = b64u(randomBytes(16));
  let captured: ((u: URL) => void) | undefined;
  const waitCode = new Promise<URL>((res) => { captured = res; });
  const lis = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/cb") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/plain" }).end("TDEI sign-in complete. You can close this tab and return to the terminal.");
    captured?.(u);
  });
  await new Promise<void>((r) => lis.listen(0, "127.0.0.1", r));
  const port = (lis.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/cb`;
  const relay = await ensureRelay(c, o.relayPort);
  try {
    const reg = await http(endpoints(c).register, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "tdei-acceptance", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }), timeoutMs: 30000 });
    const clientId = (reg.json as { client_id?: string } | undefined)?.client_id;
    if (reg.status >= 300 || !clientId) throw new Error(`client registration failed: HTTP ${reg.status}`);
    const url = new URL(endpoints(c).authorize);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", scope: "openid" })) url.searchParams.set(k, v);
    o.say(`Sign in to TDEI (${c.slug}) in the browser. If it does not open, visit:\n  ${url}`);
    if (!relay.started) o.say(`(port ${o.relayPort} already in use — assuming an existing relay forwards /callback to the gateway)`);
    openBrowser(url.toString());
    const cb = await Promise.race([waitCode, new Promise<never>((_, rej) => setTimeout(() => rej(new ReauthRequired("login timed out")), o.timeoutSec * 1000))]);
    if (cb.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
    const code = cb.searchParams.get("code");
    if (!code) throw new ReauthRequired(`login failed: ${cb.searchParams.get("error") ?? "no code returned"}`);
    return await tokenCall(c, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId });
  } finally { lis.close(); relay.close(); }
}
