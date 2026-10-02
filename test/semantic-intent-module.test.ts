import { strict as assert } from "node:assert";
import test from "node:test";

import {
  SemanticIntentModule,
  type PlaceResolver,
  type TdeiOperations,
} from "../src/intents/semantic-intent-module.js";

function createHarness(
  datasetResponses: Array<Array<Record<string, unknown>>>,
  placeResponses: Array<Array<{
    label: string;
    bbox: [number, number, number, number];
  }>> = [],
  serviceResponses: Array<Array<Record<string, unknown>>> = [],
) {
  const searches: Array<Record<string, unknown>> = [];
  const serviceSearches: Array<Record<string, unknown>> = [];
  const operations: TdeiOperations = {
    async searchDatasets(input) {
      searches.push(input as unknown as Record<string, unknown>);
      return datasetResponses.shift() ?? [];
    },
    async listServices(input) {
      serviceSearches.push(input as unknown as Record<string, unknown>);
      return serviceResponses.shift() ?? [];
    },
  };
  const geocodes: string[] = [];
  const places: PlaceResolver = {
    async forwardGeocode(place) {
      geocodes.push(place);
      return placeResponses.shift() ?? [];
    },
  };

  return {
    module: new SemanticIntentModule({ operations, places }),
    searches,
    serviceSearches,
    geocodes,
  };
}

test("latest dataset name match completes without geographic fallback", async () => {
  const seattle = {
    tdei_dataset_id: "dataset-1",
    name: "Seattle Accessible Sidewalks",
    uploaded_timestamp: "2026-09-30T12:00:00Z",
  };
  const harness = createHarness([[seattle]]);

  const result = await harness.module.findDatasets({
    place: "Seattle",
    dataType: "osw",
    latest: true,
  });

  assert.deepEqual(result, {
    status: "complete",
    data: {
      matches: [{ dataset: seattle, matchedBy: "name", evidence: "name contains Seattle" }],
      selected: seattle,
      effectiveSort: { field: "uploaded_timestamp", order: "desc" },
    },
  });
  assert.deepEqual(harness.searches, [{
    name: "Seattle",
    dataType: "osw",
    status: "All",
    sortField: "uploaded_timestamp",
    sortOrder: "desc",
    page: 1,
    pageSize: 10,
  }]);
  assert.deepEqual(harness.geocodes, []);
});

test("dataset search falls back from name to city before geocoding", async () => {
  const cityDataset = {
    tdei_dataset_id: "dataset-2",
    name: "Downtown curb ramps",
    city: "Seattle",
  };
  const harness = createHarness([[], [cityDataset]]);

  const result = await harness.module.findDatasets({ place: "Seattle" });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.matches, [{
    dataset: cityDataset,
    matchedBy: "city",
    evidence: "city contains Seattle",
  }]);
  assert.deepEqual(harness.searches.map((search) => ({
    name: search.name,
    city: search.city,
  })), [
    { name: "Seattle", city: undefined },
    { name: undefined, city: "Seattle" },
  ]);
  assert.deepEqual(harness.geocodes, []);
});

test("ambiguous place candidates are returned without a bbox search", async () => {
  const harness = createHarness([[], []], [[
    { label: "Seattle, Washington, USA", bbox: [-122.46, 47.48, -122.22, 47.74] },
    { label: "Seattle, Nova Scotia, Canada", bbox: [-64.2, 44.3, -63.9, 44.6] },
  ]]);

  const result = await harness.module.findDatasets({ place: "Seattle" });

  assert.deepEqual(result, {
    status: "ambiguous",
    candidates: [
      { label: "Seattle, Washington, USA", bbox: [-122.46, 47.48, -122.22, 47.74] },
      { label: "Seattle, Nova Scotia, Canada", bbox: [-64.2, 44.3, -63.9, 44.6] },
    ],
    accepted: { place: "Seattle" },
  });
  assert.equal(harness.searches.length, 2);
  assert.deepEqual(harness.geocodes, ["Seattle"]);
});

test("one resolved place falls back to a bounding-box dataset search", async () => {
  const bbox: [number, number, number, number] = [-122.46, 47.48, -122.22, 47.74];
  const nearby = { tdei_dataset_id: "dataset-3", name: "King County OSW" };
  const harness = createHarness([[], [], [nearby]], [[
    { label: "Seattle, Washington, USA", bbox },
  ]]);

  const result = await harness.module.findDatasets({ place: "Seattle", latest: true });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.matches, [{
    dataset: nearby,
    matchedBy: "bbox",
    evidence: "bbox for Seattle, Washington, USA",
  }]);
  assert.equal(result.data.selected, nearby);
  assert.deepEqual(harness.searches[2]?.bbox, bbox);
});

test("an explicit bounding box searches without requiring a place", async () => {
  const bbox: [number, number, number, number] = [-122.5, 47.4, -122.1, 47.8];
  const dataset = { tdei_dataset_id: "dataset-4" };
  const harness = createHarness([[dataset]]);

  const result = await harness.module.findDatasets({ bbox });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.matches[0]?.matchedBy, "bbox");
  assert.deepEqual(harness.searches[0]?.bbox, bbox);
  assert.deepEqual(harness.geocodes, []);
});

test("a project-group filter searches without requiring a place", async () => {
  const dataset = { tdei_dataset_id: "dataset-5" };
  const harness = createHarness([[dataset]]);
  const result = await harness.module.findDatasets({ projectGroupId: "group-1" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.matches[0]?.matchedBy, "project_group");
  assert.equal(harness.searches[0]?.projectGroupId, "group-1");
});

test("service listing returns normalized filters and results", async () => {
  const service = { tdei_service_id: "service-1", service_type: "osw" };
  const harness = createHarness([], [], [[service]]);

  const result = await harness.module.listServices({
    searchText: "sidewalk",
    projectGroupId: "group-1",
    serviceType: "osw",
    pageSize: 25,
  });

  assert.deepEqual(result, {
    status: "complete",
    data: {
      services: [service],
      appliedFilters: {
        searchText: "sidewalk",
        projectGroupId: "group-1",
        serviceType: "osw",
        page: 1,
        pageSize: 25,
      },
    },
  });
  assert.deepEqual(harness.serviceSearches, [{
    searchText: "sidewalk",
    projectGroupId: "group-1",
    serviceType: "osw",
    page: 1,
    pageSize: 25,
  }]);
});

test("project-group membership reports the missing upstream capability", async () => {
  const harness = createHarness([]);

  const result = await harness.module.listMyProjectGroups();

  assert.deepEqual(result, {
    status: "unsupported",
    reason: "The published TDEI API can list all project groups but cannot list only the authenticated user's memberships.",
    requiredCapability: "GET /api/v1/me/project-groups or GET /api/v1/project-groups?include_my_groups=true",
  });
  assert.deepEqual(harness.searches, []);
  assert.deepEqual(harness.serviceSearches, []);
});
