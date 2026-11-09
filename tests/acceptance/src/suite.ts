import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { llmReady, type Config, type SlugConfig } from "./config.ts";
import { AuthManager } from "./auth/manager.ts";
import { ReauthRequired } from "./auth/oauth.ts";
import { runTests, type Result } from "./runner/runner.ts";
import { makeEnv, p95, type Env } from "./part1/env.ts";
import { authenticatedTests } from "./part1/tests.ts";
import { faultTests } from "./part1/faulttests.ts";
import { runPart2 } from "./part2/run.ts";
import { runDir, summarize, writeSlugReport } from "./report/report.ts";
import { startFakes, fakeJwt } from "./fakes/fake-tdei.ts";
import { startTargetB } from "./fakes/targetb.ts";
import { registerSecret } from "./redact.ts";

export interface SuiteOpts { part: "1" | "2" | "all"; slug?: string | undefined; withB?: boolean; only?: RegExp | undefined; log?: (s: string) => void; }
const line = (r: Result) => `  ${r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : r.status === "known" ? "KNWN" : "skip"} ${r.id.padEnd(5)} ${r.title}${r.detail && r.status !== "pass" ? `\n        ${r.detail.slice(0, 400)}` : ""}`;

export async function runSuite(cfg: Config, o: SuiteOpts): Promise<{ exit: number; dir: string }> {
  const say = o.log ?? ((s: string) => console.log(s)); const auth = new AuthManager(cfg, (m) => say(m));
  const slugs = cfg.slugs.filter((s) => !o.slug || s.slug === o.slug); if (!slugs.length) throw new Error(`no configured slug matches --slug ${o.slug}`);
  const dir = runDir(cfg.reportDir); const all: Record<string, Result[]> = {}; let needReauth = false;
  // Logins up front, once per environment label.
  const tokens = new Map<string, string>(); const problems = new Map<string, string>();
  for (const s of cfg.slugs) {
    if (tokens.has(s.label) || problems.has(s.label)) continue;
    if (!slugs.some((x) => x.label === s.label) && !slugs.length) continue;
    try { tokens.set(s.label, await auth.token(s)); } catch (e) { if (e instanceof ReauthRequired) { needReauth = true; problems.set(s.label, e.message); } else problems.set(s.label, String(e)); }
  }
  for (const sc of slugs) {
    say(`\n=== ${sc.slug} (${sc.label}) ${sc.mcpUrl}`);
    let token = tokens.get(sc.label);
    const run1 = async () => {
      const env = makeEnv(cfg, sc, auth, token, problems.get(sc.label), tokens);
      const rs: Result[] = []; const lat: Record<string, number[]> = {};
      if (o.part === "1" || o.part === "all") {
        let res = await runTests(sc.slug, authenticatedTests(env), { ...(o.only ? { only: o.only } : {}), log: (r) => say(line(r)) });
        // One reactive refresh+retry if the gateway rejected our token mid-run (spec 8.3).
        if (token && res.some((r) => r.status === "fail" && /HTTP 401|TDEI_TOKEN_(EXPIRED|INVALID)/.test(r.detail ?? "")) && !(await auth.accepted(sc, token))) {
          say("  token rejected mid-run; refreshing once and re-running");
          try { token = await auth.token(sc, true); tokens.set(sc.label, token); const e2 = makeEnv(cfg, sc, auth, token, undefined, tokens); res = await runTests(sc.slug, authenticatedTests(e2), { ...(o.only ? { only: o.only } : {}), log: (r) => say(line(r)) }); }
          catch (e) { if (e instanceof ReauthRequired) needReauth = true; }
        }
        rs.push(...res); for (const [k, v] of env.lat) lat[k] = v;
      }
      return { rs, lat };
    };
    const { rs, lat } = await run1();
    if ((o.part === "2" || o.part === "all")) {
      if (!sc.part2) rs.push({ id: "P2", title: "Part 2", status: "skip", ms: 0, tags: ["part2"], slug: sc.slug, detail: "slug excluded from Part 2 (ACCEPT_PART2_SLUGS / production default)" });
      else if (!token) rs.push({ id: "P2", title: "Part 2", status: "skip", ms: 0, tags: ["part2"], slug: sc.slug, detail: `no token: ${problems.get(sc.label) ?? "not logged in"}` });
      else if (!llmReady(cfg.llm)) rs.push({ id: "P2", title: "Part 2", status: "skip", ms: 0, tags: ["part2"], slug: sc.slug, detail: `no API key for provider ${cfg.llm.provider} (for an OpenAI-compatible server set ACCEPT_LLM_BASE_URL)` });
      else { const p2 = await runPart2({ cfg, target: { id: sc.slug, kind: "A", mcpUrl: sc.mcpUrl, token, place: sc.place }, outDir: join(dir, sc.slug), log: say, ...(o.only ? { only: o.only } : {}) }); for (const r of p2) say(line(r)); rs.push(...p2); }
    }
    all[sc.slug] = rs; writeSlugReport(dir, sc.slug, rs, lat);
    for (const [k, v] of Object.entries(lat)) say(`  latency ${k}: n=${v.length} p95=${p95(v)}ms`);
  }
  if (o.withB ?? cfg.b.enabled) {
    say(`\n=== target B (isolated build + fake TDEI API)`);
    const fakes = await startFakes(); let b: Awaited<ReturnType<typeof startTargetB>> | undefined;
    try {
      b = await startTargetB(fakes, { port: cfg.b.port, image: cfg.b.image });
      const sc: SlugConfig = { slug: b.slug, label: "fake", base: b.base, mcpUrl: b.mcpUrl, part2: true, place: "Seattle", fixtureDatasetId: undefined, foreignProjectGroupId: undefined, expectedToolsFile: "" };
      const tok = fakeJwt(); registerSecret(tok);
      const env = makeEnv(cfg, sc, auth, tok, undefined, new Map(), `${b.base}/health`);
      const rs: Result[] = [];
      if (o.part === "1" || o.part === "all") rs.push(...(await runTests("B", faultTests(env, fakes), { ...(o.only ? { only: o.only } : {}), log: (r) => say(line(r)) })));
      if ((o.part === "2" || o.part === "all") && llmReady(cfg.llm)) {
        const p2 = await runPart2({ cfg, target: { id: "B", kind: "B", mcpUrl: b.mcpUrl, token: tok, place: "Seattle", fakes }, outDir: join(dir, "B"), ...(o.only ? { only: o.only } : {}) }); for (const r of p2) say(line(r)); rs.push(...p2);
      }
      all["B"] = rs; writeSlugReport(dir, "B", rs);
    } finally { await b?.stop(); await fakes.close(); }
  }
  const sum = summarize(all); writeFileSync(join(dir, "summary.md"), sum.text); say(`\n${sum.text}Report: ${dir}`);
  return { exit: sum.failed > 0 ? 1 : needReauth ? 3 : 0, dir };
}
