// Target B: the image/build under test, isolated, pointed at the fake TDEI API. Node mode (dist) or docker mode.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "../config.ts";
import type { Fakes } from "./fake-tdei.ts";

export interface TargetB { slug: string; mcpUrl: string; base: string; log: string[]; stop(): Promise<void>; }
/** The server repo under test: the folder containing this suite (override with ACCEPT_REPO_DIR). */
const REPO = resolve(process.env.ACCEPT_REPO_DIR ?? resolve(ROOT, "..", ".."));

async function waitHealthy(url: string, ms: number, log: string[]): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status === 200) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`target B did not become healthy at ${url}. Last output:\n${log.slice(-15).join("\n")}`);
}

export async function startTargetB(fakes: Fakes, o: { port: number; image?: string | undefined }): Promise<TargetB> {
  const slug = "tdei-fake"; const log: string[] = [];
  const mcps = { host: "127.0.0.1", basePort: o.port, servers: [{ name: slug, apiUrl: fakes.apiUrl + "/", specUrl: fakes.specUrl }] };
  const dir = join(fakes.dir, "b"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "mcps.json"); writeFileSync(file, JSON.stringify(mcps));
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: fakes.caPath, TDEI_GEOCODER_URL: fakes.geocoderUrl, TDEI_GEOCODER_USER_AGENT: "tdei-acceptance/1.0" };
  let proc: ChildProcess; let stop: () => Promise<void>;
  if (o.image) {
    const name = `tdei-acceptance-b-${process.pid}`;
    const r = spawnSync("docker", ["run", "-d", "--rm", "--name", name, "--network", "host", "-e", "NODE_EXTRA_CA_CERTS=/ca/ca.pem", "-e", `TDEI_GEOCODER_URL=${fakes.geocoderUrl}`, "-v", `${fakes.dir}:/ca:ro`, "-v", `${file}:/app/mcps.acceptance.json:ro`, o.image, "node", "dist/multi-serve.js", "--file", "/app/mcps.acceptance.json"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
    stop = async () => { spawnSync("docker", ["rm", "-f", name]); };
    proc = { kill() {} } as unknown as ChildProcess;
  } else {
    proc = spawn(process.execPath, [join(REPO, "dist", "multi-serve.js"), "--file", file], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    for (const s of [proc.stdout, proc.stderr]) s?.on("data", (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.trim()) log.push(l); });
    stop = async () => { proc.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 500)); if (!proc.killed) proc.kill("SIGKILL"); };
  }
  const base = `http://127.0.0.1:${o.port}`;
  await waitHealthy(`${base}/health`, 60000, log).catch(async (e) => { await stop(); throw e; });
  return { slug, base, mcpUrl: `${base}/${slug}/mcp`, log, stop };
}
