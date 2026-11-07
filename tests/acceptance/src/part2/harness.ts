import { McpClient, type ToolOutcome } from "../mcp.ts";
import { redact, scanForSecrets } from "../redact.ts";
import type { Call, Llm, Msg, ToolDef } from "./llm.ts";

export interface TraceCall { turn: number; user: number; name: string; args: Record<string, unknown>; text: string; isError: boolean; blocked?: string; injected?: boolean; }
export interface Trace {
  calls: TraceCall[]; transcript: Array<{ role: string; text: string }>; finalText: string; assistantTexts: string[];
  turns: number; gateViolations: string[]; tokens: number; ms: number; aborted?: string;
}
export interface RunOpts {
  system: string; tools: ToolDef[]; mcp: McpClient; llm: Llm; userTurns: string[];
  allowedTools?: string[]; maxTurns: number; maxToolTurns: number; maxTokens: number;
  /** Replace a tool's real result (harness-level fault injection). Return undefined to pass through. */
  inject?: (call: Call, nth: number) => { text: string; isError: boolean } | undefined;
  onUsage?: () => number;
}
// Read-only scope: these tools change state on the real gateway. They are blocked in every scenario unless it lists them in allowedTools
// (upload/validate only return a curl hand-off, so they are safe to allow). A blocked attempt is still recorded in the trace.
const MUTATING = new Set([
  "tdei_upload_dataset", "tdei_validate_dataset", "tdei_delete_dataset", "tdei_publish_dataset", "tdei_clone_dataset", "tdei_edit_metadata",
  "tdei_regenerate_api_key", "tdei_set_viewer_access", "tdei_self_merge", "tdei_union_datasets", "tdei_cut_dataset_bbox", "tdei_sanitize_dataset",
  "tdei_submit_feedback", "tdei_update_feedback_status", "tdei_convert_osw", "tdei_convert_pathways", "tdei_tag_incline", "tdei_tag_quality_metric",
  "tdei_tag_road", "tdei_spatial_join", "tdei_recover_password", "tdei_verify_email", "tdei_logout",
]);
export const isMutating = (n: string) => MUTATING.has(n);
/** Mutating tool attempted by the model (executed or blocked). */
export const mutatingAttempts = (t: Trace) => t.calls.filter((c) => isMutating(c.name));

/** Valid hand-off input is {kind:"local_path", path:<absolute>}; inline bytes, URLs, object refs and changesets are never sent by the model. */
function badPayload(args: Record<string, unknown>): boolean {
  if ("changeset" in args) return true;
  const a = args.asset; if (a === undefined) return false;
  if (typeof a === "string") return !/^(\/|[A-Za-z]:\\)/.test(a);
  const o = a as { kind?: unknown; path?: unknown }; return o?.kind !== "local_path" || typeof o.path !== "string" || !/^(\/|[A-Za-z]:[\\/])/.test(o.path);
}
export async function runScenario(o: RunOpts): Promise<Trace> {
  const t0 = Date.now(); const msgs: Msg[] = []; const tr: Trace = { calls: [], transcript: [], finalText: "", assistantTexts: [], turns: 0, gateViolations: [], tokens: 0, ms: 0 };
  const nth = new Map<string, number>();
  for (const [ui, u] of o.userTurns.entries()) {
    msgs.push({ role: "user", text: u }); tr.transcript.push({ role: "user", text: u });
    let toolTurns = 0;
    for (;;) {
      if (++tr.turns > o.maxTurns + o.userTurns.length) { tr.aborted = "max_turns"; return fin(tr, o, t0); }
      if (o.onUsage && o.onUsage() > o.maxTokens) { tr.aborted = "token_budget"; return fin(tr, o, t0); }
      const r = await o.llm.chat(o.system, msgs, o.tools);
      msgs.push({ role: "assistant", text: r.text, calls: r.calls });
      if (r.text) { tr.assistantTexts.push(r.text); tr.transcript.push({ role: "assistant", text: r.text }); tr.finalText = r.text; }
      if (r.calls.length === 0) break;
      if (++toolTurns > o.maxToolTurns) { tr.aborted = "max_tool_turns"; return fin(tr, o, t0); }
      const results: Array<{ id: string; name: string; text: string; isError: boolean }> = [];
      for (const c of r.calls) {
        const n = (nth.get(c.name) ?? 0) + 1; nth.set(c.name, n);
        const rec: TraceCall = { turn: tr.turns, user: ui, name: c.name, args: c.args, text: "", isError: false };
        let blocked: string | undefined;
        if (o.allowedTools && !o.allowedTools.includes(c.name)) blocked = `tool ${c.name} is not allowed in this scenario`;
        else if (!o.allowedTools && isMutating(c.name)) blocked = `tool ${c.name} changes data; the suite is read-only`;
        else if (c.args && badPayload(c.args)) blocked = "arguments carry file bytes, a URL, or a non-absolute path; only {kind:'local_path', path:<absolute client path>} is a valid asset (the server only embeds it in a curl)";
        if (blocked) { rec.blocked = blocked; rec.isError = true; rec.text = `blocked by test harness: ${blocked}`; if (/file bytes/.test(blocked)) tr.gateViolations.push(`${c.name}: ${blocked}`); }
        else {
          const inj = o.inject?.(c, n);
          if (inj) { rec.text = inj.text; rec.isError = inj.isError; rec.injected = true; }
          else { const out: ToolOutcome = await o.mcp.call(c.name, c.args ?? {}); rec.text = out.text || out.protocolError?.message || ""; rec.isError = out.isError || Boolean(out.protocolError); }
        }
        tr.calls.push(rec); tr.transcript.push({ role: "tool", text: `${c.name}(${JSON.stringify(c.args)}) -> ${rec.text.slice(0, 600)}` });
        results.push({ id: c.id, name: c.name, text: rec.text, isError: rec.isError });
      }
      msgs.push({ role: "tool", results });
    }
  }
  return fin(tr, o, t0);
}
function fin(tr: Trace, o: RunOpts, t0: number): Trace { tr.ms = Date.now() - t0; tr.tokens = o.onUsage?.() ?? 0; return tr; }

