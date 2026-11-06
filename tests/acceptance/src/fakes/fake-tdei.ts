// Fake TDEI API + stub geocoder over HTTPS with a throwaway test CA. Only used for Target B (fault injection).
import { createServer, type Server } from "node:https";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

export interface Script { status?: number; delayMs?: number; body?: unknown; raw?: string; hang?: boolean; }
export interface LogEntry { t: number; path: string; query: string; auth: string; }
export interface Fakes {
  apiUrl: string; specUrl: string; geocoderUrl: string; caPath: string; dir: string;
  log: LogEntry[]; calls(pathPrefix: string): LogEntry[];
  script(pathPrefix: string, s: Script | ((e: LogEntry) => Script | undefined)): void;
  geocode(candidates: Array<{ name: string; bbox: [number, number, number, number] }>): void;
  reset(): void; close(): Promise<void>;
}

export function makeCa(): { dir: string; caPath: string; keyPath: string; certPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "tdei-fake-ca-"));
  const run = (args: string[]) => { const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`); };
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=tdei-acceptance-test-ca"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf"]);
  return { dir, caPath: join(dir, "ca.pem"), keyPath: join(dir, "srv.key"), certPath: join(dir, "srv.pem") };
}

const dataset = (i: number, extra: Record<string, unknown> = {}) => ({ tdei_dataset_id: `00000000-0000-4000-8000-00000000000${i}`, name: `Seattle sample ${i}`, data_type: "osw", status: "Pre-Release", uploaded_timestamp: `2024-0${i}-01T00:00:00Z`, ...extra });

export async function startFakes(): Promise<Fakes> {
  const ca = makeCa(); const tls = { key: readFileSync(ca.keyPath), cert: readFileSync(ca.certPath) };
  const log: LogEntry[] = []; const scripts: Array<{ prefix: string; s: Script | ((e: LogEntry) => Script | undefined) }> = [];
  let geo: Array<{ name: string; bbox: [number, number, number, number] }> = [];
  const send = (res: import("node:http").ServerResponse, status: number, body: unknown, raw?: string) => { const t = raw ?? JSON.stringify(body); res.writeHead(status, { "Content-Type": raw !== undefined ? "text/plain" : "application/json" }); res.end(t); };
  const api = createServer(tls, async (req, res) => {
    const u = new URL(req.url ?? "/", "https://localhost");
    const entry: LogEntry = { t: Date.now(), path: u.pathname, query: u.search, auth: String(req.headers.authorization ?? "") };
    if (u.pathname !== "/openapi.json") log.push(entry);
    if (u.pathname !== "/openapi.json" && !/^Bearer [\w-]+\.[\w-]+\.[\w-]*$/.test(entry.auth)) return send(res, 401, { message: "fake: bad token" });
    const hit = [...scripts].reverse().find((x) => u.pathname.startsWith(x.prefix));
    const s = hit ? (typeof hit.s === "function" ? hit.s(entry) : hit.s) : undefined;
    if (s) {
      if (s.hang) return; // never answers: exercises the server's own timeout
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      send(res, s.status ?? 200, s.body ?? [], s.raw); return;
    }
    if (u.pathname === "/openapi.json") return send(res, 200, { openapi: "3.0.3", info: { title: "fake-tdei", version: "1.0.0" }, paths: {} });
    if (u.pathname === "/api/v1/project-groups") return send(res, 200, [{ tdei_project_group_id: "11111111-1111-4111-8111-111111111111", project_group_name: "Fake Group", is_active: true }]);
    if (u.pathname === "/api/v1/datasets") {
      const name = u.searchParams.get("name"), city = u.searchParams.get("city"), id = u.searchParams.get("tdei_dataset_id");
      if (id) return send(res, 200, [dataset(1, { tdei_dataset_id: id })]);
      if (name === "Seattle" || city === "Seattle" || u.searchParams.getAll("bbox").length === 4) return send(res, 200, [dataset(2), dataset(1)]);
      return send(res, 200, []);
    }
    if (u.pathname === "/api/v1/jobs") return send(res, 200, []);
    if (u.pathname === "/api/v1/services") return send(res, 200, []);
    send(res, 404, { message: "fake: no route" });
  });
  const geoSrv = createServer(tls, (req, res) => {
    log.push({ t: Date.now(), path: "/geocoder" + new URL(req.url ?? "/", "https://x").pathname, query: new URL(req.url ?? "/", "https://x").search, auth: "" });
    send(res, 200, geo.map((g, i) => ({ place_id: i + 1, display_name: g.name, importance: 0.5, boundingbox: [String(g.bbox[1]), String(g.bbox[3]), String(g.bbox[0]), String(g.bbox[2])] })));
  });
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
  const [ap, gp] = [await listen(api), await listen(geoSrv)];
  return {
    apiUrl: `https://localhost:${ap}`, specUrl: `https://localhost:${ap}/openapi.json`, geocoderUrl: `https://localhost:${gp}/search`, caPath: ca.caPath, dir: ca.dir, log,
    calls: (p) => log.filter((e) => e.path.startsWith(p)),
    script: (prefix, s) => { scripts.push({ prefix, s }); },
    geocode: (c) => { geo = c; },
    reset: () => { log.length = 0; scripts.length = 0; geo = []; },
    close: async () => { await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => geoSrv.close(r))]); },
  };
}
export const fakeJwt = (claims: Record<string, unknown> = {}) => {
  const p = { exp: Math.floor(Date.now() / 1000) + 3600, preferred_username: "fake.user", email: "fake.user@example.test", realm_access: { roles: ["poc"] }, ...claims };
  return `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(p)).toString("base64url")}.sig`;
};
