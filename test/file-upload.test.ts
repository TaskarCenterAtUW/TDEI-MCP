import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { authManager } from "../src/auth/auth-manager.js";
import { AwsMcpClient } from "../src/aws/aws-mcp-client.js";

const id = "e361c227-9209-44b8-a161-f04d1b002bdf";
const zip = Buffer.from("504b0506000000000000000000000000000000000200a6ff", "hex");
const operations = [
  ["uploadOswFile", `/api/v1/osw/upload/${id}/${id}`, "POST", ["dataset", "metadata", "changeset"]],
  ["uploadGtfsFlexFile", `/api/v1/gtfs-flex/upload/${id}/${id}`, "POST", ["dataset", "metadata", "changeset"]],
  ["uploadGtfsPathwaysFile", `/api/v1/gtfs-pathways/upload/${id}/${id}`, "POST", ["dataset", "metadata", "changeset"]],
  ["validateOswFile", "/api/v1/osw/validate", "POST", ["dataset"]],
  ["validateGtfsFlexFile", "/api/v1/gtfs-flex/validate", "POST", ["dataset"]],
  ["validateGtfsPathwaysFile", "/api/v1/gtfs-pathways/validate", "POST", ["dataset"]],
  ["sanitizeOswFile", "/api/v1/osw/sanitize", "POST", ["dataset"]],
  ["editMetadata", `/api/v1/metadata/${id}`, "PUT", ["file"]],
  ["cloneDataset", `/api/v1/dataset/clone/${id}/${id}/${id}`, "POST", ["file"]],
  ["oswOnDemandFormat", "/api/v1/osw/convert", "POST", ["file"]],
  ["oswConfidenceCalculate", `/api/v1/osw/confidence/${id}`, "POST", ["file"]],
  ["oswQualityCalculate", `/api/v1/osw/quality-metric/ixn/${id}`, "POST", ["file"]],
  ["qualityMetricTag", `/api/v1/osw/quality-metric/tag/${id}`, "POST", ["file"]],
] as const;

for (const [tool, path, method, files] of operations) {
  test(`${tool} sends local files as authenticated multipart bytes`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tdei-upload-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dataset = join(directory, "dataset.zip");
    const metadata = join(directory, "metadata.json");
    await writeFile(dataset, zip);
    await writeFile(metadata, '{"name":"café"}');
    t.mock.method(authManager, "getAccessToken", async () => "test-token");
    t.mock.method(StdioClientTransport.prototype, "start", async () => { throw new Error("upload must bypass generated server"); });
    t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
      assert.equal(new URL(input).pathname, path);
      assert.equal(init.method, method);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Bearer test-token");
      assert.equal(headers.get("Content-Type"), null, "fetch must generate the multipart boundary");
      assert.ok(init.body instanceof FormData);
      assert.deepEqual([...init.body.keys()].sort(), [...files, ...(tool === "oswOnDemandFormat" ? ["source_format", "target_format"] : [])].sort());
      for (const key of files) {
        const file = init.body.get(key);
        assert.ok(file instanceof File);
        if (key === "metadata") {
          assert.equal(file.name, "metadata.json");
          assert.equal(await file.text(), '{"name":"café"}');
        } else {
          assert.equal(file.name, "dataset.zip");
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), zip);
        }
      }
      if (tool.startsWith("upload")) assert.equal(new URL(input).searchParams.get("derived_from_dataset_id"), id);
      if (tool === "oswOnDemandFormat") {
        assert.equal(init.body.get("source_format"), "osw");
        assert.equal(init.body.get("target_format"), "osm");
      }
      return new Response('"job-123"', { status: 202, headers: { "Content-Type": "application/json", Location: "/api/v1/jobs/job-123" } });
    });
    const result = await new AwsMcpClient().callTool(tool, {
      tdei_dataset_id: id, tdei_project_group_id: id, tdei_service_id: id,
      dataset, metadata, changeset: dataset, file: dataset,
      derived_from_dataset_id: id, source_format: "osw", target_format: "osm",
    });
    const block = result.content?.[0];
    assert.ok(block?.type === "text");
    assert.deepEqual(JSON.parse(block.text), { status: 202, result: "job-123", location: "/api/v1/jobs/job-123" });
  });
}

test("upload rejects missing local files before sending a request", async (t) => {
  t.mock.method(authManager, "getAccessToken", async () => "test-token");
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not send"); });
  t.mock.method(StdioClientTransport.prototype, "start", async () => { throw new Error("must bypass generated server"); });
  await assert.rejects(new AwsMcpClient().callTool("validateOswFile", { dataset: "/missing/tdei-file.zip" }), /dataset.*readable regular file/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("optional upload files can be omitted and HTTP failures propagate", async (t) => {
  t.mock.method(authManager, "getAccessToken", async () => "test-token");
  t.mock.method(globalThis, "fetch", async (_input: URL, init: RequestInit) => {
    assert.ok(init.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], []);
    return new Response('{"error":"forbidden"}', { status: 403, headers: { "Content-Type": "application/json" } });
  });
  await assert.rejects(new AwsMcpClient().callTool("oswConfidenceCalculate", { tdei_dataset_id: id }), /HTTP 403/);
});
