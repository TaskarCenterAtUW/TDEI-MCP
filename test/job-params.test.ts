import { strict as assert } from "node:assert";
import test from "node:test";

import type { TdeiOperations } from "../src/intents/operations.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";
import type { DatasetAsset, RequestContext } from "../src/intents/types.js";

type LaunchInput = NonNullable<Parameters<NonNullable<TdeiOperations["launchJob"]>>[0]>;

const URL_ASSET: DatasetAsset = { kind: "url", url: "https://example.com/a.zip" };

function createHarness() {
  const launches: LaunchInput[] = [];
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
      launches.push(input as LaunchInput);
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
  return { module, launches };
}

async function launchOnce(call: (module: SemanticIntentModule) => Promise<unknown>): Promise<LaunchInput> {
  const { module, launches } = createHarness();
  const result = (await call(module)) as { status: string };
  assert.equal(result.status, "complete");
  assert.equal(launches.length, 1);
  return launches[0] as LaunchInput;
}

test("job fan-out matrix covers all 13 per-op wrappers", async () => {
  const confidence = await launchOnce((m) => m.calculateConfidence({ tdeiDatasetId: "abc" }));
  assert.equal(confidence.operation, "oswConfidenceCalculate");
  assert.equal(confidence.tdeiDatasetId, "abc");
  assert.ok(!("assets" in confidence));

  const confidenceFile = await launchOnce((m) =>
    m.calculateConfidence({ tdeiDatasetId: "abc", subRegionAsset: URL_ASSET }),
  );
  assert.deepEqual(confidenceFile.assets, { file: URL_ASSET });

  const intersection = await launchOnce((m) => m.calculateQualityIntersection({ tdeiDatasetId: "abc" }));
  assert.equal(intersection.operation, "oswQualityCalculate");
  assert.ok(!("assets" in intersection));

  const tag = await launchOnce((m) => m.tagQualityMetric({ tdeiDatasetId: "abc", tagQualityAsset: URL_ASSET }));
  assert.equal(tag.operation, "qualityMetricTag");
  assert.deepEqual(tag.assets, { file: URL_ASSET });

  const report = await launchOnce((m) => m.generateQualityReport({ tdeiDatasetId: "abc" }));
  assert.equal(report.operation, "oswQualityReportGenerate");
  assert.equal(report.tdeiDatasetId, "abc");

  const sanitize = await launchOnce((m) => m.sanitizeDataset({ asset: URL_ASSET }));
  assert.equal(sanitize.operation, "sanitizeOswFile");
  assert.ok(!("tdeiDatasetId" in sanitize));
  assert.deepEqual(sanitize.assets, { dataset: URL_ASSET });

  const convert = await launchOnce((m) => m.convertOsw({ asset: URL_ASSET, sourceFormat: "osm", targetFormat: "osw" }));
  assert.equal(convert.operation, "oswOnDemandFormat");
  assert.deepEqual(convert.assets, { file: URL_ASSET });
  assert.deepEqual(convert.fields, { source_format: "osm", target_format: "osw" });

  const pathwaysUrl = await launchOnce((m) =>
    m.convertPathways({ arcgisUrl: "https://example.com/arcgis/rest/services/x/MapServer", layers: "7-19" }),
  );
  assert.equal(pathwaysUrl.operation, "convertGtfsPathways");
  assert.deepEqual(pathwaysUrl.fields, {
    arcgis_url: "https://example.com/arcgis/rest/services/x/MapServer",
    layers: "7-19",
  });

  const selfMerge = await launchOnce((m) => m.selfMerge({ tdeiDatasetId: "abc", proximity: 1 }));
  assert.equal(selfMerge.operation, "osw-self-merge");
  assert.deepEqual(selfMerge.body, { tdei_dataset_id: "abc", proximity: 1 });

  const join = await launchOnce((m) =>
    m.spatialJoin({
      targetDatasetId: "tgt",
      targetDimension: "edge",
      sourceDatasetId: "src",
      sourceDimension: "node",
      joinCondition: "intersects",
    }),
  );
  assert.equal(join.operation, "osw-spatial-join");
  assert.deepEqual(join.body, {
    target_dataset_id: "tgt",
    target_dimension: "edge",
    source_dataset_id: "src",
    source_dimension: "node",
    join_condition: "intersects",
  });

  const union = await launchOnce((m) =>
    m.unionDatasets({ tdeiDatasetIdOne: "a", tdeiDatasetIdTwo: "b", confirm: true }),
  );
  assert.equal(union.operation, "osw-union");
  assert.deepEqual(union.body, { tdei_dataset_id_one: "a", tdei_dataset_id_two: "b" });

  const bbox = await launchOnce((m) => m.cutDatasetBbox({ tdeiDatasetId: "abc", fileType: "osw", bbox: [1, 2, 3, 4] }));
  assert.equal(bbox.operation, "datasetBbox");
  assert.deepEqual(bbox.query, { tdei_dataset_id: "abc", file_type: "osw", bbox: [1, 2, 3, 4] });

  const road = await launchOnce((m) => m.tagRoad({ sourceDatasetId: "src", targetDatasetId: "tgt" }));
  assert.equal(road.operation, "datasetTagRoad");
  assert.deepEqual(road.query, { source_dataset_id: "src", target_dataset_id: "tgt" });

  const incline = await launchOnce((m) => m.tagIncline({ tdeiDatasetId: "abc" }));
  assert.equal(incline.operation, "datasetTagIncline");
  assert.equal(incline.tdeiDatasetId, "abc");
});

test("optional job fields are omitted when not provided", async () => {
  const { module, launches } = createHarness();
  const context: RequestContext = {};
  assert.equal((await module.selfMerge({ tdeiDatasetId: "abc" }, context)).status, "complete");
  assert.deepEqual(launches[0]?.body, { tdei_dataset_id: "abc" });

  assert.equal(
    (await module.spatialJoin({ targetDatasetId: "tgt", targetDimension: "zone", sourceDatasetId: "src" }, context))
      .status,
    "complete",
  );
  assert.deepEqual(launches[1]?.body, {
    target_dataset_id: "tgt",
    target_dimension: "zone",
    source_dataset_id: "src",
  });

  assert.equal((await module.convertPathways({ datasetAsset: URL_ASSET }, context)).status, "complete");
  assert.deepEqual(launches[2]?.assets, { dataset: URL_ASSET });
  assert.ok(!("fields" in (launches[2] as LaunchInput)));
});
