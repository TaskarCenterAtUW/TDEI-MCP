// Self-test: runs the suite against the locally built server (dist/) + fake TDEI API, with a mock LLM for Part 2.
// Proves the harness works and that its checks can fail (negative controls). Needs no credentials.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { AuthManager } from "./auth/manager.ts";
import { startFakes, fakeJwt } from "./fakes/fake-tdei.ts";
import { startTargetB } from "./fakes/targetb.ts";
import { runTests, type Result } from "./runner/runner.ts";
import { makeEnv } from "./part1/env.ts";
import { authenticatedTests } from "./part1/tests.ts";
import { faultTests } from "./part1/faulttests.ts";
import { runPart2 } from "./part2/run.ts";
import { mockLlm, type Msg } from "./part2/llm.ts";
import { registerSecret } from "./redact.ts";

const lastUser = (m: Msg[]) => [...m].reverse().find((x) => x.role === "user") as { text: string } | undefined;
const sawTool = (m: Msg[]) => m[m.length - 1]?.role === "tool";
const good = (m: Msg[]) => {
  const u = lastUser(m)?.text ?? ""; const done = sawTool(m);
  if (/upload history/i.test(u)) return done ? { text: "tdei_list_jobs returned no jobs, so there is no upload history yet." } : { calls: [{ name: "tdei_list_jobs", args: { allGroups: true, limit: 5 } }] };
  if (/delete/i.test(u)) return { text: "I can't delete datasets: there is no delete tool available." };
  if (/logged in as/i.test(u)) return done ? { text: `You are logged in as fake.user (fake.user@example.test).` } : { calls: [{ name: "tdei_get_my_identity", args: {} }] };
  if (/latest dataset for Seattle/i.test(u) && !/When was/.test(u)) return done ? { text: "The latest dataset is Seattle sample 2." } : { calls: [{ name: "tdei_find_datasets", args: { place: "Seattle", latest: true } }] };
  return { text: "ok" };
};
const evil = (m: Msg[]) => (/delete/i.test(lastUser(m)?.text ?? "") && !sawTool(m) ? { calls: [{ name: "tdei_upload_dataset", args: { dataType: "osw", asset: { kind: "local_path", path: "/etc/passwd" } } }] } : { text: "Deleted the dataset successfully." });

export async function selftest(): Promise<number> {
  const cfg = loadConfig({ baseUrl: "http://127.0.0.1", ACCEPT_SLUGS: "tdei-fake:fake", tokenDir: mkdtempSync(join(tmpdir(), "tdei-st-")), ACCEPT_B_PORT: "3391", ACCEPT_LATENCY_SAMPLES: "5", ACCEPT_LLM_REPEATS: "1" });
  const fakes = await startFakes(); const results: Result[] = []; let failed = 0;
  const show = (rs: Result[]) => { for (const r of rs) { console.log(`  ${r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : r.status === "known" ? "KNWN" : "skip"} ${r.id.padEnd(5)} ${r.title}${r.status !== "pass" && r.detail ? `\n        ${r.detail.slice(0, 500)}` : ""}`); } results.push(...rs); };
  let b: Awaited<ReturnType<typeof startTargetB>> | undefined;
  try {
    b = await startTargetB(fakes, { port: cfg.b.port });
    const sc = { ...cfg.slugs[0]!, slug: b.slug, base: b.base, mcpUrl: b.mcpUrl };
    const tok = fakeJwt(); registerSecret(tok); const auth = new AuthManager(cfg);
    const env = makeEnv(cfg, sc, auth, tok, undefined, new Map(), `${b.base}/health`);
    console.log("-- Part 1 (authenticated suite pointed at the local build)"); fakes.reset(); show(await runTests("B", authenticatedTests(env)));
    console.log("-- Part 1 (fault injection)"); show(await runTests("B", faultTests(env, fakes)));
    console.log("-- Part 2 (mock LLM)");
    const run = (llmFn: (m: Msg[]) => any, only: RegExp, kind: "A" | "B" = "A") => runPart2({ cfg, target: { id: "B", kind, mcpUrl: b!.mcpUrl, token: tok, place: "Seattle", fakes }, outDir: join(tmpdir(), "tdei-st-out"), only, repeats: 1, llmFor: () => mockLlm(llmFn) });
    // A-kind scenarios run against the fake API here; they need only fake data.
    const p2 = await run(good, /^U(1|3|10|15)$/); show(p2);
    console.log("-- Negative control: a misbehaving model must FAIL U10");
    const neg = await run(evil, /^U10$/); const caught = neg[0]?.status === "fail";
    console.log(`  ${caught ? "PASS" : "FAIL"} NEG   misbehaving model was ${caught ? "caught" : "NOT caught"} by U10${neg[0]?.detail ? `\n        ${neg[0].detail.slice(0, 300)}` : ""}`); if (!caught) failed++;
  } finally { await b?.stop(); await fakes.close(); }
  failed += results.filter((r) => r.status === "fail").length;
  console.log(`\nselftest: ${results.filter((r) => r.status === "pass").length} passed, ${failed} failed, ${results.filter((r) => r.status === "skip").length} skipped`);
  return failed ? 1 : 0;
}
