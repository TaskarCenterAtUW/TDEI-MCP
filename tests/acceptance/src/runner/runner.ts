// Tiny test runner: tags, skip reasons, per-slug contexts, timings, JUnit + JSON + summary.
export type Status = "pass" | "fail" | "skip" | "known";
export interface Result { id: string; title: string; status: Status; ms: number; detail?: string; tags: string[]; slug: string; }
export interface Ctx { slug: string; skip(reason: string): never; info(msg: string): void; }
export class Skip extends Error {}
export interface TestDef { id: string; title: string; tags?: string[]; /** Acknowledged server gap: a failure is reported as "known", not as a regression. */ known?: string; fn: (ctx: Ctx) => Promise<void> | void; }

export class Assert extends Error {}
export function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Assert(msg); }
export function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Assert(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function runTests(slug: string, tests: TestDef[], opts: { only?: RegExp; log?: (r: Result) => void } = {}): Promise<Result[]> {
  const out: Result[] = [];
  for (const t of tests) {
    if (opts.only && !opts.only.test(t.id)) continue;
    const notes: string[] = [];
    const ctx: Ctx = { slug, skip: (r) => { throw new Skip(r); }, info: (m) => notes.push(m) };
    const t0 = Date.now();
    let status: Status = "pass"; let detail: string | undefined;
    try { await t.fn(ctx); }
    catch (e) {
      if (e instanceof Skip) { status = "skip"; detail = e.message; }
      else { status = "fail"; detail = e instanceof Error ? e.message : String(e); }
    }
    if (t.known && status === "fail") { status = "known"; detail = `KNOWN GAP (${t.known}): ${detail}`; }
    else if (t.known && status === "pass") detail = `known-gap marker is stale: this now passes (${t.known}); remove the marker`;
    if (notes.length) detail = [detail, ...notes].filter(Boolean).join(" | ");
    const r: Result = { id: t.id, title: t.title, status, ms: Date.now() - t0, tags: t.tags ?? [], slug, ...(detail ? { detail } : {}) };
    out.push(r); opts.log?.(r);
  }
  return out;
}

export function junit(results: Result[], suite: string): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
  const fails = results.filter((r) => r.status === "fail").length, skips = results.filter((r) => r.status === "skip").length;
  const cases = results.map((r) => `  <testcase classname="${esc(suite)}" name="${esc(`${r.id} ${r.title}`)}" time="${(r.ms / 1000).toFixed(3)}">` +
    (r.status === "fail" ? `<failure message="${esc(r.detail ?? "")}"/>` : (r.status === "skip" || r.status === "known") ? `<skipped message="${esc(r.detail ?? "")}"/>` : "") + `</testcase>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(suite)}" tests="${results.length}" failures="${fails}" skipped="${skips}">\n${cases}\n</testsuite>\n`;
}
