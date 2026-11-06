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
        else if (c.args && ("asset" in c.args || "changeset" in c.args)) blocked = "arguments carry an asset/changeset; the suite never sends file bytes or paths";
        if (blocked) { rec.blocked = blocked; rec.isError = true; rec.text = `blocked by test harness: ${blocked}`; if (/asset|changeset/.test(blocked)) tr.gateViolations.push(`${c.name}: ${blocked}`); }
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
export function secretFree(t: Trace): string[] { return scanForSecrets(JSON.stringify(t.transcript)); }
export function argsMatch(c: TraceCall, expect: Record<string, unknown>): boolean { return Object.entries(expect).every(([k, v]) => typeof v === "string" ? String(c.args[k] ?? "").toLowerCase().includes(v.toLowerCase()) : JSON.stringify(c.args[k]) === JSON.stringify(v)); }
export const redactTrace = (t: Trace) => JSON.parse(redact(JSON.stringify(t)));
