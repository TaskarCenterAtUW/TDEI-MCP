import assert from "node:assert/strict";
import test from "node:test";

import { OpenApiMcpClient } from "../src/openapi/openapi-mcp-client.js";
import { OpenApiToolsLifecycle } from "../src/openapi/openapi-tools-lifecycle.js";

test("concurrent first calls share one spec load", async () => {
  let loads = 0;
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    logger: () => undefined,
    loadSpec: async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { paths: { "/a": { get: { operationId: "getA" } } } };
    },
  });
  await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.equal(loads, 1);
});

test("GET retries transient 503 and applies a timeout signal", async () => {
  let calls = 0;
  let sawSignal = false;
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    logger: () => undefined,
    loadSpec: async () => ({ paths: { "/a": { get: { operationId: "getA" } } } }),
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      sawSignal ||= init?.signal instanceof AbortSignal;
      return calls < 2 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
    }) as typeof fetch,
  });
  const result = await client.callTool("getA", {});
  assert.equal(calls, 2);
  assert.equal(sawSignal, true);
  assert.equal(result.content[0]?.text, "ok");
});

test("slow tool calls do not block each other", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const openApiSession = {
    close: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  };
  const lifecycle = new OpenApiToolsLifecycle(
    {} as never,
    { logout: async () => ({}) as never, getTokenVersion: () => 0 },
    openApiSession,
    (async () => ({ discovered: 0, registered: 0, skipped: 0, toolSchemas: new Map() })) as never,
  );
  await lifecycle.load();
  await Promise.all([lifecycle.callTool("x", {}), lifecycle.callTool("y", {}), lifecycle.callTool("z", {})]);
  assert.equal(maxInFlight, 3);
});

test("uploads are never retried after a network error or 502/504", async () => {
  const spec = {
    paths: {
      "/up": {
        post: {
          operationId: "up",
          requestBody: {
            content: {
              "multipart/form-data": { schema: { type: "object", properties: { note: { type: "string" } } } },
            },
          },
        },
      },
    },
  };
  for (const outcome of ["throw", 502, 504] as const) {
    let calls = 0;
    const client = new OpenApiMcpClient({
      apiUrl: "https://api.example.test",
      logger: () => undefined,
      loadSpec: async () => spec,
      fetchImpl: (async () => {
        calls += 1;
        if (outcome === "throw") throw new Error("socket hang up");
        return new Response("x", { status: outcome });
      }) as typeof fetch,
    });
    // oxlint-disable-next-line no-await-in-loop -- one call per outcome, with a shared call counter that parallel calls would corrupt
    await client.callTool("up", { note: "n" }).catch(() => undefined);
    assert.equal(calls, 1, `outcome ${String(outcome)} must not be retried`);
  }
});
