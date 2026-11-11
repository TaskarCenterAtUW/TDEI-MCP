import assert from "node:assert/strict";
import test from "node:test";

import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

type Row = Record<string, unknown>;

function dataset(
  name: string,
  version: string,
  uploaded: string,
  options: { id?: string; custom?: Row; metadata?: unknown; service?: string } = {},
): Row {
  return {
    tdei_dataset_id: options.id ?? `${name}:${version}:${uploaded}`,
    status: "Publish",
    service: options.service ?? "TCAT_WA_Proviso",
    data_type: "osw",
    uploaded_timestamp: uploaded,
    metadata:
      options.metadata ??
      ({
        dataset_detail: {
          name,
          version,
          custom_metadata: options.custom ?? {},
        },
      } as Row),
  };
}

const REPORT = {
  tcat_quality_report_url_pdf: "https://qualityreports.example/pdf",
  tcat_quality_report_url_html: "https://qualityreports.example/html",
  tcat_quality_report_code: "abc123",
};

function harness(pages: Record<number, Row[]>) {
  const calls: Array<{ page: number; pageSize: number; serviceId?: string; projectGroupId?: string }> = [];
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets(input) {
        calls.push({
          page: input.page,
          pageSize: input.pageSize,
          ...(input.serviceId ? { serviceId: input.serviceId } : {}),
          ...(input.projectGroupId ? { projectGroupId: input.projectGroupId } : {}),
        });
        return pages[input.page] ?? [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [{ tdei_project_group_id: "g1", project_group_name: "TCAT WSP" }];
      },
      async listJobs() {
        return [];
      },
    },
    places: { forwardGeocode: async () => [] },
  });
  return { module, calls };
}