export function systemPrompt(instructions: string | undefined): string {
  return ["You are an assistant helping a user work with TDEI (Transportation Data Equity Initiative) data through the connected MCP server tools.", "Use the tools when they help. Ask the user for missing information instead of guessing. Never invent tool results.", instructions ? `\nServer instructions:\n${instructions}` : ""].join("\n");
}

// ---- assertions -------------------------------------------------------------------------------------------------
export const names = (t: Trace) => t.calls.filter((c) => !c.blocked).map((c) => c.name);
export const callsOf = (t: Trace, n: string) => t.calls.filter((c) => c.name === n && !c.blocked);
export function subsequence(have: string[], want: string[]): boolean { let i = 0; for (const h of have) if (h === want[i]) i++; return i >= want.length; }
// validate/upload/download return a curl hand-off that carries the caller's own bearer by design. Mask "Bearer <token>" before scanning;
// a JWT or token field anywhere else (or a different credential shape) is still an invariant-1 violation.
export function secretFree(t: Trace): string[] { return scanForSecrets(JSON.stringify(t.transcript).replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]{20,}/gi, "$1<own-token>")); }

/** Collects every assertion a scenario makes, passed or failed, so the log can show them all. */
export class Asserts {
  items: Array<{ ok: boolean; what: string; detail?: string }> = [];
  that(ok: boolean, what: string, detail?: string): boolean { this.items.push({ ok, what, ...(detail ? { detail } : {}) }); return ok; }
  get failures(): string[] { return this.items.filter((i) => !i.ok).map((i) => (i.detail ? `${i.what} (${i.detail})` : i.what)); }
}

/** One-line digest of an MCP tool result: status, questions asked, error code, and the size of each data field. */
export function summarizeResult(text: string, full = false): string {
  const red = redact(text); let out = "";
  try {
    const j = JSON.parse(text); const bits: string[] = [];
    if (j.status) bits.push(`status=${j.status}`);
    if (j.code || j.error?.code) bits.push(`code=${j.code ?? j.error.code}`);
    for (const m of j.missing ?? []) bits.push(`asks "${String(m.question ?? m.field).slice(0, 80)}"`);
    const d = j.data;
    if (d && typeof d === "object") for (const [k, v] of Object.entries(d)) {
      if (Array.isArray(v)) bits.push(`${k}[${v.length}]`);
      else if (v && typeof v === "object") bits.push(`${k}{${Object.keys(v as object).slice(0, 4).join(",")}}`);
      else if (/token|curl|authorization/i.test(k)) bits.push(`${k}=<hidden>`);
      else bits.push(`${k}=${String(v).slice(0, 60)}`);
    }
    out = bits.join(" ");
  } catch { out = red.slice(0, 160).replace(/\s+/g, " "); }
  return full ? `${out}\n        raw: ${red.slice(0, 1500)}` : out;
}

/** Human-readable record of one scenario run: what was asked, what the MCP returned, how the model interpreted it, every assertion. */
export function renderRun(id: string, title: string, run: number, repeats: number, slug: string, t: Trace, a: Asserts, verdict: string): string {
  const full = process.env.ACCEPT_VERBOSE === "1"; const L: string[] = []; let ci = 0;
  L.push(`  ┌ ${id} ${title}  [${slug}] run ${run}/${repeats}  (${Math.round(t.ms / 1000)}s, ${t.tokens} tokens, ${t.calls.length} tool calls)`);
  for (const e of t.transcript) {
    if (e.role === "user") L.push(`  │ USER    ${redact(e.text).slice(0, 300)}`);
    else if (e.role === "assistant") L.push(`  │ MODEL   ${redact(e.text).replace(/\s+/g, " ").slice(0, 600)}`);
    else { const c = t.calls[ci++]; if (!c) continue;
      L.push(`  │ CALL    ${c.name} ${redact(JSON.stringify(c.args)).slice(0, 220)}${c.blocked ? "   [BLOCKED by harness]" : ""}`);
      L.push(`  │   MCP → ${c.blocked ? c.text : summarizeResult(c.text, full)}`); }
  }
  if (t.aborted) L.push(`  │ ABORTED ${t.aborted}`);
  L.push("  │ ASSERTS");
  for (const i of a.items) L.push(`  │   ${i.ok ? "✓" : "✗"} ${i.what}${i.detail && !i.ok ? `  — ${i.detail}` : ""}`);
  L.push(`  └ ${verdict}`);
  return L.join("\n");
}
export function argsMatch(c: TraceCall, expect: Record<string, unknown>): boolean { return Object.entries(expect).every(([k, v]) => typeof v === "string" ? String(c.args[k] ?? "").toLowerCase().includes(v.toLowerCase()) : JSON.stringify(c.args[k]) === JSON.stringify(v)); }
export const redactTrace = (t: Trace) => JSON.parse(redact(JSON.stringify(t)));
