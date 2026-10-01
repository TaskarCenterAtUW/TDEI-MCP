import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authManager } from "../src/auth/auth-manager.js";
import { AwsMcpClient } from "../src/aws/aws-mcp-client.js";
import { config } from "../src/config.js";
import { runWorkflow } from "../src/workflows/runner.js";
import { validateWorkflow } from "../src/workflows/validate.js";

test("a workflow downloads ZIP bytes and uploads the saved file over real HTTP multipart", async (t) => {
  const id = "e361c227-9209-44b8-a161-f04d1b002bdf";
  const zip = Buffer.from("504b0506000000000000000000000000000000000200a6ff", "hex");
  const directory = await mkdtemp(join(tmpdir(), "tdei-transfer-"));
  const previousDirectory = process.env.TDEI_DOWNLOAD_DIR;
  const previousUrl = config.apiUrl;
  process.env.TDEI_DOWNLOAD_DIR = directory;
  let uploaded: Buffer | undefined;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer test-token");
      if (request.method === "GET") {
        assert.equal(request.url, `/api/v1/osw/${id}?format=osw&file_version=latest`);
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(zip);
      } else {
        assert.equal(request.url, "/api/v1/osw/validate");
        assert.match(request.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const parsed = await new Request("http://127.0.0.1/", {
          method: "POST",
          headers: { "Content-Type": request.headers["content-type"]! },
          body: Buffer.concat(chunks),
        }).formData();
        const dataset = parsed.get("dataset");
        assert.ok(dataset instanceof File);
        assert.equal(dataset.type, "application/zip");
        uploaded = Buffer.from(await dataset.arrayBuffer());
        response.writeHead(202, { "Content-Type": "application/text", Location: "/api/v1/jobs/job-123" });
        response.end("job-123");
      }
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  t.after(async () => {
    config.apiUrl = previousUrl;
    if (previousDirectory === undefined) delete process.env.TDEI_DOWNLOAD_DIR;
    else process.env.TDEI_DOWNLOAD_DIR = previousDirectory;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  config.apiUrl = `http://127.0.0.1:${address.port}`;
  t.mock.method(authManager, "getAccessToken", async () => "test-token");
  const def = {
    name: "roundtrip",
    steps: [
      { id: "download", tool: "getOswFile", input: { tdei_dataset_id: id } },
      { id: "upload", tool: "validateOswFile", input: { dataset: "{{steps.download.output.structuredContent.path}}" } },
    ],
  };
  const toolSchemas = new Map([
    ["getOswFile", { inputSchema: { type: "object", properties: { tdei_dataset_id: { type: "string" } }, required: ["tdei_dataset_id"] } }],
    ["validateOswFile", { inputSchema: { type: "object", properties: { dataset: { type: "string", format: "binary" } }, required: ["dataset"] } }],
  ]);
  const multipart = new Set(["validateOswFile"]);
  validateWorkflow(def, { toolSchemas, multipart, denied: new Set(), configPath: "test" });
  const client = new AwsMcpClient();
  const result = await runWorkflow(def, {}, { toolSchemas, multipart, callTool: (name, args) => client.callTool(name, args) });
  assert.deepEqual(uploaded, zip);
  const download = result.outputs.download as { structuredContent: { path: string } };
  assert.deepEqual(await readFile(download.structuredContent.path), zip);
  const upload = result.outputs.upload as { structuredContent: { status: number; result: string; location: string } };
  assert.deepEqual(upload.structuredContent, { status: 202, result: "job-123", location: "/api/v1/jobs/job-123" });
  assert.equal(client.isConnected(), false);
});