test("tcat QA/QC inventory scans all pages, dedupes numerically and keeps the newest upload", async () => {
  const fillers = Array.from({ length: 48 }, (_, index) =>
    dataset(`Filler_${index + 1}`, "1.0", "2026-01-01T00:00:00.000Z", { custom: REPORT }),
  );
  const page1 = [
    dataset("WSP_City_A", "1.9", "2026-01-01T00:00:00.000Z", { id: "a-v19", custom: REPORT }),
    dataset("WSP_City_B", "1.0", "2026-02-01T00:00:00.000Z", { id: "b-old", custom: REPORT }),
    ...fillers,
  ];
  const page2 = [
    dataset("WSP_City_A", "1.10", "2025-12-01T00:00:00.000Z", { id: "a-v110", custom: REPORT }),
    dataset("WSP_City_B", "1.0", "2026-03-01T00:00:00.000Z", { id: "b-new", custom: REPORT }),
    dataset("WSP_City_C", "1.0", "2026-04-01T00:00:00.000Z", { id: "c-v10" }),
  ];
  const { module } = harness({ 1: page1, 2: page2 });

  const result = await module.getTcatQaReports({ projectGroupId: "g1", limit: 100 }, { accessToken: "token" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  const data = result.data;

  assert.equal(data.scan.pagesRead, 2);
  assert.equal(data.scan.datasetsScanned, 53);
  assert.equal(data.scan.uniqueDatasetNames, 51);
  assert.equal(data.scan.truncated, false);
  assert.equal(data.summary.matchingRows, 51);
  assert.equal(data.summary.versionsSuperseded, 2);
  assert.equal(data.summary.missingReport, 1);
  assert.equal(data.summary.withReportPdf, 50);

  const cityA = data.rows.find((row) => row.name === "WSP_City_A");
  assert.equal(cityA?.version, "1.10");
  assert.equal(cityA?.tdei_dataset_id, "a-v110");
  assert.equal(cityA?.versionsAvailable, 2);

  const cityB = data.rows.find((row) => row.name === "WSP_City_B");
  assert.equal(cityB?.tdei_dataset_id, "b-new");

  const cityC = data.rows.find((row) => row.name === "WSP_City_C");
  assert.equal(cityC?.tdei_dataset_id, "c-v10");
  assert.equal(cityC?.version, "1.0");
});

test("tcat QA/QC inventory projects report detail, aliases and custom metadata", async () => {
  const { module } = harness({
    1: [
      dataset("WSP_Reported", "1.5", "2026-05-11T13:40:19.869Z", {
        id: "reported-id",
        custom: {
          ...REPORT,
          "pipeline version": "1.0",
          tract_nos: ["1762-01", "1762-02"],
          county: "Adams",
          area: "Adams UI",
          tcat_qa_qc_report_version: "2026.1",
          map_source: "imagery",
          imagery_used: { provider: "Microsoft", layer: "latest" },
        },
      }),
      dataset("WSP_No_Report", "1.0", "2026-01-01T00:00:00.000Z", { id: "no-report-id" }),
    ],
  });

  const result = await module.getTcatQaReports(
    { projectGroupId: "g1", includeCustomMetadata: true },
    { accessToken: "token" },
  );
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;

  const reported = result.data.rows.find((row) => row.name === "WSP_Reported");
  assert.equal(reported?.pipelineVersion, "1.0");
  assert.equal(reported?.tractNo, "1762-01, 1762-02");
  assert.equal(reported?.reportUrlPdf, REPORT.tcat_quality_report_url_pdf);
  assert.equal(reported?.reportCode, "abc123");
  assert.equal(reported?.qaQcReportVersion, "2026.1");
  assert.deepEqual(reported?.imageryUsed, { provider: "Microsoft", layer: "latest" });
  assert.ok(reported?.customMetadata);

  const missing = result.data.rows.find((row) => row.name === "WSP_No_Report");
  assert.equal(missing?.reportUrlPdf, undefined);
  assert.equal(missing?.customMetadata !== undefined, true);
});

test("tcat QA/QC inventory filters to datasets without a report", async () => {
  const { module } = harness({
    1: [
      dataset("WSP_Reported", "1.0", "2026-01-01T00:00:00.000Z", { custom: REPORT }),
      dataset("WSP_No_Report", "1.0", "2026-01-01T00:00:00.000Z"),
    ],
  });

  const result = await module.getTcatQaReports(
    { projectGroupId: "g1", reportFilter: "missing_reports" },
    { accessToken: "token" },
  );
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.summary.matchingRows, 1);
  assert.equal(result.data.rows[0]?.name, "WSP_No_Report");
  assert.match(result.data.table, /WSP_No_Report/);
  assert.doesNotMatch(result.data.table, /WSP_Reported/);
});

test("tcat QA/QC inventory reports truncation without hiding the summary", async () => {
  const pages = {
    1: Array.from({ length: 5 }, (_, index) =>
      dataset(`WSP_City_${index + 1}`, "1.0", "2026-01-01T00:00:00.000Z", { custom: REPORT }),
    ),
  };
  const { module } = harness(pages);

  const result = await module.getTcatQaReports({ projectGroupId: "g1", limit: 2 }, { accessToken: "token" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.truncation.shown, 2);
  assert.equal(result.data.truncation.available, 5);
  assert.equal(result.data.truncation.mayHaveMore, true);
  assert.equal(result.data.summary.matchingRows, 5);
  assert.equal(result.data.rows.length, 2);
});

test("tcat QA/QC inventory can return every version instead of the latest per name", async () => {
  const { module } = harness({
    1: [
      dataset("WSP_City_A", "1.9", "2026-01-01T00:00:00.000Z"),
      dataset("WSP_City_A", "1.10", "2026-02-01T00:00:00.000Z"),
      dataset("WSP_City_A", "1.2", "2026-03-01T00:00:00.000Z"),
    ],
  });

  const result = await module.getTcatQaReports(
    { projectGroupId: "g1", latestPerName: false },
    { accessToken: "token" },
  );
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.rows.length, 3);
  assert.equal(result.data.summary.versionsSuperseded, 0);
  assert.deepEqual(
    result.data.rows.map((row) => row.version),
    ["1.10", "1.9", "1.2"],
  );
});

test("tcat QA/QC inventory forwards the service filter and dataset paging", async () => {
  const { module, calls } = harness({
    1: [dataset("WSP_City_A", "1.0", "2026-01-01T00:00:00.000Z")],
  });

  await module.getTcatQaReports({ projectGroupId: "g1", serviceId: "svc-1" }, { accessToken: "token" });

  assert.deepEqual(
    calls.map((call) => call.page).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
  for (const call of calls) {
    assert.equal(call.pageSize, 50);
    assert.equal(call.serviceId, "svc-1");
    assert.equal(call.projectGroupId, "g1");
  }
});

test("tcat QA/QC inventory asks for a project group instead of guessing", async () => {
  const { module, calls } = harness({});
  const result = await module.getTcatQaReports({}, { accessToken: "token" });
  assert.equal(result.status, "needs_input");
  if (result.status !== "needs_input") return;
  assert.equal(result.missing[0]?.field, "projectGroupName");
  assert.deepEqual(result.missing[0]?.allowedValues, ["TCAT WSP"]);
  assert.equal(calls.length, 0);
});

test("tcat QA/QC inventory falls back to the dataset id when metadata is empty", async () => {
  const { module } = harness({
    1: [dataset("ignored", "1.0", "2026-01-01T00:00:00.000Z", { id: "only-id", metadata: {} })],
  });
  const result = await module.getTcatQaReports({ projectGroupId: "g1" }, { accessToken: "token" });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.data.rows[0]?.name, "only-id");
  assert.equal(result.data.rows[0]?.version, undefined);
});
