import { readFileSync, existsSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { http } from "../http.ts";
import { McpClient, errorCode } from "../mcp.ts";
import { check, eq, type TestDef } from "../runner/runner.ts";
import { scanForSecrets } from "../redact.ts";
import { call, expectStatus, needToken, p95, rec, type Env } from "./env.ts";

const jwtOf = (payload: object) => `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
const REQUIRED_META = ["name", "version", "collected_by", "collection_date", "data_source", "schema_version"];
const goodMeta = () => ({ dataset_detail: { name: "acceptance-probe", version: "1.0", collected_by: "tdei-acceptance", collection_date: "2024-01-01T00:00:00.000Z", data_source: "InHouse", schema_version: "v0.2" } });
const base = (env: Env) => `${env.sc.base}/${env.sc.slug}`;
const mcpBase = (env: Env) => env.sc.mcpUrl;

async function tools(env: Env) {
  if (!env.state.tools) {
    const c = env.client(); const init = await c.initialize();
    check(init.status === 200, `initialize failed: HTTP ${init.status} ${init.raw.slice(0, 150)}`);
    env.state.instructions = init.body?.result?.instructions;
    const l = await c.listTools();
    check(l.status === 200 && Array.isArray(l.body?.result?.tools), `tools/list failed: HTTP ${l.status}`);
    env.state.tools = l.body.result.tools; env.state.toolNames = env.state.tools!.map((t: any) => t.name);
  }
  return env.state.tools!;
}

/** Minimal JSON-Schema shape check (no deps): enough to catch malformed schemas, not full validation. */
function schemaProblems(s: any, path = "inputSchema"): string[] {
  const p: string[] = [];
  if (typeof s !== "object" || s === null) return [`${path} not an object`];
  if (s.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(Array.isArray(s.type) ? s.type[0] : s.type)) p.push(`${path}.type invalid`);
  if (s.properties) for (const [k, v] of Object.entries(s.properties)) p.push(...schemaProblems(v, `${path}.${k}`));
  if (s.required && (!Array.isArray(s.required) || s.required.some((r: unknown) => typeof r !== "string"))) p.push(`${path}.required malformed`);
  if (s.required && s.properties) for (const r of s.required) if (!(r in s.properties)) p.push(`${path}.required names unknown "${r}"`);
  return p;
}

export function authenticatedTests(env: Env): TestDef[] {
  const A = (id: string, title: string, fn: TestDef["fn"], tags: string[] = []): TestDef => ({ id, title, tags: ["A", ...tags], fn });
  return [
    A("T0", "readiness, health and build", async () => {
      let r = await http(env.healthUrl, { timeoutMs: 30000 });
      const deadline = Date.now() + 3 * 60000;
      while (r.status !== 200 && Date.now() < deadline) { await new Promise((x) => setTimeout(x, 10000)); r = await http(env.healthUrl, { timeoutMs: 30000 }); }
      eq(r.status, 200, `/health HTTP status ${r.text.slice(0, 120)}`);
      rec(env, "HEALTH", r.ms);
      check(typeof r.json === "object" && r.json !== null, "health body is not JSON");
      check(scanForSecrets(r.text).length === 0, "invariant 1: health leaks a secret");
      const sha = (r.json as any).build?.sha;
      if (env.cfg.expectedSha) {
        check(sha, "ACCEPT_EXPECTED_BUILD_SHA is set but /health reports no build.sha");
        check(String(sha).startsWith(env.cfg.expectedSha) || env.cfg.expectedSha.startsWith(String(sha)), `build sha ${sha} != expected ${env.cfg.expectedSha}`);
      }
    }),
    A("T1", "initialize and tools/list match the snapshot", async (ctx) => {
      const needs = needToken(env, ctx); void needs;
      const ts = await tools(env);
      rec(env, "INITIALIZE", 0);
      check(typeof env.state.instructions === "string" && env.state.instructions.length > 0, "initialize returned no instructions");
      for (const t of ts) {
        check(typeof t.description === "string" && t.description.trim().length > 0, `${t.name}: empty description`);
        const bad = schemaProblems(t.inputSchema); check(bad.length === 0, `${t.name}: ${bad.join("; ")}`);
      }
      const names = env.state.toolNames!;
      const expected9 = ["tdei_find_datasets", "tdei_list_my_project_groups", "tdei_list_services", "tdei_validate_dataset", "tdei_upload_dataset", "tdei_get_my_identity", "tdei_list_jobs", "tdei_get_dataset_details"];
      if (!env.cfg.strictToolset) { for (const n of expected9) check(names.includes(n), `missing tool ${n}`); return; }
      const f = env.sc.expectedToolsFile;
      if (!existsSync(f)) ctx.skip(`no snapshot at ${f} (run: acceptance snapshot --slug ${env.sc.slug}); semantic set checked instead`);
      const snap = JSON.parse(readFileSync(f, "utf8")) as { tools: Array<{ name: string; inputSchema: unknown }> };
      const want = snap.tools.map((t) => t.name).sort(), got = [...names].sort();
      check(JSON.stringify(want) === JSON.stringify(got), `tool set differs. missing=${want.filter((n) => !got.includes(n))} unexpected=${got.filter((n) => !want.includes(n))}`);
      for (const t of snap.tools) { const live = ts.find((x: any) => x.name === t.name); check(JSON.stringify(live.inputSchema) === JSON.stringify(t.inputSchema), `${t.name}: input schema changed since snapshot`); }
    }),
    A("T1b", "tool names mentioned in descriptions, instructions and 401 bodies exist", async (ctx) => {
      needToken(env, ctx);
      const ts = await tools(env); const names = new Set(env.state.toolNames);
      const mentioned = new Map<string, string>();
      const bootstrap = new Set(["tdei_sso_login", "tdei_sso_complete", "tdei_auth_status", "tdei_test_authentication", "tdei_logout", "tdei_load_api_tools", "tdei_reload_config", "tdei_health"]); // sign-in guidance may name auth-bootstrap tools that only exist on a shared-session server
      const scan = (text: string, where: string) => { for (const m of text.matchAll(/\btdei_(?:sso|resolve|find|list|validate|upload|get|load|test|logout|auth|health|publish|delete|clone|edit|update|reload|download|run)_[a-z0-9_]*\b/g)) if (!names.has(m[0]) && !(where === "instructions" && bootstrap.has(m[0])) && !mentioned.has(m[0])) mentioned.set(m[0], where); };
      for (const t of ts) scan(t.description ?? "", `description of ${t.name}`);
      scan(env.state.instructions ?? "", "instructions");
      const anon = await env.client(null).rpc("tools/call", { name: "tdei_get_my_identity", arguments: {} }); scan(anon.raw, "401 body");
      check(mentioned.size === 0, `references to tools absent from tools/list: ${[...mentioned].map(([n, w]) => `${n} (${w})`).join(", ")}`);
    }),
    A("T0b", "preflight identity and project groups", async (ctx) => {
      needToken(env, ctx);
      const id = expectStatus(await call(env, "tdei_get_my_identity"), "complete", "identity");
      env.state.identity = id.data;
      const pg = expectStatus(await call(env, "tdei_list_my_project_groups"), "complete", "project groups");
      const groups = pg.data.projectGroups; check(Array.isArray(groups) && groups.length > 0, "the logged-in user sees no project groups");
      env.state.projectGroupId = groups[0].tdei_project_group_id ?? groups[0].id ?? groups[0].project_group_id;
    }),
    A("T2", "happy path per read-only tool", async (ctx) => {
      needToken(env, ctx);
      const place = env.sc.place;
      const f = expectStatus(await call(env, "tdei_find_datasets", { place, limit: 5 }, { op: "FIND_DATASETS" }), "complete", "find_datasets");
      check(f.data.matches.length <= 5, "limit not honoured");
      eq(f.data.effectiveSort?.field + " " + f.data.effectiveSort?.order, "uploaded_timestamp desc", "effectiveSort");
      for (const m of f.data.matches) check(m.dataset && m.matchedBy && "evidence" in m, "match lacks dataset/matchedBy/evidence");
      const latest = expectStatus(await call(env, "tdei_find_datasets", { place, latest: true }), "complete", "latest");
      if (latest.data.matches.length) eq(JSON.stringify(latest.data.selected), JSON.stringify(latest.data.matches[0].dataset), "selected == matches[0].dataset");
      const fid = env.sc.fixtureDatasetId ?? f.data.matches[0]?.dataset?.tdei_dataset_id;
      env.state.fixtureDatasetId = fid;
      if (fid) {
        const byId = expectStatus(await call(env, "tdei_find_datasets", { tdeiDatasetId: fid }), "complete", "by id");
        check(byId.data.matches.length === 1 && byId.data.matches[0].matchedBy === "dataset_id", "id lookup should give one dataset_id match");
        const prec = expectStatus(await call(env, "tdei_find_datasets", { tdeiDatasetId: fid, place: "Nowhere" }), "complete", "precedence");
        check(prec.data.matches[0]?.matchedBy === "dataset_id", "tdeiDatasetId must take precedence over place");
        const det = expectStatus(await call(env, "tdei_get_dataset_details", { tdeiDatasetId: fid }), "complete", "details");
        check(det.data && Object.keys(det.data).length > 0, "details empty");
      } else ctx.info("no dataset id available: id lookup, precedence and details not exercised");
      expectStatus(await call(env, "tdei_find_datasets", {}), "needs_input", "empty find").missing.some((m: any) => m.field === "place") || check(false, "needs_input should ask for place");
      const pg = expectStatus(await call(env, "tdei_list_my_project_groups", {}, { op: "READ_TOOL" }), "complete", "pg");
      eq(pg.data.accessScope, "authenticated_user", "accessScope"); check(/not.*(confirm|member)|visible/i.test(pg.data.scopeExplanation ?? ""), "scopeExplanation should say the list is visible groups, not confirmed membership");
      const sv = expectStatus(await call(env, "tdei_list_services", { serviceType: "osw" }, { op: "READ_TOOL" }), "complete", "services");
      eq(sv.data.appliedFilters?.serviceType, "osw", "appliedFilters.serviceType");
      const jb = expectStatus(await call(env, "tdei_list_jobs", { projectGroupId: env.state.projectGroupId, limit: 5 }, { op: "LIST_JOBS" }), "complete", "jobs");
      check((jb.data.jobs ?? jb.data.matches ?? []).length <= 5, "jobs limit not honoured");
    }),
    A("T2b", "list all project groups by paging", async (ctx) => {
      needToken(env, ctx);
      const ids: string[] = []; let pages = 0;
      for (let page = 1; page <= 40; page++) {
        const r = expectStatus(await call(env, "tdei_list_my_project_groups", { page, pageSize: 50 }), "complete", `project groups page ${page}`);
        const rows: any[] = r.data.projectGroups; check(Array.isArray(rows), `page ${page}: projectGroups is not an array`);
        pages++; for (const g of rows) ids.push(String(g.tdei_project_group_id ?? g.id));
        if (rows.length < 50) break;
      }
      check(ids.length > 0, "no project groups returned");
      check(new Set(ids).size === ids.length, `paging returned duplicates (${ids.length} rows, ${new Set(ids).size} unique): pages do not advance`);
      ctx.info(`${ids.length} project groups over ${pages} page(s)`);
      const one = expectStatus(await call(env, "tdei_list_my_project_groups", { pageSize: 3 }), "complete", "pageSize 3");
      check(one.data.projectGroups.length <= 3, "pageSize not honoured");
      const name: string = String(one.data.projectGroups[0]?.project_group_name ?? "").trim();
      if (name) {
        const hit = expectStatus(await call(env, "tdei_list_my_project_groups", { searchText: name }), "complete", "searchText");
        check(hit.data.projectGroups.some((g: any) => g.project_group_name === name), `searchText "${name}" did not return that group`);
      }
    }),
    A("T2c", "find datasets for a place (Seattle)", async (ctx) => {
      needToken(env, ctx);
      const place = env.sc.place;
      const f = expectStatus(await call(env, "tdei_find_datasets", { place, limit: 50 }, { op: "FIND_DATASETS" }), "complete", `find_datasets ${place}`);
      const m: any[] = f.data.matches; check(Array.isArray(m) && m.length > 0, `no datasets found for ${place}`);
      check(m.length <= 50, "limit not honoured");
      const ids = m.map((x) => x.dataset?.tdei_dataset_id); check(ids.every(Boolean) && new Set(ids).size === ids.length, "matches lack a dataset id or contain duplicates");
      check(m.every((x) => x.matchedBy && x.evidence), "every match must say how it matched (matchedBy, evidence)");
      const ts = m.map((x) => Date.parse(x.dataset?.uploaded_timestamp ?? "")).filter((n) => !Number.isNaN(n));
      check(ts.every((t, i) => i === 0 || ts[i - 1]! >= t), "matches are not sorted by uploaded_timestamp desc");
      const named = m.filter((x) => x.matchedBy === "name"); for (const x of named) check(JSON.stringify(x.dataset).toLowerCase().includes(place.toLowerCase()), `matched by name but the dataset does not mention ${place}`);
      const latest = expectStatus(await call(env, "tdei_find_datasets", { place, latest: true, limit: 5 }), "complete", "latest");
      check(latest.data.selected, "latest=true must return a selected dataset");
      ctx.info(`${m.length} datasets for ${place}`);
    }),
    A("T3", "input validation rejects bad arguments cleanly", async (ctx) => {
      needToken(env, ctx);
      const cases: Array<[string, Record<string, unknown>]> = [
        ["tdei_find_datasets", { place: "Seattle", dataType: "shp" }], ["tdei_find_datasets", { place: "Seattle", limit: 0 }], ["tdei_find_datasets", { place: "Seattle", limit: 51 }],
        ["tdei_find_datasets", { bbox: [1, 2, 3] }], ["tdei_find_datasets", { place: "Seattle", uploadedWithinDays: -1 }], ["tdei_find_datasets", { place: "Seattle", status: "Draft" }],
        ["tdei_list_services", { serviceType: "gtfs" }], ["tdei_list_services", { pageSize: 51 }], ["tdei_list_jobs", { status: "DONE" }],
        ["tdei_upload_dataset", { dataType: "osw", asset: { kind: "remote_url", url: "https://example.com/x.zip" } /* invalid kind */ }],
        ["tdei_upload_dataset", { dataType: "osw", metadata: { dataset_detail: { ...goodMeta().dataset_detail, data_source: "Other" } } }],
      ];
      for (const [tool, args] of cases) {
        const o = await call(env, tool, args);
        check(o.isError || o.protocolError, `${tool} ${JSON.stringify(args)} was accepted (status ${o.data?.status})`);
        check(!/\b5\d\d\b|stack|at .*\.ts:\d+/i.test(o.text.slice(0, 400)), `${tool}: error looks like a server crash: ${o.text.slice(0, 120)}`);
      }
      for (const kind of ["inline_base64", "object_ref"]) for (const tool of ["tdei_validate_dataset", "tdei_upload_dataset"]) {
        const asset = kind === "inline_base64" ? { kind, name: "x.zip", mediaType: "application/zip", data: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" } : { kind, id: "blob-1", name: "x.zip" };
        const args = tool === "tdei_validate_dataset" ? { dataType: "osw", asset } : { dataType: "osw", asset, projectGroupId: "00000000-0000-0000-0000-000000000000", serviceId: "x", metadata: goodMeta() };
        const o = await call(env, tool, args);
        // The server ignores non-local_path assets and re-asks for the path with the curl hand-off (needs_input) rather than erroring; either is a refusal of the bytes.
        const refused = o.isError || o.protocolError || (o.data?.status === "needs_input" && (o.data.missing ?? []).some((m: any) => m.field === "asset"));
        check(refused, `${tool} accepted ${kind} (status ${o.data?.status})`);
        check(/never accepts file bytes|never takes file bytes|curl/i.test(o.text + (o.protocolError?.message ?? "")), `${tool}/${kind}: response should explain that the MCP never takes file bytes and show the curl route; got: ${o.text.slice(0, 150)}`);
      }
      {
        const rel = await call(env, "tdei_validate_dataset", { dataType: "osw", asset: { kind: "local_path", path: "relative/x.zip" } });
        check(rel.isError || rel.protocolError, "relative local_path accepted");
        check(/must be absolute/i.test(rel.text + (rel.protocolError?.message ?? "")), `relative local_path: unexpected error: ${rel.text.slice(0, 160)}`);
        if (errorCode(rel) === "TDEI_UPSTREAM_5XX") ctx.info("note: the relative-path refusal is labelled TDEI_UPSTREAM_5XX (retryable) although it is a client-side refusal");
        // An absolute path is only embedded in the client-side curl; the server never reads it, so a nonexistent path still yields the hand-off.
        const abs = await call(env, "tdei_validate_dataset", { dataType: "osw", asset: { kind: "local_path", path: "/nonexistent/x.zip" } });
        check(!abs.isError && !abs.protocolError && /curl/.test(abs.text) && abs.text.includes("/nonexistent/x.zip"), `absolute local_path should yield a curl hand-off: ${abs.text.slice(0, 160)}`);
      }
    }),
    A("T8", "hand-off gating for validate and upload", async (ctx) => {
      needToken(env, ctx);
      const v0 = expectStatus(await call(env, "tdei_validate_dataset", {}), "needs_input", "validate empty");
      const f0 = v0.missing.map((m: any) => m.field); check(f0.includes("dataType"), `validate empty should ask for dataType, asked ${f0}`);
      const v = expectStatus(await call(env, "tdei_validate_dataset", { dataType: "osw" }), "needs_input", "validate osw");
      eq(v.missing.length, 1, "validate osw missing count"); eq(v.missing[0].field, "asset", "missing field");
      const q = String(v.missing[0].question); check(/curl/.test(q) && /\/api\/v1\/(osw|\{[^}]*osw[^}]*\})\/validate/.test(q) && q.includes("tdei_list_jobs"), `asset question lacks curl / validate route / tdei_list_jobs: ${q.slice(0, 300)}`);
      check(!/Bearer\s+\S{20,}/.test(q), "curl hand-off must not carry a literal token");
      const u0 = expectStatus(await call(env, "tdei_upload_dataset", {}), "needs_input", "upload empty");
      const fields = u0.missing.map((m: any) => m.field).join(" ");
      for (const f of ["dataType", "asset", "projectGroupId", "serviceId"]) check(fields.includes(f), `upload empty: missing list lacks ${f} (${fields})`);
      for (const f of REQUIRED_META) check(fields.includes(f), `upload empty: missing list lacks metadata ${f} (${fields})`);
      const u = expectStatus(await call(env, "tdei_upload_dataset", { dataType: "osw", projectGroupId: "11111111-1111-1111-1111-111111111111", serviceId: "svc-1", metadata: goodMeta() }), "needs_input", "upload only asset missing");
      eq(u.missing.length, 1, "upload missing count"); eq(u.missing[0].field, "asset", "upload missing field");
      check(/curl/.test(u.missing[0].question) && /\/upload\/(11111111-1111-1111-1111-111111111111\/svc-1|\{projectGroupId\}\/\{serviceId\})/.test(u.missing[0].question), "upload hand-off must carry the upload route (concrete ids or the {projectGroupId}/{serviceId} template)");
      check(u.accepted?.projectGroupId === "11111111-1111-1111-1111-111111111111", "accepted must echo supplied non-secret fields");
    }),
    { id: "T8c", title: "hand-off curl is concrete (real API URL, type-specific route)", tags: ["A"], known: "hand-off text carries the literal placeholders <apiUrl> and {osw|gtfs-flex|gtfs-pathways}; the model cannot know the API URL", fn: async (ctx) => {
      needToken(env, ctx);
      const v = expectStatus(await call(env, "tdei_validate_dataset", { dataType: "osw" }), "needs_input", "validate osw"); const q = String(v.missing[0]?.question ?? "");
      check(!/<apiUrl>/.test(q), "question still contains the <apiUrl> placeholder"); check(!/\{osw\|gtfs-flex\|gtfs-pathways\}/.test(q), "route is not specialised to the supplied dataType");
      check(/https:\/\//.test(q), "question carries no concrete https URL");
    } },
    A("T9", "job lookup", async (ctx) => {
      needToken(env, ctx);
      const l = expectStatus(await call(env, "tdei_list_jobs", { projectGroupId: env.state.projectGroupId, limit: 5 }, { op: "LIST_JOBS" }), "complete", "jobs");
      const jobs = l.data.jobs ?? l.data.matches ?? []; if (!jobs.length) ctx.skip("the test user has no jobs");
      const id = jobs[0].job_id ?? jobs[0].jobId ?? jobs[0].id; check(id, "job record has no id field");
      const one = expectStatus(await call(env, "tdei_list_jobs", { jobId: String(id) }), "complete", "job by id");
      const got = one.data.jobs ?? one.data.matches ?? []; check(got.length >= 1 && String(got[0].job_id ?? got[0].jobId ?? got[0].id) === String(id), "jobId lookup did not return that job");
      expectStatus(await call(env, "tdei_list_jobs", { projectGroupId: env.state.projectGroupId, createdWithinDays: 3650, limit: 5 }), "complete", "createdWithinDays");
    }),
    A("T10", "identity shape and no token echo", async (ctx) => {
      needToken(env, ctx);
      const o = await call(env, "tdei_get_my_identity"); const id = expectStatus(o, "complete", "identity");
      const d = id.data?.identity ?? id.data ?? {}; check(d.username || d.email || d.user_name || d.preferred_username, `identity lacks username/email: ${JSON.stringify(Object.keys(d))}`);
      check(Array.isArray(d.roles) || d.roles === undefined || typeof d.roles === "object", "roles shape");
    }),
    A("T4", "authentication failures", async () => {
      const post = (headers: Record<string, string>) => http(mcpBase(env), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tdei_get_my_identity", arguments: {} } }), timeoutMs: 30000 });
      // Lazy auth: handshake traffic (initialize, tools/list) is open; only a protected tools/call is challenged.
      const list = await http(mcpBase(env), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), timeoutMs: 30000 });
      eq(list.status, 200, "anonymous tools/list (handshake) is open");
      const none = await post({}); eq(none.status, 401, "no header"); check(/TDEI_SSO_REQUIRED/.test(none.text), "no header: expected TDEI_SSO_REQUIRED"); check(/Bearer/i.test(none.headers.get("www-authenticate") ?? ""), "no header: missing WWW-Authenticate challenge");
      check(!/"(?:projectGroups|identity|username)"\s*:/.test(none.text), "invariant 8: anonymous tools/call returned tool data");
      for (const h of ["Bearer ", "Bearer", "Basic xyz"]) { const r = await post({ Authorization: h }); eq(r.status, 401, `Authorization "${h}"`); check(/TDEI_SSO_REQUIRED/.test(r.text), `"${h}": expected TDEI_SSO_REQUIRED, got ${r.text.slice(0, 100)}`); }
      const garbage = await post({ Authorization: "Bearer not-a-real-token-123456" }); eq(garbage.status, 401, "garbage token"); check(/TDEI_TOKEN_INVALID/.test(garbage.text), `garbage: expected TDEI_TOKEN_INVALID, got ${garbage.text.slice(0, 100)}`);
      const expired = await post({ Authorization: `Bearer ${jwtOf({ exp: 1000, sub: "x" })}` }); eq(expired.status, 401, "expired token");
      check(/TDEI_TOKEN_(EXPIRED|INVALID)/.test(expired.text), "expired: expected TDEI_TOKEN_EXPIRED or TDEI_TOKEN_INVALID");
    }),
    A("T4c", "foreign project group is never served", async (ctx) => {
      needToken(env, ctx); if (!env.sc.foreignProjectGroupId) ctx.skip("ACCEPT_FOREIGN_PROJECT_GROUP_ID not set");
      const o = await call(env, "tdei_find_datasets", { projectGroupId: env.sc.foreignProjectGroupId });
      if (o.isError) check(errorCode(o) === "TDEI_FORBIDDEN" || errorCode(o) === "TDEI_NOT_FOUND", `unexpected error ${errorCode(o)}`);
      else check((o.data?.data?.matches ?? o.data?.matches ?? []).length === 0, "data returned for a project group the user is not in");
    }),
    A("T4b", "anonymous after the harness's own sign-in still gets 401", async (ctx) => {
      needToken(env, ctx);
      await env.client().call("tdei_get_my_identity", {}); // authenticated activity first
      const anon = await env.client(null).rpc("tools/call", { name: "tdei_get_my_identity", arguments: {} });
      eq(anon.status, 401, "anonymous call after sign-in"); check(!/"username"|"email"/.test(anon.raw), "invariant 8: anonymous request returned identity data");
    }),
    A("T13", "cross-environment tokens are rejected", async (ctx) => {
      const others = env.cfg.slugs.filter((s) => s.label !== env.sc.label); if (!others.length) ctx.skip("only one environment label configured");
      let tested = 0;
      for (const o of others) {
        const t = env.tokensByLabel.get(o.label); if (!t) { ctx.info(`no token for label ${o.label}`); continue; }
        const r = await new McpClient(env.sc.mcpUrl, t).rpc("tools/list", {}); tested++;
        eq(r.status, 401, `token for ${o.label} on ${env.sc.slug}`); check(/TDEI_TOKEN_INVALID/.test(r.raw), `expected TDEI_TOKEN_INVALID, got ${r.raw.slice(0, 100)}`);
      }
      if (!tested) ctx.skip("no tokens for other labels (log in to them first)");
    }),
    A("T14", "HTTP surface", async () => {
      const r404 = await http(`${base(env)}/definitely-not-a-route`); eq(r404.status, 404, "unknown path");
      const r405 = await http(mcpBase(env), { method: "PUT", headers: env.token ? { Authorization: `Bearer ${env.token}` } : {} }); check([405, 401].includes(r405.status), `PUT /mcp -> ${r405.status}`);
      if (env.token) { const r400 = await http(mcpBase(env), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${env.token}` }, body: "{not json" }); check([400, 200].includes(r400.status) && r400.status !== 500, `non-JSON body -> ${r400.status}`); }
      const bad = await http(mcpBase(env), { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } }); eq(bad.status, 403, "OPTIONS with bad Origin"); check(/TDEI_ORIGIN_FORBIDDEN/.test(bad.text), "bad origin: expected TDEI_ORIGIN_FORBIDDEN");
      const root = await http(`${env.sc.base}/`); eq(root.status, 200, "status page"); check(/html/i.test(root.headers.get("content-type") ?? ""), "status page is not HTML");
      check(scanForSecrets(root.text).length === 0, "status page leaks a secret");
    }),
    A("T15", "installers", async () => {
      const setup = await http(`${mcpBase(env)}/setup`); eq(setup.status, 200, "setup overview");
      const clients = ["codex", "opencode", "claude-cli", "claude-desktop", "vscode", "cursor"];
      for (const c of clients) check(setup.text.includes(c), `setup overview does not list ${c}`);
      const unk = await http(`${mcpBase(env)}/setup/nope`); eq(unk.status, 404, "unknown client"); check(/TDEI_SETUP_CLIENT_UNKNOWN/.test(unk.text), "unknown client code");
      const host = new URL(env.sc.base).host; const dir = mkdtempSync(join(tmpdir(), "tdei-installers-"));
      for (const c of clients) for (const action of ["", "update/", "uninstall/"]) {
        const sh = await http(`${mcpBase(env)}/setup/${action}${c}`, { timeoutMs: 15000 }); rec(env, "INSTALLER", sh.ms);
        eq(sh.status, 200, `${action}${c}.sh`);
        check(scanForSecrets(sh.text).length === 0, `invariant 1: ${action}${c} script leaks a secret`);
        const hosts = new Set([...sh.text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]!).filter((h) => h !== host && !/^(127\.0\.0\.1|localhost)$/.test(h) && h !== "opencode.ai")); // opencode.ai appears only as a "$schema" annotation
        check(hosts.size === 0, `${action}${c}: script references hosts other than the gateway: ${[...hosts]}`);
        const f = join(dir, `${action.replace("/", "-")}${c}.sh`); writeFileSync(f, sh.text);
        const syn = spawnSync("sh", ["-n", f], { encoding: "utf8" }); check(syn.status === 0, `${action}${c}.sh fails sh -n: ${syn.stderr}`);
        const ps = await http(`${mcpBase(env)}/setup/${action}${c}.ps1`, { timeoutMs: 15000 }); eq(ps.status, 200, `${action}${c}.ps1`);
        check(scanForSecrets(ps.text).length === 0, `${action}${c}.ps1 leaks a secret`);
      }
    }),
    A("T17", "latency (p95 vs budget)", async (ctx) => {
      needToken(env, ctx);
      const L = env.cfg.latency;
      const ops: Array<[string, string, Record<string, unknown>]> = [["READ_TOOL", "tdei_list_my_project_groups", {}], ["LIST_JOBS", "tdei_list_jobs", { projectGroupId: env.state.projectGroupId, limit: 5 }]];
      const lines: string[] = [];
      for (const [op, tool, args] of ops) {
        const xs: number[] = [];
        for (let i = 0; i < L.warmup + L.samples; i++) { const o = await env.client().call(tool, args); if (i >= L.warmup) xs.push(o.ms); }
        const v = p95(xs), budget = L.budgets[op]!; lines.push(`${op} p95=${v}ms budget=${budget}ms`);
        if (L.mode === "enforce") check(v <= budget, `${op} p95 ${v}ms exceeds budget ${budget}ms`);
      }
      ctx.info(`${L.mode}: ${lines.join("; ")}`);
    }, ["slow"]),
  ];
}
