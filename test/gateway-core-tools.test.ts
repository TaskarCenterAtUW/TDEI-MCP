import { strict as assert } from "node:assert";
import test from "node:test";

import { serveTestHttp } from "./helpers/test-http-server.js";

const originalFetch = globalThis.fetch;

const CORE_SPEC = {
  openapi: "3.0.0",
  info: { title: "core", version: "1" },
  paths: {
    // Not covered by a semantic tool: must be registered.
    "/api/v1/api-versions": {
      get: { operationId: "listApiVersions", summary: "API versions", responses: { "200": { description: "ok" } } },
    },
    // Covered by tdei_list_services: must stay out of the catalog.
    "/api/v1/services": {
      get: { operationId: "listServices", summary: "Services", responses: { "200": { description: "ok" } } },
    },
  },
};

const USER_SPEC = {
  openapi: "3.0.0",
  info: { title: "portal", version: "1" },
  paths: {
    "/api/v1/roles": {
      get: { operationId: "roles", summary: "Roles", responses: { "200": { description: "ok" } } },
    },
  },
};

const loadOpenApiSpec = async (specUrl: string) => (specUrl.includes("portal-api") ? USER_SPEC : CORE_SPEC);

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

/** Records which Authorization header each upstream call carried, per host. */
function mockUpstream(seen: { path: string; host: string; auth: string }[]): () => void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/project-groups") {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/v1/api-versions" || url.pathname === "/api/v1/roles") {
      seen.push({ path: url.pathname, host: url.host, auth: request.headers.get("Authorization") ?? "" });
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("core gateway lists its semantic tools plus the raw operations they do not cover", async () => {
  const restore = mockUpstream([]);
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev", loadOpenApiSpec });
  try {
    const listed = await post(`${handle.url}/mcp`, rpc("tools/list"));
    assert.equal(listed.status, 200, "listing needs no sign-in");
    const text = await listed.text();
    assert.match(text, /"name":"tdei_list_my_project_groups"/);
    assert.match(text, /"name":"listApiVersions"/);
    assert.match(text, /"name":"portal_list_roles"/);
    assert.doesNotMatch(text, /"name":"listServices"/, "semantic-covered raw operations stay hidden");
  } finally {
    await handle.close();
    restore();
  }
});

test("core gateway raw tools call the upstream API with each caller's own token", async () => {
  const seen: { path: string; host: string; auth: string }[] = [];
  const restore = mockUpstream(seen);
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev", loadOpenApiSpec });
  try {
    const call = (name: string, id: number, token: string) =>
      post(`${handle.url}/mcp`, rpc("tools/call", { name, arguments: {} }, id), token);
    const responses = await Promise.all([
      call("listApiVersions", 2, "alice-token"),
      call("portal_list_roles", 3, "bob-token"),
    ]);
    const statusTexts = await Promise.all(responses.map((response) => response.clone().text()));
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200, statusTexts[index]);
    }

    const byPath = Object.fromEntries(seen.map((entry) => [entry.path, entry]));
    assert.equal(byPath["/api/v1/api-versions"]?.auth, "Bearer alice-token");
    assert.equal(byPath["/api/v1/roles"]?.auth, "Bearer bob-token");
    assert.match(byPath["/api/v1/roles"]?.host ?? "", /^portal-api/, "the User Management API is its own host");

    seen.length = 0;
    const anonymous = await post(`${handle.url}/mcp`, rpc("tools/call", { name: "listApiVersions", arguments: {} }, 4));
    assert.equal(anonymous.status, 401);
    assert.deepEqual(seen, [], "an unauthenticated call never reaches the API");
  } finally {
    await handle.close();
    restore();
  }
});

test("a spec that cannot be loaded does not break the handshake", async () => {
  const restore = mockUpstream([]);
  const handle = await serveTestHttp({
    gatewaySlug: "tdei-core-dev",
    loadOpenApiSpec: async () => {
      throw new Error("spec host down");
    },
  });
  try {
    const listed = await post(`${handle.url}/mcp`, rpc("tools/list"));
    assert.equal(listed.status, 200);
    assert.match(await listed.text(), /"name":"tdei_list_my_project_groups"/);
  } finally {
    await handle.close();
    restore();
  }
});
