// Minimal Streamable-HTTP MCP client over fetch. Raw on purpose: the suite needs to send malformed and
// header-less requests that an SDK client refuses to produce.
import { http, type Resp } from "./http.ts";

export interface RpcResult { status: number; headers: Headers; ms: number; body: any; raw: string; sessionId?: string; }
export class McpClient {
  sessionId: string | undefined;
  private id = 1;
  readonly url: string; private token: string | undefined; private timeoutMs: number;
  constructor(url: string, token: string | undefined, timeoutMs = 60000) { this.url = url; this.token = token; this.timeoutMs = timeoutMs; }
  setToken(t: string | undefined) { this.token = t; }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...extra,
    };
  }
  static parse(r: Resp): any {
    const ct = r.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      const msgs = r.text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
      for (const m of msgs.reverse()) { try { const j = JSON.parse(m); if (j.id !== undefined || j.result || j.error) return j; } catch { /* next */ } }
      return undefined;
    }
    return r.json;
  }
  async rpc(method: string, params?: unknown, extraHeaders?: Record<string, string>): Promise<RpcResult> {
    const r = await http(this.url, { method: "POST", headers: this.headers(extraHeaders), body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, ...(params !== undefined ? { params } : {}) }), timeoutMs: this.timeoutMs });
    const sid = r.headers.get("mcp-session-id") ?? undefined;
    if (sid && !this.sessionId) this.sessionId = sid;
    return { status: r.status, headers: r.headers, ms: r.ms, body: McpClient.parse(r), raw: r.text, ...(sid ? { sessionId: sid } : {}) };
  }
  async notify(method: string): Promise<Resp> {
    return http(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method }), timeoutMs: this.timeoutMs });
  }
  async initialize(): Promise<RpcResult> {
    const r = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tdei-acceptance", version: "1.0.0" } });
    if (r.status === 200) await this.notify("notifications/initialized").catch(() => undefined);
    return r;
  }
  async listTools(): Promise<RpcResult> { return this.rpc("tools/list", {}); }
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    return toOutcome(r);
  }
  async close(): Promise<void> {
    if (!this.sessionId) return;
    await http(this.url, { method: "DELETE", headers: this.headers(), timeoutMs: 10000 }).catch(() => undefined);
  }
}

export interface ToolOutcome { rpc: RpcResult; isError: boolean; text: string; data: any; ms: number; protocolError?: { code: number; message: string }; }
export function toOutcome(r: RpcResult): ToolOutcome {
  const res = r.body?.result; const err = r.body?.error;
  const text = Array.isArray(res?.content) ? res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "";
  let data: any = res?.structuredContent;
  if (data === undefined && text) { try { data = JSON.parse(text); } catch { data = undefined; } }
  return { rpc: r, isError: Boolean(res?.isError), text, data, ms: r.ms, ...(err ? { protocolError: { code: err.code, message: String(err.message) } } : {}) };
}
/** Pull the TDEI error code out of an error outcome: structured field, or a TDEI_* token in the text. */
export function errorCode(o: ToolOutcome): string | undefined {
  const d = o.data;
  const direct = d?.code ?? d?.error?.code ?? d?.error;
  if (typeof direct === "string" && /^TDEI_/.test(direct)) return direct;
  return (o.text + " " + (o.protocolError?.message ?? "")).match(/TDEI_[A-Z0-9_]+/)?.[0];
}
