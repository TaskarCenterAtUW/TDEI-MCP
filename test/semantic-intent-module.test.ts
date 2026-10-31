import { strict as assert } from "node:assert";
import test from "node:test";

import {
  SemanticIntentModule,
  type PlaceResolver,
  type TdeiOperations,
} from "../src/intents/semantic-intent-module.js";

function createHarness(
  datasetResponses: Array<Array<Record<string, unknown>>>,
  placeResponses: Array<
    Array<{
      label: string;
      bbox: [number, number, number, number];
    }>
  > = [],
  serviceResponses: Array<Array<Record<string, unknown>>> = [],
  projectGroupResponses: Array<Array<Record<string, unknown>>> = [],
) {
  const searches: Array<Record<string, unknown>> = [];
  const serviceSearches: Array<Record<string, unknown>> = [];
  const projectGroupSearches: Array<Record<string, unknown>> = [];
  const operations: TdeiOperations = {
    async searchDatasets(input) {
      searches.push(input as unknown as Record<string, unknown>);
      return datasetResponses.shift() ?? [];
    },
    async listServices(input) {
      serviceSearches.push(input as unknown as Record<string, unknown>);
      return serviceResponses.shift() ?? [];
    },
    async listProjectGroups(input, context) {
      projectGroupSearches.push({ ...input, accessToken: context.accessToken });
      return projectGroupResponses.shift() ?? [];
    },
    async listJobs() {
      return [];
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
    projectGroupSearches,
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
  assert.deepEqual(harness.searches, [
    {
      name: "Seattle",
      dataType: "osw",
      status: "All",
      sortField: "uploaded_timestamp",
      sortOrder: "desc",
      page: 1,
      pageSize: 10,
    },
  ]);
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
  assert.deepEqual(result.data.matches, [
    {
      dataset: cityDataset,
      matchedBy: "city",
      evidence: "city contains Seattle",
    },
  ]);
  assert.deepEqual(
    harness.searches.map((search) => ({
      name: search.name,
      city: search.city,
    })),
    [
      { name: "Seattle", city: undefined },
      { name: undefined, city: "Seattle" },
    ],
  );
  assert.deepEqual(harness.geocodes, []);
});

test("ambiguous place candidates are returned without a bbox search", async () => {
  const harness = createHarness(
    [[], []],
    [
      [
        { label: "Seattle, Washington, USA", bbox: [-122.46, 47.48, -122.22, 47.74] },
        { label: "Seattle, Nova Scotia, Canada", bbox: [-64.2, 44.3, -63.9, 44.6] },
      ],
    ],
  );

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
  const harness = createHarness([[], [], [nearby]], [[{ label: "Seattle, Washington, USA", bbox }]]);

  const result = await harness.module.findDatasets({ place: "Seattle", latest: true });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.matches, [
    {
      dataset: nearby,
      matchedBy: "bbox",
      evidence: "bbox for Seattle, Washington, USA",
    },
  ]);
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
      apiOperation: "listServices",
      method: "GET",
      path: "/api/v1/services",
    },
  });
  assert.deepEqual(harness.serviceSearches, [
    {
      searchText: "sidewalk",
      projectGroupId: "group-1",
      serviceType: "osw",
      page: 1,
      pageSize: 25,
    },
  ]);
});

test("project-group membership lists groups visible to the authenticated login", async () => {
  const groups = [{ tdei_project_group_id: "group-1", name: "Accessible Seattle" }];
  const harness = createHarness([], [], [], [groups]);

  const result = await harness.module.listMyProjectGroups({}, { accessToken: "authenticated-login" });

  assert.deepEqual(result, {
    status: "complete",
    data: {
      projectGroups: groups,
      appliedFilters: { page: 1, pageSize: 50 },
      accessScope: "authenticated_user",
      scopeExplanation:
        "These are all project groups visible to your login (an admin login sees all groups), NOT confirmed membership. TDEI reports only poc contacts per group, not members. For your login email call tdei_get_my_identity. For full membership check the TDEI portal user/role screen. Use searchText to narrow, do not POC-filter.",
      apiOperation: "listProjectGroups",
      method: "GET",
      path: "/api/v1/project-groups",
    },
  });
  assert.deepEqual(harness.searches, []);
  assert.deepEqual(harness.serviceSearches, []);
  assert.deepEqual(harness.projectGroupSearches, [
    {
      page: 1,
      pageSize: 50,
      accessToken: "authenticated-login",
    },
  ]);
});

