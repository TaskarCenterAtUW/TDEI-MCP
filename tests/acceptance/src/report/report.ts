import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../redact.ts";
import { junit, type Result } from "../runner/runner.ts";

export function runDir(base: string): string { const d = join(base, new Date().toISOString().replace(/[:.]/g, "-")); mkdirSync(d, { recursive: true }); return d; }
export function writeSlugReport(dir: string, slug: string, results: Result[], lat?: Record<string, number[]>): string {
  const d = join(dir, slug); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "results.json"), redact(JSON.stringify({ slug, results, latency: lat }, null, 1)));
  writeFileSync(join(d, "junit.xml"), redact(junit(results, slug)));
  return d;
}
export function summarize(all: Record<string, Result[]>): { text: string; failed: number } {
  const lines = ["# TDEI-MCP acceptance summary", "", "| Target | Pass | Fail | Known gaps | Skip |", "|---|---|---|---|---|"]; let failed = 0;
  for (const [slug, rs] of Object.entries(all)) { const f = rs.filter((r) => r.status === "fail").length; failed += f; lines.push(`| ${slug} | ${rs.filter((r) => r.status === "pass").length} | ${f} | ${rs.filter((r) => r.status === "known").length} | ${rs.filter((r) => r.status === "skip").length} |`); }
  for (const [slug, rs] of Object.entries(all)) {
    const bad = rs.filter((r) => r.status === "fail"); const skipped = rs.filter((r) => r.status === "skip");
    if (bad.length) { lines.push("", `## ${slug}: failures`); for (const r of bad) lines.push(`- **${r.id}** ${r.title}: ${r.detail ?? ""}`); }
    const known = rs.filter((r) => r.status === "known"); if (known.length) { lines.push("", `## ${slug}: known gaps (not counted as failures)`); for (const r of known) lines.push(`- **${r.id}** ${r.title}: ${r.detail ?? ""}`); }
    if (skipped.length) { lines.push("", `## ${slug}: skipped`); for (const r of skipped) lines.push(`- ${r.id} ${r.title}: ${r.detail ?? ""}`); }
  }
  return { text: redact(lines.join("\n")) + "\n", failed };
}
