// Target B tests: need the fake TDEI API for fault injection.
import { McpClient, errorCode } from "../mcp.ts";
import { check, eq, type TestDef } from "../runner/runner.ts";
import { fakeJwt, type Fakes } from "../fakes/fake-tdei.ts";
import { http } from "../http.ts";
import { call, expectStatus, type Env } from "./env.ts";

export function faultTests(env: Env, fakes: Fakes): TestDef[] {
  const B = (id: string, title: string, fn: TestDef["fn"], known?: string): TestDef => ({ id, title, tags: ["B"], ...(known ? { known } : {}), fn: async (c) => { fakes.reset(); await fn(c); } });
  const jwt = (n: string) => fakeJwt({ preferred_username: n, email: `${n}@example.test`, jti: n + Math.random() });
  return [
    B("T5", "upstream error mapping", async (ctx) => {
      // [upstream status, acceptable codes]. 401/429 have no explicit mapping in the server today; the table records what happens.
      const table: Array<[number, string[]]> = [[403, ["TDEI_FORBIDDEN"]], [404, ["TDEI_NOT_FOUND"]], [409, ["TDEI_CONFLICT"]], [429, ["TDEI_UPSTREAM_5XX", "TDEI_RATE_LIMITED", "TDEI_CHILD_UNAVAILABLE"]], [500, ["TDEI_UPSTREAM_5XX"]], [503, ["TDEI_UPSTREAM_5XX"]]];
      const bad: string[] = []; const seen: string[] = [];
      for (const [st, ok] of table) {
        fakes.reset(); fakes.script("/api/v1/services", { status: st, body: { message: `fake ${st}` } });
        const o = await call(env, "tdei_list_services", {}, { client: new McpClient(env.sc.mcpUrl, jwt("u" + st)) });
        const code = errorCode(o); seen.push(`${st}->${code}`);
        if (!o.isError || !code || !ok.includes(code)) bad.push(`${st}: got ${o.isError ? code : "success"}, want ${ok.join("|")}`);
        check(!/fake.user|Bearer/.test(o.text), `upstream ${st}: error text echoes credentials`);
      }
      ctx.info(seen.join(", "));
      check(bad.length === 0, bad.join(" | "));
      // token rejected by upstream validation
      fakes.reset(); fakes.script("/api/v1/project-groups", { status: 401, body: {} });
      const r = await new McpClient(env.sc.mcpUrl, jwt("rej")).rpc("tools/call", { name: "tdei_get_my_identity", arguments: {} });
      eq(r.status, 401, "token rejected by upstream"); check(/TDEI_TOKEN_INVALID/.test(r.raw), `expected TDEI_TOKEN_INVALID, got ${r.raw.slice(0, 120)}`);
    }),
    B("T5c", "upstream 401 on a data call maps to a re-authentication code", async () => {
      fakes.script("/api/v1/services", { status: 401, body: { message: "token revoked" } });
      const o = await call(env, "tdei_list_services", {}, { client: new McpClient(env.sc.mcpUrl, jwt("rev")) });
      check(o.isError, "401 must be an error"); check(["TDEI_TOKEN_INVALID", "TDEI_TOKEN_EXPIRED"].includes(errorCode(o) ?? ""), `401 from TDEI on a data call is reported as ${errorCode(o)}; the user should be told to sign in again`);
    }, "an upstream 401 after the token was accepted falls through to TDEI_UPSTREAM_5XX (src/mcp/errors.ts has no 401 branch), so the model is told to retry instead of re-authenticating"),
    B("T5b", "upstream timeout and malformed body fail cleanly", async () => {
      fakes.script("/api/v1/services", { raw: "<html>gateway error</html>", status: 200 });
      const o = await call(env, "tdei_list_services", {}, { client: new McpClient(env.sc.mcpUrl, jwt("html")) });
      check(o.isError, "non-JSON 200 from upstream must be a tool error, not an empty success");
      fakes.reset(); fakes.script("/api/v1/services", { hang: true });
      const t0 = Date.now(); const h = await new McpClient(env.sc.mcpUrl, jwt("hang"), 45000).call("tdei_list_services", {});
      check(h.isError, "hung upstream must produce a tool error"); check(Date.now() - t0 < 40000, `hung upstream took ${Date.now() - t0}ms (server timeout is 15s)`);
      check(!errorCode(h) || errorCode(h) !== "TDEI_FORBIDDEN", "timeout must not be reported as FORBIDDEN");
    }),
    B("T7", "dataset search fallback order", async () => {
      const c = () => new McpClient(env.sc.mcpUrl, jwt("t7"));
      const datasetsCalls = () => fakes.calls("/api/v1/datasets").map((e) => new URLSearchParams(e.query));
      // name hit stops the chain
      let o = await call(env, "tdei_find_datasets", { place: "Seattle" }, { client: c() }); let d = expectStatus(o, "complete", "name hit");
      check(d.data.matches.length > 0 && d.data.matches[0].matchedBy === "name", "name hit should report matchedBy name");
      eq(datasetsCalls().length, 1, "datasets calls after a name hit"); eq(fakes.calls("/geocoder").length, 0, "geocoder calls after a name hit");
      // city only after a name miss
      fakes.reset(); fakes.script("/api/v1/datasets", (e) => { const q = new URLSearchParams(e.query); return q.get("city") ? { body: [{ tdei_dataset_id: "c1", name: "c", uploaded_timestamp: "2024-01-01T00:00:00Z" }] } : { body: [] }; });
      o = await call(env, "tdei_find_datasets", { place: "Springfield" }, { client: c() }); d = expectStatus(o, "complete", "city hit");
      eq(d.data.matches[0]?.matchedBy, "city", "matchedBy"); const qs = datasetsCalls(); eq(qs.length, 2, "name then city"); check(qs[0]!.has("name") && qs[1]!.has("city"), "order must be name, then city"); eq(fakes.calls("/geocoder").length, 0, "geocoder not used");
      // geocoder only after both miss: multiple candidates => ambiguous, no bbox search
      fakes.reset(); fakes.script("/api/v1/datasets", { body: [] }); fakes.geocode([{ name: "Springfield, IL", bbox: [-90, 39, -89, 40] }, { name: "Springfield, MA", bbox: [-73, 42, -72, 43] }]);
      o = await call(env, "tdei_find_datasets", { place: "Springfield" }, { client: c() }); d = expectStatus(o, "ambiguous", "two geocoder candidates");
      eq(d.candidates.length, 2, "candidate count"); eq(datasetsCalls().length, 2, "no bbox search while ambiguous (invariant 5)");
      // single candidate => bbox search
      fakes.reset(); fakes.script("/api/v1/datasets", (e) => (new URLSearchParams(e.query).getAll("bbox").length === 4 ? { body: [{ tdei_dataset_id: "b1", name: "b", uploaded_timestamp: "2024-01-01T00:00:00Z" }] } : { body: [] })); fakes.geocode([{ name: "Atlantis", bbox: [1, 2, 3, 4] }]);
      o = await call(env, "tdei_find_datasets", { place: "Atlantis" }, { client: c() }); d = expectStatus(o, "complete", "single candidate");
      eq(d.data.matches[0]?.matchedBy, "bbox", "matchedBy"); eq(datasetsCalls().length, 3, "name, city, bbox");
      // no candidates => empty complete
      fakes.reset(); fakes.script("/api/v1/datasets", { body: [] }); fakes.geocode([]);
      o = await call(env, "tdei_find_datasets", { place: "Nowhereville" }, { client: c() }); d = expectStatus(o, "complete", "no candidates"); eq(d.data.matches.length, 0, "empty matches");
      // invariant 4: upstream auth failure never falls through to geocoder
      fakes.reset(); fakes.script("/api/v1/datasets", { status: 403, body: { message: "no" } }); fakes.geocode([{ name: "X", bbox: [1, 2, 3, 4] }]);
      o = await call(env, "tdei_find_datasets", { place: "Seattle" }, { client: c() }); check(o.isError, "403 must be an error, not an empty complete"); eq(fakes.calls("/geocoder").length, 0, "geocoder must not run after an auth failure");
    }),
    B("T11", "concurrent identities never cross", async () => {
      const users = ["alice", "bob"]; const clients = users.map((u) => new McpClient(env.sc.mcpUrl, jwt(u)));
      const jobs: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        const k = i % 2; const u = users[k]!;
        jobs.push((async () => {
          const o = await clients[k]!.call("tdei_get_my_identity", {});
          check(!o.isError, `identity call failed for ${u}`);
          const text = o.text; const other = users[1 - k]!;
          check(text.includes(u) && !text.includes(other), `cross-contamination: ${u}'s call returned ${text.slice(0, 160)}`);
          const up = await clients[k]!.call("tdei_upload_dataset", { dataType: "osw", projectGroupId: `${u}-pg`, serviceId: `${u}-svc` });
          check(up.text.includes(`${u}-pg`) && !up.text.includes(`${other}-pg`), `accepted/echo cross-contamination for ${u}`);
        })());
      }
      await Promise.all(jobs);
    }),
    B("T16", "oversize output is truncated with a trailer, UTF-8 intact", async () => {
      const big = Array.from({ length: 1500 }, (_, i) => ({ service_id: `s${i}`, service_name: `é世界🚶 ${i} ` + "x".repeat(300), tdei_project_group_id: "p" }));
      fakes.script("/api/v1/services", { body: big });
      const o = await new McpClient(env.sc.mcpUrl, jwt("big"), 60000).call("tdei_list_services", { pageSize: 50 });
      const bytes = Buffer.byteLength(o.text, "utf8");
      check(bytes <= 262144 + 4096, `result is ${bytes} bytes`);
      if (bytes < 262144) { check(!/"truncated"/.test(o.text), "trailer present on a small result"); return; }
      check(/"truncated"\s*:\s*true/.test(o.text), "oversize result lacks the truncation trailer");
      check(!o.text.includes("�"), "truncation cut a multibyte character");
    }),
    B("T8b", "validate/upload never call upstream", async () => {
      const c = new McpClient(env.sc.mcpUrl, jwt("t8"));
      await c.call("tdei_validate_dataset", { dataType: "osw" }); await c.call("tdei_upload_dataset", { dataType: "osw", projectGroupId: "p", serviceId: "s" });
      const writes = fakes.log.filter((e) => /\/(validate|upload)/.test(e.path));
      check(writes.length === 0, `hand-off tools called the upstream write API: ${writes.map((w) => w.path)}`);
    }),
    B("T14b", "health reports build info", async (ctx) => {
      const r = await http(`${env.sc.base}/health`); eq(r.status, 200, "health"); const j = r.json as any;
      check(j?.spec?.reachable === true, "spec should be reachable via the fake"); if (!j?.build?.sha) ctx.info("health reports no build.sha (server not rebuilt?)");
    }),
  ];
}
