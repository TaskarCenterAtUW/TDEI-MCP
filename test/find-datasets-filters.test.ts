import { strict as assert } from "node:assert";
import test from "node:test";

import type { TdeiOperations } from "../src/intents/operations.js";
import { SemanticIntentModule, type PlaceResolver } from "../src/intents/semantic-intent-module.js";
import { HttpTdeiOperations } from "../src/adapters/http-tdei-operations.js";

/** Live API shape: name/version live under metadata.dataset_detail. */
function datasetRow(name: string, version: string, uploaded: string, id: string) {
  return {
    tdei_dataset_id: id,
    uploaded_timestamp: uploaded,
    metadata: { dataset_detail: { name, version } },
  };
}

function createHarness(datasetResponses: Array<Array<Record<string, unknown>>>) {
  const searches: Array<Record<string, unknown>> = [];
  const operations: TdeiOperations = {
    async searchDatasets(input) {
      searches.push(input as unknown as Record<string, unknown>);
      return datasetResponses.shift() ?? [];
    },
    async listServices() {
      return [];
    },
    async listProjectGroups() {
      return [];
    },
    async listJobs() {
      return [];
    },
  };
  const places: PlaceResolver = {
    async forwardGeocode() {
      return [];
    },
  };
  return { module: new SemanticIntentModule({ operations, places }), searches };
}

const FRESH = new Date(Date.now() - 3_600_000).toISOString();
const STALE = "2020-01-01T00:00:00.000Z";

function fullPage(prefix: string, uploaded: string, count = 50) {
  return Array.from({ length: count }, (_, index) =>
    datasetRow(`${prefix}_${index + 1}`, "1.0", uploaded, `${prefix}-${index + 1}`),
  );
}

test("project group + service are sent together so the API ANDs them", async () => {
  const harness = createHarness([[datasetRow("A", "1.0", FRESH, "a-1")]]);

  const result = await harness.module.findDatasets({ projectGroupId: "group-1", serviceId: "service-1" });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  // One short first page ends the scan: a single parallel window of 5 calls.
  assert.equal(harness.searches.length, 5);
  for (const search of harness.searches) {
    assert.equal(search.projectGroupId, "group-1");
    assert.equal(search.serviceId, "service-1");
  }
  assert.equal(result.data.matches[0]?.matchedBy, "project_group");
  assert.equal(result.data.matches[0]?.evidence, "project group group-1 + service service-1");
});

test("extra user details become server-side API filters on scans", async () => {
  const harness = createHarness([[datasetRow("A", "1.0", FRESH, "a-1")]]);

  const result = await harness.module.findDatasets({
    projectGroupId: "group-1",
    serviceId: "service-1",
    version: "1.0",
    dataSource: "TDEITools",
    collectionMethod: "manual",
    collectedBy: "City of Seattle",
    derivedFromDatasetId: "parent-1",
    collectionDate: "2026-01-01T00:00:00Z",
    confidenceLevel: 80,
    schemaVersion: "0.3",
    validFrom: "2026-01-01T00:00:00Z",
    validTo: "2027-01-01T00:00:00Z",
    city: "Seattle",
    county: "King",
    region: "WA",
  });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  const first = harness.searches[0] as Record<string, unknown>;
  assert.equal(first.version, "1.0");
  assert.equal(first.dataSource, "TDEITools");
  assert.equal(first.collectionMethod, "manual");
  assert.equal(first.collectedBy, "City of Seattle");
  assert.equal(first.derivedFromDatasetId, "parent-1");
  assert.equal(first.collectionDate, "2026-01-01T00:00:00Z");
  assert.equal(first.confidenceLevel, 80);
  assert.equal(first.schemaVersion, "0.3");
  assert.equal(first.validFrom, "2026-01-01T00:00:00Z");
  assert.equal(first.validTo, "2027-01-01T00:00:00Z");
  assert.equal(first.city, "Seattle");
  assert.equal(first.county, "King");
  assert.equal(first.region, "WA");
});

test("extra user details are also sent on single-page place searches", async () => {
  const seattle = { tdei_dataset_id: "dataset-1", name: "Seattle Sidewalks" };
  const harness = createHarness([[seattle]]);

  const result = await harness.module.findDatasets({ place: "Seattle", version: "2.0", city: "Seattle" });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(harness.searches[0]?.name, "Seattle");
  assert.equal(harness.searches[0]?.version, "2.0");
  assert.equal(harness.searches[0]?.city, "Seattle");
});

