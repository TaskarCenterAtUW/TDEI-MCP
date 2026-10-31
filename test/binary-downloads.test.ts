import { strict as assert } from "node:assert";
import test from "node:test";

import { BinaryTdeiDownloads } from "../src/adapters/binary-tdei-downloads.js";

// The MCP server never touches file bytes: no fetch, no fs. These tests prove
// the download adapter is pure — it resolves routes and returns a client-side
// curl command with zero network or disk activity.

test("getOswFile resolves to a client-side curl instruction without network", async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  }) as typeof fetch;
  const downloads = new BinaryTdeiDownloads({
    baseUrl: "https://api.example.test",
    fetchImpl,
    outputDir: "/tmp/ignored",
  });

  const result = await downloads.download("getOswFile", { tdei_dataset_id: "yakima-1" }, { accessToken: "bearer-A" });

  assert.equal(fetchCalls, 0);
  assert.equal(result.tool, "getOswFile");
  assert.equal(result.method, "GET");
  assert.equal(result.path, "/api/v1/osw/yakima-1");
  assert.equal(result.filename, "getOswFile-yakima-1.zip");
  assert.equal(
    result.curlCommand,
    'curl -L -H "Authorization: Bearer $TDEI_TOKEN" "https://api.example.test/api/v1/osw/yakima-1" -o "getOswFile-yakima-1.zip"',
  );
  assert.match(result.instruction, /CLIENT machine/);
});

test("download routes map to spec streaming endpoints", async () => {
  const downloads = new BinaryTdeiDownloads({ baseUrl: "https://api.example.test/" });

  const flex = await downloads.download("getGtfsFlexFile", { tdei_dataset_id: "f1" }, { accessToken: "t" });
  const pathways = await downloads.download("getGtfsPathwaysFile", { tdei_dataset_id: "p1" }, { accessToken: "t" });
  const job = await downloads.download("job-download", { job_id: "j1" }, { accessToken: "t" });
  // Both the spec ("job-download") and normalized ("job_download") ids route locally.
  const jobAlias = await downloads.download("job_download", { job_id: "j2" }, { accessToken: "t" });

  assert.equal(flex.path, "/api/v1/gtfs-flex/f1");
  assert.equal(pathways.path, "/api/v1/gtfs-pathways/p1");
  assert.equal(job.path, "/api/v1/job/download/j1");
  assert.equal(jobAlias.path, "/api/v1/job/download/j2");
  for (const result of [flex, pathways, job, jobAlias]) {
    assert.equal(result.curlCommand.startsWith("curl -L"), true);
  }
});

test("getOswFile forwards format and file_version query params", async () => {
  const downloads = new BinaryTdeiDownloads({ baseUrl: "https://api.example.test" });

  const result = await downloads.download(
    "getOswFile",
    { tdei_dataset_id: "yakima-1", format: "osm", file_version: "v1" },
    { accessToken: "t" },
  );

  assert.equal(result.path, "/api/v1/osw/yakima-1?format=osm&file_version=v1");
  assert.match(result.curlCommand, /format=osm/);
  assert.notEqual(result.curlCommand.indexOf("$TDEI_TOKEN"), -1);
});

test("missing ids surface without touching the network", async () => {
  const downloads = new BinaryTdeiDownloads({ baseUrl: "https://api.example.test" });

  await assert.rejects(downloads.download("getOswFile", {}, { accessToken: "t" }), /tdei_dataset_id/);
  await assert.rejects(downloads.download("job-download", {}, { accessToken: "t" }), /job_id/);
  await assert.rejects(
    downloads.download("not-a-download-tool", { tdei_dataset_id: "x" }, { accessToken: "t" }),
    /not supported/,
  );
});

test("isDownloadTool only matches binary streaming tools", () => {
  assert.equal(BinaryTdeiDownloads.isDownloadTool("getOswFile"), true);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("job-download"), true);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("job_download"), true);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("listDatasetFiles"), false);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("listServices"), false);
});
