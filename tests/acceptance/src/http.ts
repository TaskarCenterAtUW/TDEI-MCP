import { redact } from "./redact.ts";

export interface Resp { status: number; headers: Headers; text: string; ms: number; json: unknown; }
export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Resp> {
  const t0 = Date.now();
  let res: Response;
  try { res = await fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60000) }); }
  catch (e) { const c = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e); throw new Error(`request to ${new URL(url).origin}${new URL(url).pathname} failed: ${c}`); }
  const text = await res.text();
  let json: unknown; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, ms: Date.now() - t0, json };
}
export const brief = (r: Resp): string => redact(`HTTP ${r.status} ${r.text.slice(0, 200)}`);
