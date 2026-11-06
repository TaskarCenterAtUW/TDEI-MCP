// Provider adapters (fetch only) + cassette record/replay + token accounting.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type LlmConfig } from "../config.ts";
import { registerSecret } from "../redact.ts";

export interface Call { id: string; name: string; args: Record<string, unknown>; }
export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: Call[] }
  | { role: "tool"; results: Array<{ id: string; name: string; text: string; isError: boolean }> };
export interface ToolDef { name: string; description: string; inputSchema: any; }
export interface Reply { text: string; calls: Call[]; tokensIn: number; tokensOut: number; }
export interface Llm { name: string; chat(system: string, msgs: Msg[], tools: ToolDef[]): Promise<Reply>; }

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const t = await r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((x) => setTimeout(x, 2000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${t.slice(0, 300)}`);
    return JSON.parse(t);
  }
}
const clean = (s: any): any => {
  if (Array.isArray(s)) return s.map(clean);
  if (s && typeof s === "object") { const o: any = {}; for (const [k, v] of Object.entries(s)) if (!["$schema", "additionalProperties", "default", "$ref", "propertyNames"].includes(k)) o[k] = clean(v); return o; }
  return s;
};

function anthropic(key: string, model: string, temperature: number): Llm {
  registerSecret(key);
  return { name: `anthropic:${model}`, async chat(system, msgs, tools) {
    const messages = msgs.map((m) => m.role === "user" ? { role: "user", content: m.text }
      : m.role === "assistant" ? { role: "assistant", content: [...(m.text ? [{ type: "text", text: m.text }] : []), ...m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))] }
      : { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text, is_error: r.isError })) });
    const j = await post("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, { model, max_tokens: 2048, temperature, system, messages, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) });
    const blocks: any[] = j.content ?? [];
    return { text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"), calls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })), tokensIn: j.usage?.input_tokens ?? 0, tokensOut: j.usage?.output_tokens ?? 0 };
  } };
}
function openai(key: string | undefined, model: string, temperature: number, baseUrl = "https://api.openai.com/v1"): Llm {
  registerSecret(key);
  return { name: `openai:${model}`, async chat(system, msgs, tools) {
    const messages: any[] = [{ role: "system", content: system }];
    for (const m of msgs) {
      if (m.role === "user") messages.push({ role: "user", content: m.text });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.text || null, ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
      else for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.text });
    }
    const j = await post(`${baseUrl}/chat/completions`, key ? { Authorization: `Bearer ${key}` } : {}, { model, temperature, messages, tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) });
    const msg = j.choices?.[0]?.message ?? {};
    return { text: msg.content ?? "", calls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments) })), tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 };
  } };
}
function gemini(key: string, model: string, temperature: number): Llm {
  registerSecret(key);
  return { name: `gemini:${model}`, async chat(system, msgs, tools) {
    const contents = msgs.map((m) => m.role === "user" ? { role: "user", parts: [{ text: m.text }] }
      : m.role === "assistant" ? { role: "model", parts: [...(m.text ? [{ text: m.text }] : []), ...m.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] }
      : { role: "user", parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.text } } })) });
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": key }, { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature }, tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: clean(t.inputSchema) })) }] });
    const parts: any[] = j.candidates?.[0]?.content?.parts ?? []; let n = 0;
    return { text: parts.filter((p) => p.text).map((p) => p.text).join("\n"), calls: parts.filter((p) => p.functionCall).map((p) => ({ id: `g${n++}`, name: p.functionCall.name, args: p.functionCall.args ?? {} })), tokensIn: j.usageMetadata?.promptTokenCount ?? 0, tokensOut: j.usageMetadata?.candidatesTokenCount ?? 0 };
  } };
}
const safeJson = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

export type Script = (msgs: Msg[], tools: ToolDef[]) => { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };
/** Deterministic stand-in used by `selftest` so the harness is verifiable without a key. */
export function mockLlm(script: Script): Llm {
  let n = 0;
  return { name: "mock", async chat(_s, msgs, tools) { const r = script(msgs, tools); return { text: r.text ?? "", calls: (r.calls ?? []).map((c) => ({ id: `m${n++}`, name: c.name, args: c.args })), tokensIn: 10, tokensOut: 10 }; } };
}

export function makeLlm(cfg: LlmConfig, tools: ToolDef[], instructionsHash: string): Llm & { used(): number } {
  let inner: Llm;
  const need = (k: string | undefined, n: string) => { if (!k) throw new Error(`${n} is not set (Part 2 needs the key for ACCEPT_LLM_PROVIDER=${cfg.provider})`); return k; };
  const live = (): Llm => cfg.provider === "openai" ? openai(cfg.baseUrl ? cfg.keys.openai : need(cfg.keys.openai, "OPENAI_API_KEY"), cfg.model, cfg.temperature, cfg.baseUrl) : cfg.provider === "gemini" ? gemini(need(cfg.keys.gemini, "GEMINI_API_KEY"), cfg.model, cfg.temperature) : anthropic(need(cfg.keys.anthropic, "ANTHROPIC_API_KEY"), cfg.model, cfg.temperature);
  const dir = join(ROOT, ".cache", "cassettes"); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${cfg.provider}-${(cfg.baseUrl ?? "").replace(/[^\w.-]/g, "_")}-${cfg.model.replace(/[^\w.-]/g, "_")}.json`);
  const store: Record<string, Reply> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const fp = createHash("sha256").update(JSON.stringify(tools) + instructionsHash).digest("hex").slice(0, 16);
  let tokens = 0; let liveInner: Llm | undefined;
  inner = { name: `${cfg.provider}:${cfg.model}:${cfg.mode}`, async chat(system, msgs, tl) {
    const key = createHash("sha256").update(JSON.stringify({ p: cfg.provider, b: cfg.baseUrl, m: cfg.model, t: cfg.temperature, system, fp, msgs })).digest("hex");
    if (cfg.mode !== "live" && store[key]) return store[key]!;
    if (cfg.mode === "replay") throw new Error("cassette miss in replay mode (tool descriptions or prompts changed; re-record with ACCEPT_LLM_MODE=record)");
    liveInner ??= live();
    const r = await liveInner.chat(system, msgs, tl);
    if (cfg.mode === "record") { store[key] = r; writeFileSync(file, JSON.stringify(store)); }
    return r;
  } };
  return { name: inner.name, used: () => tokens, async chat(s, m, t) { const r = await inner.chat(s, m, t); tokens += r.tokensIn + r.tokensOut; return r; } };
}