test("dataset lookup by id uses tdei_dataset_id with dataset_id evidence", async () => {
  const dataset = {
    tdei_dataset_id: "abc-123",
    name: "Seattle OSW",
    status: "Publish",
    uploaded_timestamp: "2026-09-30T12:00:00Z",
  };
  const harness = createHarness([[dataset]]);

  const result = await harness.module.findDatasets({ tdeiDatasetId: "abc-123" });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.data.matches, [
    {
      dataset,
      matchedBy: "dataset_id",
      evidence: "tdei_dataset_id = abc-123",
    },
  ]);
  assert.equal(harness.searches[0]?.tdeiDatasetId, "abc-123");
});

test("recent-upload filter drops datasets older than the cutoff", async () => {
  const fresh = { tdei_dataset_id: "new", uploaded_timestamp: new Date(Date.now() - 86_400_000).toISOString() };
  const stale = { tdei_dataset_id: "old", uploaded_timestamp: "2020-01-01T00:00:00Z" };
  const harness = createHarness([[[fresh, stale]].flat()]);

  const result = await harness.module.findDatasets({ place: "Seattle", uploadedWithinDays: 7 });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(
    result.data.matches.map((match) => (match.dataset as Record<string, unknown>).tdei_dataset_id),
    ["new"],
  );
});

test("jobs fan out across project groups when no group is given", async () => {
  const jobSearches: Array<Record<string, unknown>> = [];
  const groups = [
    { tdei_project_group_id: "group-1", name: "One" },
    { tdei_project_group_id: "group-2", name: "Two" },
  ];
  const operations: TdeiOperations = {
    async searchDatasets() {
      return [];
    },
    async listServices() {
      return [];
    },
    async listProjectGroups() {
      return groups;
    },
    async listJobs(input) {
      jobSearches.push(input as unknown as Record<string, unknown>);
      return [{ job_id: 1, tdei_project_group_id: input.projectGroupId, created_at: new Date().toISOString() }];
    },
  };
  const module = new SemanticIntentModule({
    operations,
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });

  const result = await module.listJobs({ limit: 10 });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.jobs.length, 2);
  assert.deepEqual(jobSearches.map((search) => search.projectGroupId).sort(), ["group-1", "group-2"]);
  assert.deepEqual(result.data.appliedFilters.searchedProjectGroups.sort(), ["group-1", "group-2"]);
});

test("dataset details include status and the incline follow-up note", async () => {
  const dataset = { tdei_dataset_id: "abc-123", status: "Publish" };
  const harness = createHarness([[dataset]]);

  const result = await harness.module.getDatasetDetails({ tdeiDatasetId: "abc-123" });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.matches[0]?.dataset, dataset);
  assert.match(result.data.inclineNote, /getOswFile/);
});

test("identity falls back to decoding the request access token", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      preferred_username: "jane",
      email: "jane@example.com",
      realm_access: { roles: ["tdei-user"] },
    }),
  ).toString("base64url");
  const harness = createHarness([]);

  const result = await harness.module.getMyIdentity({ accessToken: `${header}.${payload}.sig` });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.authenticated, true);
  assert.deepEqual(result.data.identity?.roles, ["tdei-user"]);
  assert.equal(result.data.identity?.email, "jane@example.com");
});

test("destructive operations require explicit confirm:true", async () => {
  const operations: TdeiOperations = {
    async searchDatasets() {
      return [];
    },
    async listServices() {
      return [];
    },
    async listProjectGroups() {
      return [];
    },
  };
  const module = new SemanticIntentModule({
    operations,
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });
  const metadata = { name: "copy", version: "v1" };

  const results = await Promise.all([
    module.deleteDataset({ tdeiDatasetId: "abc" }),
    module.cloneDataset({ tdeiDatasetId: "a", projectGroupId: "g", serviceId: "s", metadata }),
    module.editMetadata({ tdeiDatasetId: "a", metadata }),
    module.unionDatasets({ tdeiDatasetIdOne: "a", tdeiDatasetIdTwo: "b" }),
    module.regenerateApiKey({}),
  ]);

  for (const result of results) {
    assert.equal(result.status, "needs_input");
    if (result.status !== "needs_input") continue;
    assert.equal(result.missing[0]?.field, "confirm");
  }
});

test("confirmed delete reaches the adapter and completes", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const operations: TdeiOperations = {
    async searchDatasets() {
      return [];
    },
    async listServices() {
      return [];
    },
    async listProjectGroups() {
      return [];
    },
    async deleteDataset(input) {
      calls.push(input as unknown as Record<string, unknown>);
      return "dataset abc deleted";
    },
  };
  const module = new SemanticIntentModule({
    operations,
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });

  const result = await module.deleteDataset({ tdeiDatasetId: "abc", confirm: true });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data, "dataset abc deleted");
  assert.deepEqual(calls, [{ tdeiDatasetId: "abc" }]);
});

