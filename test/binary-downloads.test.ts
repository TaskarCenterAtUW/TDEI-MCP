import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BinaryTdeiDownloads,
} from "../src/adapters/binary-tdei-downloads.js";

// Byte 0x83 at position 50 reproduces the reported
// "'utf-8' codec can't decode byte 0x83 in position 50" failure: any path
// that decodes this payload as text is broken.
function zipBytes(): Buffer {
  const body = Buffer.alloc(200, 0);
  body.write("PK\x03\x04", 0, "binary");
  body[50] = 0x83;
  return body;
}

function fetchReturning(body: Buffer, status = 200) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as URL, init);
    requests.push(request);
    return new Response(new Uint8Array(body), {
      status,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

test("binary payload with byte 0x83 round-trips without UTF-8 decode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-download-"));
  const payload = zipBytes();
  // A UTF-8 text round-trip corrupts byte 0x83 (Node replaces it instead of
  // throwing like Python's strict decoder), so binary must never go through
  // response.text()/toString("utf-8").
  assert.equal(Buffer.from(payload.toString("utf-8"), "utf-8").equals(payload), false);
  const { fetchImpl, requests } = fetchReturning(payload);
  const downloads = new BinaryTdeiDownloads({
    baseUrl: "https://api.example.test",
    fetchImpl,
    outputDir: dir,
  });

  const result = await downloads.download(
    "getOswFile",
    { tdei_dataset_id: "yakima-1" },
    { accessToken: "bearer-A" },
  );

  assert.equal(requests.length, 1);
  const request = requests[0] as Request;
  assert.equal(
    request.url,
    "https://api.example.test/api/v1/osw/yakima-1",
  );
  assert.equal(request.headers.get("Authorization"), "Bearer bearer-A");
  assert.deepEqual(readFileSync(result.path), payload);
  assert.equal(result.bytes, payload.byteLength);
  assert.match(result.path, /getOswFile-yakima-1\.zip$/);
});

test("download routes map to spec streaming endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-download-"));
  const payload = zipBytes();
  const seen: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    seen.push(String(input instanceof URL ? input.href : input));
    return new Response(new Uint8Array(payload), { status: 200 });
  }) as typeof fetch;
  const downloads = new BinaryTdeiDownloads({
    baseUrl: "https://api.example.test/",
    fetchImpl,
    outputDir: dir,
  });

  await downloads.download("getGtfsFlexFile", { tdei_dataset_id: "f1" }, { accessToken: "t" });
  await downloads.download("getGtfsPathwaysFile", { tdei_dataset_id: "p1" }, { accessToken: "t" });
  await downloads.download("job-download", { job_id: "j1" }, { accessToken: "t" });
  // Both the spec ("job-download") and normalized ("job_download") ids route locally.
  await downloads.download("job_download", { job_id: "j2" }, { accessToken: "t" });

  assert.deepEqual(seen, [
    "https://api.example.test/api/v1/gtfs-flex/f1",
    "https://api.example.test/api/v1/gtfs-pathways/p1",
    "https://api.example.test/api/v1/job/download/j1",
    "https://api.example.test/api/v1/job/download/j2",
  ]);
});

test("missing ids and HTTP errors surface without touching the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-download-"));
  const { fetchImpl } = fetchReturning(Buffer.from("nope"), 404);
  const downloads = new BinaryTdeiDownloads({
    baseUrl: "https://api.example.test",
    fetchImpl,
    outputDir: dir,
  });

  await assert.rejects(
    downloads.download("getOswFile", {}, { accessToken: "t" }),
    /tdei_dataset_id/,
  );
  const error = await downloads
    .download("getOswFile", { tdei_dataset_id: "missing" }, { accessToken: "t" })
    .then(() => assert.fail("should throw"), (e) => e as Error & { status?: number });
  assert.equal(error.status, 404);
});

test("isDownloadTool only matches binary streaming tools", () => {
  assert.equal(BinaryTdeiDownloads.isDownloadTool("getOswFile"), true);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("job-download"), true);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("job_download"), true);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("listDatasetFiles"), false);
  assert.equal(BinaryTdeiDownloads.isDownloadTool("listServices"), false);
});
