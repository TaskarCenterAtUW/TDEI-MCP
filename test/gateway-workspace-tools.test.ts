import { WORKSPACE_SPEC } from "./helpers/workspace-backend-env.js";
import { strict as assert } from "node:assert";
import test from "node:test";

import { serveTestHttp } from "./helpers/test-http-server.js";

const originalFetch = globalThis.fetch;

function rpc(method: string, params: unknown = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function post(url: string, body: string, token?: string): Promise<Response> {
  return originalFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

/** Records the Authorization header of each upstream workspace call. */
function mockUpstream(seen: string[]): () => void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = request.url;
    // Token validation probe of the core API: accept any token.
    if (url.includes("/api/v1/project-groups")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith("https://ws.example.test/api/v1/workspaces/mine")) {
      seen.push(request.headers.get("Authorization") ?? "");
      return new Response(JSON.stringify([{ id: 1, name: "ws" }]), {
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

test("workspace gateway: tools are listed without signing in, and the first call starts sign-in", async () => {
  const seen: string[] = [];
  const restore = mockUpstream(seen);
  const handle = await serveTestHttp({
    gatewaySlug: "tdei-workspace-dev",
    loadOpenApiSpec: async () => WORKSPACE_SPEC,
  });
  try {
    const listed = await post(`${handle.url}/mcp`, rpc("tools/list"));
    assert.equal(listed.status, 200);
    assert.match(await listed.text(), /"name":"get_my_workspaces"/);

    const call = await post(`${handle.url}/mcp`, rpc("tools/call", { name: "get_my_workspaces", arguments: {} }, 2));
    assert.equal(call.status, 401);
    assert.match(call.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    assert.equal(((await call.json()) as { code: string }).code, "TDEI_SSO_REQUIRED");
    assert.deepEqual(seen, [], "an unauthenticated call never reaches the API");
  } finally {
    await handle.close();
    restore();
  }
});

test("workspace gateway: a signed-in caller sees the workspace tools and calls them with their own token", async () => {
  const seen: string[] = [];
  const restore = mockUpstream(seen);
  const handle = await serveTestHttp({
    gatewaySlug: "tdei-workspace-dev",
    loadOpenApiSpec: async () => WORKSPACE_SPEC,
  });
  try {
    const init = await post(
      `${handle.url}/mcp`,
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      }),
      "alice-token",
    );
    assert.equal(init.status, 200, await init.clone().text());
    const initText = await init.text();
    assert.doesNotMatch(initText, /tdei_sso_login"\s*\}/);
    assert.match(initText, /no tdei_sso_login tool/);
    assert.match(initText, /tools are listed without signing in/);

    const listed = await post(`${handle.url}/mcp`, rpc("tools/list"), "alice-token");
    assert.equal(listed.status, 200, await listed.clone().text());
    assert.match(await listed.text(), /"name":"get_my_workspaces"/);

    // Two callers, interleaved: each upstream call carries its own caller's token.
    const [a, b] = await Promise.all([
      post(`${handle.url}/mcp`, rpc("tools/call", { name: "get_my_workspaces", arguments: {} }, 2), "alice-token"),
      post(`${handle.url}/mcp`, rpc("tools/call", { name: "get_my_workspaces", arguments: {} }, 3), "bob-token"),
    ]);
    assert.equal(a.status, 200, await a.clone().text());
    assert.equal(b.status, 200, await b.clone().text());
    assert.match(await a.text(), /workspaces|ws/);
    assert.deepEqual([...seen].sort(), ["Bearer alice-token", "Bearer bob-token"]);

    // A protected call with no token is still challenged and never reaches the API.
    seen.length = 0;
    const anon = await post(`${handle.url}/mcp`, rpc("tools/call", { name: "get_my_workspaces", arguments: {} }, 4));
    assert.equal(anon.status, 401);
    assert.deepEqual(seen, []);
  } finally {
    await handle.close();
    restore();
  }
});