test("a place given with a project group narrows the scan by name server-side", async () => {
  const harness = createHarness([[datasetRow("Seattle A", "1.0", FRESH, "a-1")]]);

  const result = await harness.module.findDatasets({ projectGroupId: "group-1", place: "Seattle" });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(harness.searches[0]?.projectGroupId, "group-1");
  assert.equal(harness.searches[0]?.name, "Seattle");
  assert.equal(result.data.matches[0]?.evidence, "project group group-1 + name contains Seattle");
});

test("date-filtered scans stop paging once pages predate the cutoff", async () => {
  const harness = createHarness([
    fullPage("fresh1", FRESH),
    fullPage("fresh2", FRESH),
    fullPage("fresh3", FRESH),
    fullPage("fresh4", FRESH),
    fullPage("stale5", STALE),
  ]);

  const result = await harness.module.findDatasets({ projectGroupId: "group-1", uploadedWithinDays: 1 });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  // One window of 5 parallel calls; no second window is fetched.
  assert.equal(harness.searches.length, 5);
  assert.equal(result.data.scan?.pagesRead, 5);
  assert.equal(result.data.scan?.datasetsScanned, 250);
  assert.equal(result.data.scan?.stoppedEarly, true);
  assert.match(result.data.scan?.note ?? "", /stopped early/);
  // Only today's uploads survive; the default limit shows the first 10.
  assert.equal(result.data.matches.length, 10);
  for (const match of result.data.matches) {
    const uploaded = (match.dataset as Record<string, unknown>).uploaded_timestamp as string;
    assert.ok(Date.parse(uploaded) >= Date.now() - 2 * 86_400_000, `stale row leaked: ${uploaded}`);
  }
});

test("scans keep paging while pages still hold fresh uploads", async () => {
  const harness = createHarness([
    fullPage("fresh1", FRESH),
    fullPage("fresh2", FRESH),
    fullPage("fresh3", FRESH),
    fullPage("fresh4", FRESH),
    fullPage("fresh5", FRESH),
    fullPage("fresh6", FRESH, 2),
  ]);

  const result = await harness.module.findDatasets({ projectGroupId: "group-1", uploadedWithinDays: 1 });

  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  // Window 2 (pages 6-10) is fetched because page 5 is still fresh.
  assert.equal(harness.searches.length, 10);
  assert.equal(result.data.scan?.pagesRead, 6);
  assert.equal(result.data.scan?.datasetsScanned, 252);
  assert.equal(result.data.scan?.stoppedEarly, false);
});

test("HTTP adapter maps the new filters to snake_case query params", async () => {
  const requests: Request[] = [];
  const adapter = new HttpTdeiOperations("https://api.example.test", async (input, init) => {
    requests.push(new Request(input, init));
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });

  await adapter.searchDatasets(
    {
      status: "All",
      projectGroupId: "group-1",
      serviceId: "service-1",
      version: "1.0",
      dataSource: "TDEITools",
      collectionMethod: "manual",
      collectedBy: "City of Seattle",
      derivedFromDatasetId: "parent-1",
      collectionDate: "2026-01-01T00:00:00Z",
      confidenceLevel: 80,
      schemaVersion: "0.3",
      validFrom: "2026-01-01T00:00:00Z",
      validTo: "2027-01-01T00:00:00Z",
      city: "Seattle",
      county: "King",
      region: "WA",
      sortField: "uploaded_timestamp",
      sortOrder: "desc",
      page: 1,
      pageSize: 50,
    },
    { accessToken: "bearer-A" },
  );

  assert.equal(requests.length, 1);
  const params = new URL((requests[0] as Request).url).searchParams;
  assert.equal(params.get("tdei_project_group_id"), "group-1");
  assert.equal(params.get("tdei_service_id"), "service-1");
  assert.equal(params.get("version"), "1.0");
  assert.equal(params.get("data_source"), "TDEITools");
  assert.equal(params.get("collection_method"), "manual");
  assert.equal(params.get("collected_by"), "City of Seattle");
  assert.equal(params.get("derived_from_dataset_id"), "parent-1");
  assert.equal(params.get("collection_date"), "2026-01-01T00:00:00Z");
  assert.equal(params.get("confidence_level"), "80");
  assert.equal(params.get("schema_version"), "0.3");
  assert.equal(params.get("valid_from"), "2026-01-01T00:00:00Z");
  assert.equal(params.get("valid_to"), "2027-01-01T00:00:00Z");
  assert.equal(params.get("city"), "Seattle");
  assert.equal(params.get("county"), "King");
  assert.equal(params.get("region"), "WA");
});
