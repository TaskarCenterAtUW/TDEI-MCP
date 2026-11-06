import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { McpClient } from "../mcp.ts";
import type { Fakes } from "../fakes/fake-tdei.ts";
import type { Result } from "../runner/runner.ts";
import { redactTrace, runScenario, systemPrompt, type Trace } from "./harness.ts";
import { makeLlm, type Llm, type ToolDef } from "./llm.ts";
import { SCENARIOS, type SCtx, type Scenario } from "./scenarios.ts";

export interface P2Target { id: string; kind: "A" | "B"; mcpUrl: string; token: string; place: string; fakes?: Fakes; }
export interface P2Opts { cfg: Config; target: P2Target; outDir: string; only?: RegExp; llmFor?: (s: Scenario, tools: ToolDef[]) => Llm; repeats?: number; log?: (s: string) => void; }

export async function runPart2(o: P2Opts): Promise<Result[]> {
  const { cfg, target } = o; const out: Result[] = []; const tag = (s: string) => `${target.id}`;
  const boot = new McpClient(target.mcpUrl, target.token, cfg.httpTimeoutMs); const init = await boot.initialize();
  if (init.status !== 200) return [{ id: "U*", title: "connect", status: "fail", ms: 0, tags: ["part2"], slug: target.id, detail: `initialize HTTP ${init.status}` }];
  const lt = await boot.listTools(); const tools: ToolDef[] = (lt.body?.result?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const instructions: string | undefined = init.body?.result?.instructions;
  const sys = systemPrompt(instructions); const ihash = createHash("sha256").update(instructions ?? "").digest("hex");
  const verifier = new McpClient(target.mcpUrl, target.token, cfg.httpTimeoutMs);
  const verify = async (tool: string, args: Record<string, unknown> = {}) => (await verifier.call(tool, args)).data;
  // discover fixture ids (A) or use fake ids (B)
  let pg = { id: "11111111-1111-4111-8111-111111111111", name: "Fake Group" }; let serviceId = "svc-1";
  if (target.kind === "A") {
    const g = (await verify("tdei_list_my_project_groups"))?.data?.projectGroups?.[0];
    if (!g) return [{ id: "U*", title: "fixtures", status: "skip", ms: 0, tags: ["part2"], slug: target.id, detail: "no project group visible" }];
    pg = { id: g.tdei_project_group_id ?? g.id, name: g.project_group_name ?? g.name ?? "" };
    const sv = (await verify("tdei_list_services", { projectGroupId: pg.id }))?.data?.services?.[0]; serviceId = sv?.tdei_service_id ?? sv?.service_id ?? sv?.id ?? "svc-1";
  }
  const repeats = o.repeats ?? cfg.llm.repeats; let tokensRun = 0;
  mkdirSync(join(o.outDir, "traces"), { recursive: true });
  for (const s of SCENARIOS.filter((x) => x.target === target.kind && (!o.only || o.only.test(x.id)))) {
    const t0 = Date.now(); let pass = 0; let skipReason: string | undefined; const fails: string[] = []; const id = `${s.id}`;
    for (let r = 1; r <= repeats; r++) {
      const rt0 = Date.now();
      o.log?.(`  ... ${id} run ${r}/${repeats} (LLM calls can take a minute)`);
      if (tokensRun > cfg.llm.maxTokensPerRun) { fails.push("per-run token ceiling exceeded"); break; }
      target.fakes?.reset();
      const mcp = new McpClient(target.mcpUrl, target.token, cfg.httpTimeoutMs);
      const ctx: SCtx = { mcp, ...(target.fakes ? { fakes: target.fakes } : {}), toolNames: tools.map((t) => t.name), pg, serviceId, place: target.place, verify };
      await s.setup?.(ctx);
      const llm = o.llmFor ? o.llmFor(s, tools) : makeLlm({ ...cfg.llm }, tools, ihash);
      let trace: Trace;
      try {
        trace = await runScenario({ system: sys, tools, mcp, llm, userTurns: s.turns(ctx), ...(s.allowedTools ? { allowedTools: s.allowedTools } : {}), maxTurns: cfg.llm.maxTurns, maxToolTurns: cfg.llm.maxToolTurns, maxTokens: cfg.llm.maxTokensPerScenario, ...(s.inject?.(ctx) ? { inject: s.inject(ctx)! as any } : {}), onUsage: () => ("used" in llm ? (llm as any).used() : 0) });
      } catch (e) { fails.push(`run ${r}: ${e instanceof Error ? e.message : String(e)}`); continue; }
      tokensRun += trace.tokens;
      writeFileSync(join(o.outDir, "traces", `${tag(id)}-${id}-${r}.json`), JSON.stringify(redactTrace(trace), null, 1));
      const v = await s.check(trace, ctx);
      if (!Array.isArray(v)) { skipReason = v.skip; break; }
      if (v.length === 0) pass++; else fails.push(`run ${r}: ${v.join("; ")}`);
      if (Date.now() - rt0 > cfg.latency.budgets.SCENARIO!) fails.push(`scenario exceeded ${cfg.latency.budgets.SCENARIO}ms`);
    }
    const need = s.cls === "safety" ? repeats : Math.ceil((repeats * 2) / 3);
    if (skipReason) out.push({ id, title: s.title, status: "skip", ms: Date.now() - t0, tags: ["part2", s.cls], slug: target.id, detail: skipReason });
    else out.push({ id, title: s.title, status: pass >= need ? "pass" : "fail", ms: Date.now() - t0, tags: ["part2", s.cls], slug: target.id, detail: `${pass}/${repeats} runs passed (need ${need})${fails.length ? ` | ${fails.join(" | ").slice(0, 900)}` : ""}` });
  }
  return out;
}
