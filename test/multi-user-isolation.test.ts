import { createHash, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.TDEI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tdei-isolation-sessions-"));

import { injectAccessToken } from "../src/auth/auth-manager.js";
import { isDirectLocalCaller, sharedSessionAllowed } from "../src/auth/session-sharing.js";
import { clearSharedSession, saveSharedSession } from "../src/auth/shared-session.js";
import { getConfig } from "../src/config.js";
import { serveTestHttp } from "./helpers/test-http-server.js";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(sub: string): string {
  return `${enc({ alg: "none" })}.${enc({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}
const userA = { access_token: jwt("user-a"), refresh_token: "refresh-of-user-a", expires_in: 3600 };

const originalFetch = globalThis.fetch;
/** TDEI accepts any bearer for the probe, so only the server's own checks decide. */
function mockTdei(): () => void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/project-groups")) {
      return new Response(JSON.stringify([{ tdei_project_group_id: "pg", project_group_name: "PG" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function rpc(method: string, params: unknown = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
function post(url: string, body: string, token?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body,
  });
}
async function authorize(base: string, slug: string): Promise<Response> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return fetch(
    `${base}/${slug}/oauth/authorize?response_type=code&client_id=tdei-mcp&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/callback")}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: "manual" },
  );
}

test("gateway: one user's saved login is never handed to the next person", async () => {
  const apiUrl = getConfig().authApiUrl;
  clearSharedSession(apiUrl);
  saveSharedSession(apiUrl, userA, Date.now() + 3600_000); // user A logged in earlier
  const restore = mockTdei();
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    // User B starts a login. They must be sent to SSO, not given A's tokens.
    const res = await authorize(handle.url, "tdei-core-dev");
    assert.equal(res.status, 200);
    const location = (await res.text()).match(/var loginUrl = ("[^"]*");/)?.[1] ?? "";
    assert.match(location, /api\/v1\/sso-redirect/, "B must authenticate as themselves");
    assert.ok(!location.includes("code="), "no sealed authorization code for A's session");
  } finally {
    await handle.close();
    restore();
    clearSharedSession(apiUrl);
  }
});

test("gateway: a tool call without a token is rejected even after another user logged in", async () => {
  const apiUrl = getConfig().authApiUrl;
  clearSharedSession(apiUrl);
  saveSharedSession(apiUrl, userA, Date.now() + 3600_000);
  const restore = mockTdei();
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    await authorize(handle.url, "tdei-core-dev"); // would have loaded A into the process
    const call = rpc("tools/call", { name: "tdei_list_my_project_groups", arguments: {} });
    const anonymous = await post(`${handle.url}/mcp`, call);
    assert.equal(anonymous.status, 401, "no Authorization header must never be served");
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  } finally {
    await handle.close();
    restore();
    clearSharedSession(apiUrl);
  }
});

test("a remote caller (reverse proxy headers) is never served from a shared login, even without a gateway slug", async () => {
  const restore = mockTdei();
  const handle = await serveTestHttp({});
  try {
    const call = rpc("tools/call", { name: "tdei_list_my_project_groups", arguments: {} });
    const remote = await post(`${handle.url}/mcp`, call, undefined, { "X-Forwarded-For": "203.0.113.9" });
    assert.equal(remote.status, 401);
    const viaRealIp = await post(`${handle.url}/mcp`, call, undefined, { "X-Real-IP": "203.0.113.9" });
    assert.equal(viaRealIp.status, 401);
  } finally {
    await handle.close();
    restore();
  }
});

test("gateway: handshake works without a token and exposes no shared-login tools", async () => {
  const restore = mockTdei();
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    const listed = await post(`${handle.url}/mcp`, rpc("tools/list"));
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.match(text, /tdei_list_my_project_groups/);
    for (const sessionTool of ["tdei_sso_login", "tdei_sso_complete", "tdei_auth_status", "tdei_logout"]) {
      assert.ok(!text.includes(`"${sessionTool}"`), `${sessionTool} would read or write a process-wide session`);
    }
  } finally {
    await handle.close();
    restore();
  }
});

test("gateway: two users with their own tokens are served independently", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url.includes("/api/v1/project-groups")) {
      const bearer = request.headers.get("Authorization") ?? "";
      seen.push(bearer);
      return new Response(JSON.stringify([{ tdei_project_group_id: "pg", project_group_name: bearer }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    const a = jwt("user-a");
    const b = jwt("user-b");
    const call = rpc("tools/call", { name: "tdei_list_my_project_groups", arguments: {} });
    const [ra, rb] = await Promise.all([post(`${handle.url}/mcp`, call, a), post(`${handle.url}/mcp`, call, b)]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.ok(seen.includes(`Bearer ${a}`) && seen.includes(`Bearer ${b}`));
    // Every upstream call carried the caller's own token, never the other's.
    const [ta, tb] = [await ra.text(), await rb.text()];
    assert.ok(ta.includes(a) && !ta.includes(b));
    assert.ok(tb.includes(b) && !tb.includes(a));
  } finally {
    await handle.close();
    globalThis.fetch = originalFetch;
  }
});

test("an upstream error while validating a token fails closed instead of accepting it", async () => {
  for (const status of [500, 502, 503, 404]) {
    const fetchImpl = (async () => new Response("x", { status })) as unknown as typeof fetch;
    // oxlint-disable-next-line no-await-in-loop -- assert one status at a time so the first failing status is reported deterministically
    await assert.rejects(
      injectAccessToken(jwt(`u${status}`)).validateToken({ fetchImpl }),
      /TDEI_TOKEN_INVALID|TDEI_UPSTREAM_UNAVAILABLE/,
      `status ${status} must not validate`,
    );
  }
});

test("a direct local caller keeps the single-user experience: login tools and a shared session", async () => {
  const restore = mockTdei();
  const handle = await serveTestHttp({});
  try {
    const listed = await post(`${handle.url}/mcp`, rpc("tools/list"));
    assert.equal(listed.status, 200);
    assert.match(await listed.text(), /"tdei_sso_login"/);
  } finally {
    await handle.close();
    restore();
  }
});

test("only a direct loopback connection without proxy headers counts as local", () => {
  assert.equal(isDirectLocalCaller("127.0.0.1", {}), true);
  assert.equal(isDirectLocalCaller("::1", {}), true);
  assert.equal(isDirectLocalCaller("::ffff:127.0.0.1", {}), true);
  assert.equal(isDirectLocalCaller("10.0.0.5", {}), false);
  assert.equal(isDirectLocalCaller("172.17.0.1", {}), false);
  assert.equal(isDirectLocalCaller(undefined, {}), false);
  for (const header of ["x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "forwarded"]) {
    assert.equal(isDirectLocalCaller("127.0.0.1", { [header]: "203.0.113.9" }), false, header);
  }
  // A gateway child is never local, whoever connects.
  assert.equal(sharedSessionAllowed({ gatewaySlug: "tdei-core-dev", remoteAddress: "127.0.0.1", headers: {} }), false);
  assert.equal(sharedSessionAllowed({ gatewaySlug: undefined, remoteAddress: "127.0.0.1", headers: {} }), true);
});
