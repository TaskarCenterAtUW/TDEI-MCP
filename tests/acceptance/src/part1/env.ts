import type { Config, SlugConfig } from "../config.ts";
import type { AuthManager } from "../auth/manager.ts";
import { McpClient, type ToolOutcome } from "../mcp.ts";
import { scanForSecrets } from "../redact.ts";
import { check, type Ctx } from "../runner/runner.ts";

export interface Env {
  cfg: Config; sc: SlugConfig; auth: AuthManager; healthUrl: string;
  token: string | undefined; authProblem: string | undefined;
  /** Tokens by environment label, for cross-slug tests. */
  tokensByLabel: Map<string, string>;
  client(token?: string | null): McpClient;
  lat: Map<string, number[]>;
  state: { identity?: any; fixtureDatasetId?: string; projectGroupId?: string; serviceId?: string; toolNames?: string[]; tools?: any[]; instructions?: string };
}
export function makeEnv(cfg: Config, sc: SlugConfig, auth: AuthManager, token: string | undefined, authProblem: string | undefined, tokensByLabel: Map<string, string>, healthUrl?: string): Env {
  const env: Env = {
    cfg, sc, auth, healthUrl: healthUrl ?? `${sc.base}/${sc.slug}/health`, token, authProblem, tokensByLabel, lat: new Map(), state: {},
    client: (t) => new McpClient(sc.mcpUrl, t === null ? undefined : (t ?? env.token), cfg.httpTimeoutMs),
  };
  return env;
}
export function needToken(env: Env, ctx: Ctx): string {
  if (!env.token) ctx.skip(`no token: ${env.authProblem ?? "not logged in"}`);
  return env.token!;
}
export function rec(env: Env, op: string, ms: number): void { (env.lat.get(op) ?? env.lat.set(op, []).get(op)!).push(ms); }

/** Call a tool and enforce invariants common to every call (no secrets, bounded output). */
export async function call(env: Env, name: string, args: Record<string, unknown> = {}, opts: { op?: string; client?: McpClient } = {}): Promise<ToolOutcome> {
  const c = opts.client ?? env.client();
  const o = await c.call(name, args);
  rec(env, opts.op ?? name, o.ms);
  // validate/upload return a ready curl whose Authorization header carries the caller's own bearer (by design, returned only to that caller).
  // Mask exactly that token for those tools; any other credential shape or a different token still fails invariant 1.
  const handOff = name === "tdei_validate_dataset" || name === "tdei_upload_dataset";
  const mask = (t: string) => (handOff && env.token ? t.split(env.token).join("<own-token>") : t);
  const leaks = scanForSecrets(mask(o.text + o.rpc.raw), handOff || !env.token ? [] : [env.token]);
  check(leaks.length === 0, `invariant 1 violated by ${name}: response contains ${leaks.join(", ")}`);
  const bytes = Buffer.byteLength(o.text, "utf8");
  check(bytes <= 262144 + 4096, `invariant 6 violated by ${name}: result is ${bytes} bytes`);
  if (bytes > 262144) check(/"truncated"\s*:\s*true/.test(o.text), `${name}: oversize result lacks truncation trailer`);
  return o;
}
export function status(o: ToolOutcome): string | undefined { return o.data?.status; }
export function expectStatus(o: ToolOutcome, want: string, what: string): any {
  check(!o.protocolError, `${what}: protocol error ${o.protocolError?.message}`);
  check(!o.isError, `${what}: tool error: ${o.text.slice(0, 200)}`);
  check(o.data?.status === want, `${what}: expected status ${want}, got ${o.data?.status ?? "(unparsed) " + o.text.slice(0, 120)}`);
  return o.data;
}
export function p95(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? 0; }
