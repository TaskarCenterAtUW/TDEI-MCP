import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { AuthManager, EXIT_REAUTH } from "./auth/manager.ts";
import { ReauthRequired } from "./auth/oauth.ts";
import { McpClient } from "./mcp.ts";
import { runSuite } from "./suite.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const [cmd, sub] = argv;

async function main(): Promise<number> {
  if (cmd === "selftest") { const { selftest } = await import("./selftest.ts"); return selftest(); }
  const cfg = loadConfig();
  const auth = new AuthManager(cfg);
  const labels = [...new Set(cfg.slugs.map((s) => s.label))].filter((l) => !flag("env") || l === flag("env"));
  if (cmd === "auth") {
    if (sub === "status") { for (const l of labels) console.log(`${l}: ${auth.status(l)}`); return 0; }
    if (sub === "logout") { for (const l of labels) console.log(`${l}: ${auth.logout(l) ? "token removed" : "no token"}`); return 0; }
    if (sub === "login") {
      for (const l of labels) { const sc = cfg.slugs.find((s) => s.label === l)!; process.env.ACCEPT_ALLOW_NON_TTY_LOGIN = "1"; await auth.token(sc, true); console.log(`${l}: logged in (${auth.status(l)})`); }
      return 0;
    }
  }
  if (cmd === "acceptance") {
    // Step 1: login. Nothing else runs until every needed environment has a token the gateway accepts.
    const slugFilter = flag("slug"); const targets = cfg.slugs.filter((s) => !slugFilter || s.slug === slugFilter);
    for (const sc of targets) {
      try { const r = await fetch(`${sc.base}/${sc.slug}/health`, { signal: AbortSignal.timeout(10000) }); if (r.status !== 200) throw new Error(`HTTP ${r.status}`); }
      catch (e) { const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e); console.error(`Gateway not reachable at ${sc.base}/${sc.slug}/health (${why}).\nCheck ACCEPT_GATEWAY_BASE_URL in .acceptance/.env (for local docker start it with pnpm deploy:docker) and that the slug "${sc.slug}" is in mcps.json.`); return 2; }
    }
    console.log("Step 1/2: TDEI login");
    process.env.ACCEPT_ALLOW_NON_TTY_LOGIN = "1";
    for (const sc of targets.filter((s, i, a) => a.findIndex((x) => x.label === s.label) === i)) {
      let token = await auth.token(sc);
      if (!(await auth.accepted(sc, token))) { console.log(`  ${sc.label}: stored token rejected by ${sc.slug}; signing in again`); token = await auth.token(sc, true); }
      if (!(await auth.accepted(sc, token))) { console.error(`Login failed for "${sc.label}": the gateway still rejects the token. Not running tests.`); return EXIT_REAUTH; }
      console.log(`  ${sc.label}: logged in (${auth.status(sc.label)})`);
    }
    console.log("\nStep 2/2: acceptance tests");
    const part = (flag("part") ?? "all") as "1" | "2" | "all"; const only = flag("only");
    const { exit } = await runSuite(cfg, { part, slug: slugFilter, ...(argv.includes("--with-b") ? { withB: true } : argv.includes("--no-b") ? { withB: false } : {}), ...(only ? { only: new RegExp(only) } : {}) });
    return exit;
  }
  if (cmd === "run") {
    const part = (flag("part") ?? "all") as "1" | "2" | "all"; if (!["1", "2", "all"].includes(part)) throw new Error("--part must be 1, 2 or all");
    const only = flag("only");
    const { exit } = await runSuite(cfg, { part, slug: flag("slug"), ...(argv.includes("--with-b") ? { withB: true } : argv.includes("--no-b") ? { withB: false } : {}), ...(only ? { only: new RegExp(only) } : {}) });
    return exit;
  }
  if (cmd === "snapshot") {
    for (const sc of cfg.slugs.filter((s) => !flag("slug") || s.slug === flag("slug"))) {
      const token = await auth.token(sc); const c = new McpClient(sc.mcpUrl, token, cfg.httpTimeoutMs);
      const init = await c.initialize(); if (init.status !== 200) throw new Error(`${sc.slug}: initialize HTTP ${init.status}`);
      const l = await c.listTools(); const tools = (l.body?.result?.tools ?? []).map((t: any) => ({ name: t.name, inputSchema: t.inputSchema })).sort((a: any, b: any) => a.name.localeCompare(b.name));
      mkdirSync(dirname(sc.expectedToolsFile), { recursive: true }); writeFileSync(sc.expectedToolsFile, JSON.stringify({ slug: sc.slug, capturedAt: new Date().toISOString(), tools }, null, 1));
      console.log(`${sc.slug}: wrote ${tools.length} tools to ${sc.expectedToolsFile}`);
    }
    return 0;
  }
  console.error("usage: acceptance [--part 1|2|all] [--slug s] | auth login|status|logout [--env label] | run [--part 1|2|all] [--slug s] [--only regex] [--with-b|--no-b] | snapshot [--slug s] | selftest");
  return 2;
}
main().then((c) => process.exit(c), (e) => { if (e instanceof ReauthRequired) { console.error(`Login required: ${e.message}`); process.exit(EXIT_REAUTH); } console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(2); });
