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
      return new Response(JSON.stringify([{
        place_id: 237385,
        display_name: "Seattle, King County, Washington, USA",
        importance: 0.72,
        boundingbox: ["47.481", "47.734", "-122.459", "-122.224"],
      }]), { status: 200 });
    },
  });

  const candidates = await resolver.forwardGeocode("Seattle");

  assert.deepEqual(candidates, [{
    label: "Seattle, King County, Washington, USA",
    bbox: [-122.459, 47.481, -122.224, 47.734],
    confidence: 0.72,
    providerId: "237385",
  }]);
  assert.equal(request?.headers.get("User-Agent"), "tdei-mcp-tests/1.0");
  assert.equal(request?.url, "https://geo.example.test/search?q=Seattle&format=jsonv2&limit=5");
});
