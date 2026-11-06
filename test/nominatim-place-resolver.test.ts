import { strict as assert } from "node:assert";
import test from "node:test";

import { NominatimPlaceResolver } from "../src/adapters/nominatim-place-resolver.js";

test("Nominatim resolver normalizes forward-geocode bounding boxes", async () => {
  let request: Request | undefined;
  const resolver = new NominatimPlaceResolver({
    endpoint: "https://geo.example.test/search",
    userAgent: "tdei-mcp-tests/1.0",
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify([
          {
            place_id: 237385,
            display_name: "Seattle, King County, Washington, USA",
            importance: 0.72,
            boundingbox: ["47.481", "47.734", "-122.459", "-122.224"],
          },
        ]),
        { status: 200 },
      );
    },
  });

  const candidates = await resolver.forwardGeocode("Seattle");

  assert.deepEqual(candidates, [
    {
      label: "Seattle, King County, Washington, USA",
      bbox: [-122.459, 47.481, -122.224, 47.734],
      confidence: 0.72,
      providerId: "237385",
    },
  ]);
  assert.equal(request?.headers.get("User-Agent"), "tdei-mcp-tests/1.0");
  assert.equal(request?.url, "https://geo.example.test/search?q=Seattle&format=jsonv2&limit=5");
});

const SEATTLE = JSON.stringify([
  { place_id: 1, display_name: "Seattle, WA", boundingbox: ["47.4", "47.7", "-122.4", "-122.2"] },
]);

test("Nominatim resolver caches by normalized place and shares concurrent lookups", async () => {
  let calls = 0;
  const resolver = new NominatimPlaceResolver({
    endpoint: "https://geo.example.test/search",
    userAgent: "t",
    minIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(SEATTLE, { status: 200 });
    },
  });
  const [a, b] = await Promise.all([resolver.forwardGeocode("Seattle"), resolver.forwardGeocode("  seattle ")]);
  assert.deepEqual(a, b);
  await resolver.forwardGeocode("SEATTLE");
  assert.equal(calls, 1);
});

test("Nominatim resolver does not cache failures and retries 429 with Retry-After", async () => {
  let calls = 0;
  const resolver = new NominatimPlaceResolver({
    endpoint: "https://geo.example.test/search",
    userAgent: "t",
    minIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } })
        : new Response(SEATTLE, { status: 200 });
    },
  });
  const result = await resolver.forwardGeocode("Seattle");
  assert.equal(result.length, 1);
  assert.equal(calls, 2);

  let failures = 0;
  const failing = new NominatimPlaceResolver({
    endpoint: "https://geo.example.test/search",
    userAgent: "t",
    minIntervalMs: 0,
    fetchImpl: async () => {
      failures += 1;
      return new Response("boom", { status: 500 });
    },
  });
  await assert.rejects(failing.forwardGeocode("X"), /status 500/);
  await assert.rejects(failing.forwardGeocode("X"), /status 500/);
  assert.equal(failures, 2, "a failure must not be cached");
});

test("Nominatim resolver spaces upstream requests by the minimum interval", async () => {
  const stamps: number[] = [];
  const resolver = new NominatimPlaceResolver({
    endpoint: "https://geo.example.test/search",
    userAgent: "t",
    minIntervalMs: 60,
    fetchImpl: async () => {
      stamps.push(Date.now());
      return new Response(SEATTLE, { status: 200 });
    },
  });
  await Promise.all([resolver.forwardGeocode("A"), resolver.forwardGeocode("B"), resolver.forwardGeocode("C")]);
  // Individual gaps shrink when an earlier request wakes late, but the third
  // request can never start before two full intervals after the first.
  assert.equal(stamps.length, 3);
  assert.ok(stamps[2]! - stamps[0]! >= 115, `span: ${stamps.join(",")}`);
  assert.ok(stamps[1]! - stamps[0]! >= 55, `first gap: ${stamps.join(",")}`);
});
