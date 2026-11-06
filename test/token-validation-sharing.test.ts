import assert from "node:assert/strict";
import test from "node:test";

import { injectAccessToken } from "../src/auth/auth-manager.js";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// A JWT-shaped bearer that expires far in the future.
function bearer(): string {
  return `${enc({ alg: "none" })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "u" })}.sig`;
}

test("concurrent validations of one token share a single upstream probe", async () => {
  const token = bearer();
  const cache = new Map<string, number>();
  let probes = 0;
  let sawSignal = false;
  let probeUrl = "";
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    probes += 1;
    probeUrl = String(url);
    sawSignal = init?.signal instanceof AbortSignal;
    await new Promise((r) => setTimeout(r, 20));
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;

  // Each request builds its own auth object, exactly like the HTTP handler.
  await Promise.all(Array.from({ length: 8 }, () => injectAccessToken(token).validateToken({ fetchImpl, cache })));
  assert.equal(probes, 1);
  assert.equal(sawSignal, true, "probe must carry a timeout");
  assert.match(probeUrl, /page_size=1/, "probe asks for one row, not the whole list");

  // The result is cached afterwards too.
  await injectAccessToken(token).validateToken({ fetchImpl, cache });
  assert.equal(probes, 1);
});

test("a failed shared probe rejects every waiter and is not reused", async () => {
  const token = bearer();
  const cache = new Map<string, number>();
  let probes = 0;
  const fetchImpl = (async () => {
    probes += 1;
    await new Promise((r) => setTimeout(r, 10));
    return new Response("no", { status: 401 });
  }) as unknown as typeof fetch;
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => injectAccessToken(token).validateToken({ fetchImpl, cache })),
  );
  assert.ok(results.every((r) => r.status === "rejected" && /TDEI_TOKEN_INVALID/.test(String(r.reason))));
  assert.equal(probes, 1);
  await assert.rejects(injectAccessToken(token).validateToken({ fetchImpl, cache }), /TDEI_TOKEN_INVALID/);
  assert.equal(probes, 2, "after settling, a new request probes again");
});