test("per-op job wrappers fan out to launchJob with the right operation and params", async () => {
  const launches: Array<Record<string, unknown>> = [];
  const operations: TdeiOperations = {
    async searchDatasets() {
      return [];
    },
    async listServices() {
      return [];
    },
    async listProjectGroups() {
      return [];
    },
    async launchJob(input) {
      launches.push(JSON.parse(JSON.stringify(input)) as Record<string, unknown>);
      return { job_id: "job-1" };
    },
  };
  const module = new SemanticIntentModule({
    operations,
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });

  const results = await Promise.all([
    module.tagRoad({ sourceDatasetId: "src", targetDatasetId: "tgt" }),
    module.cutDatasetBbox({ tdeiDatasetId: "abc", fileType: "osw", bbox: [1, 2, 3, 4] }),
    module.selfMerge({ tdeiDatasetId: "abc", proximity: 1 }),
    module.unionDatasets({ tdeiDatasetIdOne: "a", tdeiDatasetIdTwo: "b", confirm: true }),
    module.calculateConfidence({ tdeiDatasetId: "abc" }),
  ]);
  for (const result of results) {
    assert.equal(result.status, "complete");
  }

  const byOp = new Map(launches.map((launch) => [launch.operation, launch]));
  assert.deepEqual(byOp.get("datasetTagRoad")?.query, {
    source_dataset_id: "src",
    target_dataset_id: "tgt",
  });
  assert.deepEqual(byOp.get("datasetBbox")?.query, {
    tdei_dataset_id: "abc",
    file_type: "osw",
    bbox: [1, 2, 3, 4],
  });
  assert.deepEqual(byOp.get("osw-self-merge")?.body, {
    tdei_dataset_id: "abc",
    proximity: 1,
  });
  assert.deepEqual(byOp.get("osw-union")?.body, {
    tdei_dataset_id_one: "a",
    tdei_dataset_id_two: "b",
  });
  assert.equal(byOp.get("oswConfidenceCalculate")?.tdeiDatasetId, "abc");
});

/** Minimal stored (uncompressed) ZIP builder; CRC is zeroed (the scanner never verifies it). */
function buildStoredZip(entries: Array<{ name: string; content: string }>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, "utf-8");
    const data = Buffer.from(content, "utf-8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  chunks.push(cd);
  offset += cd.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  return new Uint8Array(Buffer.concat(chunks));
}

test("incline scan finds incline tags in stored edges files", async () => {
  const { scanZipForIncline } = await import("../src/intents/incline-scan.js");

  const withIncline = scanZipForIncline(
    buildStoredZip([
      { name: "edges.geojson", content: `{"type":"Feature","properties":{"incline":0.05},"geometry":null}` },
      { name: "nodes.geojson", content: `{"type":"FeatureCollection","features":[]}` },
    ]),
  );
  assert.equal(withIncline.hasIncline, true);
  assert.deepEqual(withIncline.checkedFiles, ["edges.geojson"]);
  assert.match(withIncline.evidence, /incline/i);

  const withoutIncline = scanZipForIncline(
    buildStoredZip([
      { name: "edges.geojson", content: `{"type":"Feature","properties":{"highway":"footway"},"geometry":null}` },
    ]),
  );
  assert.equal(withoutIncline.hasIncline, false);
  assert.deepEqual(withoutIncline.checkedFiles, ["edges.geojson"]);

  const noEdges = scanZipForIncline(buildStoredZip([{ name: "nodes.geojson", content: "{}" }]));
  assert.equal(noEdges.hasIncline, false);
  assert.deepEqual(noEdges.checkedFiles, []);
});

test("checkDatasetIncline downloads the ZIP and returns a verdict", async () => {
  const zip = buildStoredZip([{ name: "edges.geojson", content: `{"properties":{"incline":0.02}}` }]);
  const downloads: Array<Record<string, unknown>> = [];
  const operations: TdeiOperations = {
    async searchDatasets() {
      return [{ tdei_dataset_id: "abc", data_type: "osw" }];
    },
    async listServices() {
      return [];
    },
    async listProjectGroups() {
      return [];
    },
    async downloadFileBytes(input) {
      downloads.push(input as unknown as Record<string, unknown>);
      return zip;
    },
  };
  const module = new SemanticIntentModule({
    operations,
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });

  const result = await module.checkDatasetIncline({ tdeiDatasetId: "abc" });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.tdeiDatasetId, "abc");
  assert.equal(result.data.dataType, "osw");
  assert.equal(result.data.hasIncline, true);
  assert.deepEqual(result.data.checkedFiles, ["edges.geojson"]);
  assert.deepEqual(downloads, [{ dataType: "osw", tdeiDatasetId: "abc" }]);
});
