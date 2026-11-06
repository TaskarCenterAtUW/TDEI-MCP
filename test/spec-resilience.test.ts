import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOpenApiDocument, OpenApiMcpClient } from "../src/openapi/openapi-mcp-client.js";
import { writeCachedSpec } from "../src/openapi/spec-disk-cache.js";

const specWith = (...ids: string[]) => ({
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths: Object.fromEntries(ids.map((id) => [`/${id}`, { get: { operationId: id } }])),
});

test("a failed spec load is not retried by every request for a few seconds", async () => {
  let loads = 0;
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    logger: () => undefined,
    loadSpec: async () => {
      loads += 1;
      throw new Error("spec host down");
    },
  });
  await assert.rejects(client.listTools(), /spec host down/);
  await assert.rejects(client.listTools(), /spec host down/);
  await assert.rejects(client.listTools(), /spec host down/);
  assert.equal(loads, 1);
});

test("refresh swaps in a changed spec and keeps the old tools when the reload fails", async () => {
  let current: unknown = specWith("alpha");
  let fail = false;
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    logger: () => undefined,
    loadSpec: async () => {
      if (fail) throw new Error("down");
      return current as Record<string, unknown>;
    },
  });
  assert.equal(await client.refresh(), false, "nothing loaded yet, nothing to refresh");
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["alpha"],
  );

  current = specWith("alpha", "beta");
  assert.equal(await client.refresh(), true);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["alpha", "beta"],
  );
  assert.equal(await client.refresh(), false, "an unchanged spec reports no change");

  fail = true;
  await assert.rejects(client.refresh(), /down/);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["alpha", "beta"],
  );
});

test("an unreachable spec host falls back to the last cached copy, per URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-spec-"));
  const previous = process.env.TDEI_SPEC_CACHE_DIR;
  process.env.TDEI_SPEC_CACHE_DIR = dir;
  const realConsoleError = console.error;
  console.error = () => undefined;
  try {
    const down = "http://127.0.0.1:1/core-spec.json";
    const other = "http://127.0.0.1:1/workspace-spec.json";
    writeCachedSpec(down, specWith("cachedOp"));

    const doc = await loadOpenApiDocument(down);
    assert.deepEqual(Object.keys(doc.paths as object), ["/cachedOp"]);

    // A different server's spec URL must not receive this copy.
    await assert.rejects(loadOpenApiDocument(other));
  } finally {
    console.error = realConsoleError;
    if (previous === undefined) delete process.env.TDEI_SPEC_CACHE_DIR;
    else process.env.TDEI_SPEC_CACHE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
