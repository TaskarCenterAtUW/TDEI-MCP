import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { authManager } from "../src/auth/auth-manager.js";
import { AwsMcpClient } from "../src/aws/aws-mcp-client.js";

const datasetId = "e361c227-9209-44b8-a161-f04d1b002bdf";

for (const [tool, argument, path] of [
  ["getGtfsFlexFile", "tdei_dataset_id", "/api/v1/gtfs-flex/"],
  ["getGtfsPathwaysFile", "tdei_dataset_id", "/api/v1/gtfs-pathways/"],
  ["job_download", "job_id", "/api/v1/job/download/"],
] as const) {
  test(`${tool} preserves ZIP bytes and uses the correct authenticated endpoint`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tdei-download-"));
    const previous = process.env.TDEI_DOWNLOAD_DIR;
    process.env.TDEI_DOWNLOAD_DIR = directory;
    t.after(async () => {
      if (previous === undefined) delete process.env.TDEI_DOWNLOAD_DIR;
      else process.env.TDEI_DOWNLOAD_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    });
    const zip = Buffer.from("504b0506000000000000000000000000000000000200a6ff", "hex");
    t.mock.method(authManager, "getAccessToken", async () => "test-token");
    t.mock.method(StdioClientTransport.prototype, "start", async () => { throw new Error("download must bypass generated server"); });
    t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
      assert.equal(new URL(input).pathname, path + datasetId);
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-token");
      return new Response(zip, { headers: { "Content-Type": "application/octet-stream" } });
    });
    const result = await new AwsMcpClient().callTool(tool, { [argument]: datasetId });
    const block = result.content?.[0];
    assert.ok(block?.type === "text");
    const file = JSON.parse(block.text);
    assert.match(file.filename, /\.zip$/);
    assert.deepEqual(await readFile(file.path), zip);
  });
}

for (const format of ["csv", "geojson"] as const) {
  test(`feedback ${format} export saves a file and preserves query filters`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tdei-download-"));
    const previous = process.env.TDEI_DOWNLOAD_DIR;
    process.env.TDEI_DOWNLOAD_DIR = directory;
    t.after(async () => {
      if (previous === undefined) delete process.env.TDEI_DOWNLOAD_DIR;
      else process.env.TDEI_DOWNLOAD_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    });
    const data = format === "csv" ? 'id,feedback\n1,"café"\n' : '{"type":"FeatureCollection","features":[]}';
    t.mock.method(authManager, "getAccessToken", async () => "test-token");
    t.mock.method(StdioClientTransport.prototype, "start", async () => { throw new Error("export must bypass generated server"); });
    t.mock.method(globalThis, "fetch", async (input: URL) => {
      const url = new URL(input);
      assert.equal(url.pathname, `/api/v1/osw/dataset-viewer/feedbacks/download/${datasetId}`);
      assert.equal(url.searchParams.get("format"), format);
      assert.equal(url.searchParams.get("status"), "open");
      assert.equal(url.searchParams.get("page_size"), "20");
      return new Response(data, { headers: { "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/geo+json" } });
    });
    const result = await new AwsMcpClient().callTool("oswDatasetViewerFeedbacksDownload", {
      tdei_project_group_id: datasetId, format, status: "open", page_size: 20,
    });
    const block = result.content?.[0];
    assert.ok(block?.type === "text");
    const file = JSON.parse(block.text);
    assert.match(file.filename, new RegExp(`\\.${format}$`));
    assert.equal(await readFile(file.path, "utf8"), data);
    assert.equal(file.bytes, Buffer.byteLength(data));
  });
}

test("getOswFile saves binary bytes locally without calling the generated server", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdei-download-"));
  const previous = process.env.TDEI_DOWNLOAD_DIR;
  process.env.TDEI_DOWNLOAD_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.TDEI_DOWNLOAD_DIR;
    else process.env.TDEI_DOWNLOAD_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  // Empty ZIP with a binary comment, including the byte from the live failure.
  const zip = Buffer.concat([Buffer.from("504b0506000000000000000000000000000000000200", "hex"), Buffer.from([0xa6, 0xff])]);
  t.mock.method(authManager, "getAccessToken", async () => "test-token");
  t.mock.method(StdioClientTransport.prototype, "start", async () => { throw new Error("download must bypass generated server"); });
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.pathname, `/api/v1/osw/${datasetId}`);
    assert.equal(url.searchParams.get("format"), "osw");
    assert.equal(url.searchParams.get("file_version"), "latest");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-token");
    return new Response(zip, { headers: { "Content-Type": "application/octet-stream" } });
  });
  const client = new AwsMcpClient();
  const result = await client.callTool("getOswFile", { tdei_dataset_id: datasetId, format: "osw" });
  assert.equal(client.isConnected(), false);
  const block = result.content?.[0];
  assert.ok(block?.type === "text");
  const file = JSON.parse(block.text);
  assert.equal(file.contentType, "application/octet-stream");
  assert.equal(file.bytes, zip.length);
  assert.equal(file.path, join(directory, file.filename));
  assert.deepEqual(await readFile(file.path), zip);
  const second = await client.callTool("getOswFile", { tdei_dataset_id: datasetId });
  const secondBlock = second.content?.[0];
  assert.ok(secondBlock?.type === "text");
  assert.notEqual(JSON.parse(secondBlock.text).path, file.path);
});

test("getOswFile rejects HTTP errors and does not leave a download", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdei-download-"));
  const previous = process.env.TDEI_DOWNLOAD_DIR;
  process.env.TDEI_DOWNLOAD_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.TDEI_DOWNLOAD_DIR;
    else process.env.TDEI_DOWNLOAD_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(authManager, "getAccessToken", async () => "test-token");
  t.mock.method(StdioClientTransport.prototype, "start", async () => { throw new Error("download must bypass generated server"); });
  t.mock.method(globalThis, "fetch", async () => new Response('{"error":"not found"}', { status: 404 }));
  await assert.rejects(new AwsMcpClient().callTool("getOswFile", { tdei_dataset_id: datasetId }), /HTTP 404/);
  assert.deepEqual(await readdir(directory), []);
});

test("getOswFile removes partial files when the binary stream fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdei-download-"));
  const previous = process.env.TDEI_DOWNLOAD_DIR;
  process.env.TDEI_DOWNLOAD_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.TDEI_DOWNLOAD_DIR;
    else process.env.TDEI_DOWNLOAD_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(authManager, "getAccessToken", async () => "test-token");
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([0x50, 0x4b, 0xa6])); },
    pull(controller) { controller.error(new Error("download interrupted")); },
  }), { headers: { "Content-Type": "application/zip" } }));
  await assert.rejects(new AwsMcpClient().callTool("getOswFile", { tdei_dataset_id: datasetId }), /download interrupted/);
  assert.deepEqual(await readdir(directory), []);
});
