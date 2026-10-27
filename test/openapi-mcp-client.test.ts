import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenApiMcpClient } from "../src/openapi/openapi-mcp-client.js";

const spec = {
  openapi: "3.0.1",
  paths: {
    "/api/v1/datasets/{dataset_id}": {
      get: {
        operationId: "get-dataset",
        description: "Get one dataset.",
        tags: ["OSW", "Common APIs"],
        parameters: [
          { name: "dataset_id", in: "path", required: true, schema: { type: "string" } },
          { name: "bbox", in: "query", schema: { type: "array", items: { type: "number" } } },
          { name: "include_metadata", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/v1/datasets": {
      post: {
        operationId: "createDataset",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  active: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
  },
};

test("discovers OpenAPI operations as MCP tool definitions", async () => {
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    loadSpec: async () => structuredClone(spec),
    headersProvider: async () => ({ Authorization: "Bearer token" }),
  });

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["get_dataset", "createDataset"]);
  const getDataset = tools[0]!;
  assert.match(getDataset.description ?? "", /^\[OSW, Common APIs\] Get one dataset\. \| Returns: 200$/);
  assert.deepEqual(getDataset.tags, ["OSW", "Common APIs"]);
  assert.deepEqual(getDataset.inputSchema.required, ["dataset_id"]);
  assert.deepEqual(
    Object.keys(getDataset.inputSchema.properties as Record<string, unknown>),
    ["dataset_id", "bbox", "include_metadata"],
  );
  const create = tools[1]!;
  assert.equal(create.tags, undefined);
  assert.deepEqual(create.inputSchema.required, ["name"]);
});

test("rejects operation IDs that normalize to the same MCP tool name", async () => {
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    loadSpec: async () => ({
      openapi: "3.0.1",
      paths: {
        "/one": { get: { operationId: "get-pet", responses: {} } },
        "/two": { get: { operationId: "get_pet", responses: {} } },
      },
    }),
  });
  await assert.rejects(
    () => client.listTools(),
    /operation name collision.*get_pet/i,
  );
});

test("executes path and repeated query parameters with the current bearer", async () => {
  let request: Request | undefined;
  let tokens = 0;
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    loadSpec: async () => structuredClone(spec),
    headersProvider: async () => ({ Authorization: `Bearer token-${++tokens}` }),
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ id: "dataset/1" });
    },
  });

  const result = await client.callTool("get_dataset", {
    dataset_id: "dataset/1",
    bbox: [-122.4, 47.5, -122.2, 47.7],
    include_metadata: true,
  });

  assert.equal(request?.url, "https://api.example.test/api/v1/datasets/dataset%2F1?bbox=-122.4&bbox=47.5&bbox=-122.2&bbox=47.7&include_metadata=true");
  assert.equal(request?.headers.get("Authorization"), "Bearer token-1");
  assert.deepEqual(JSON.parse(result.content[0]!.text), { id: "dataset/1" });
});

test("executes flattened JSON request bodies", async () => {
  let request: Request | undefined;
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    loadSpec: async () => structuredClone(spec),
    headersProvider: async () => ({ Authorization: "Bearer token" }),
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response("created", { status: 201, headers: { "Content-Type": "text/plain" } });
    },
  });

  await client.callTool("createDataset", { name: "Seattle", active: true });
  assert.equal(request?.method, "POST");
  assert.equal(request?.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await request?.json(), { name: "Seattle", active: true });
});

test("streams absolute binary fields into multipart requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdei-openapi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "dataset.zip");
  await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x83]));
  let request: Request | undefined;
  const multipartSpec = {
    openapi: "3.0.1",
    paths: {
      "/api/v1/upload": {
        post: {
          operationId: "uploadDataset",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["dataset"],
                  properties: {
                    dataset: { type: "string", format: "binary" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "202": { description: "Accepted" } },
        },
      },
    },
  };
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    loadSpec: async () => multipartSpec,
    headersProvider: async () => ({ Authorization: "Bearer token" }),
    allowLocalFileUploads: true,
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response("accepted", { status: 202 });
    },
  });

  await client.callTool("uploadDataset", { dataset: filePath, description: "test" });
  const form = await request?.formData();
  const dataset = form?.get("dataset");
  assert.ok(dataset instanceof File);
  assert.equal(dataset.name, "dataset.zip");
  assert.deepEqual(Buffer.from(await dataset.arrayBuffer()), Buffer.from([0x50, 0x4b, 0x83]));
  assert.equal(form?.get("description"), "test");
});

test("rejects disallowed local file extensions during multipart upload", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdei-openapi-ext-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const badPath = join(directory, "payload.exe");
  await writeFile(badPath, Buffer.from("MZ-forbidden"));
  const multipartSpec = {
    openapi: "3.0.1",
    paths: {
      "/api/v1/upload": {
        post: {
          operationId: "uploadDataset",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["dataset"],
                  properties: {
                    dataset: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
          responses: { "202": { description: "Accepted" } },
        },
      },
    },
  };
  let calledFetch = false;
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    loadSpec: async () => multipartSpec,
    allowLocalFileUploads: true,
    fetchImpl: async () => {
      calledFetch = true;
      return new Response("accepted", { status: 202 });
    },
  });

  await assert.rejects(
    () => client.callTool("uploadDataset", { dataset: badPath }),
    /Unsupported upload file extension "\.exe"/,
  );
  assert.equal(calledFetch, false);
});

test("retries streaming multipart upload once on transient 503 failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdei-openapi-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "dataset.zip");
  await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  let attempts = 0;
  const multipartSpec = {
    openapi: "3.0.1",
    paths: {
      "/api/v1/upload": {
        post: {
          operationId: "uploadDataset",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["dataset"],
                  properties: {
                    dataset: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
          responses: { "202": { description: "Accepted" } },
        },
      },
    },
  };
  const client = new OpenApiMcpClient({
    apiUrl: "https://api.example.test",
    loadSpec: async () => multipartSpec,
    allowLocalFileUploads: true,
    fetchImpl: async (input, init) => {
      attempts += 1;
      const req = new Request(input, init);
      const form = await req.formData();
      assert.ok(form.get("dataset") instanceof File);
      if (attempts === 1) {
        return new Response("gateway timeout", { status: 503 });
      }
      return new Response("job-123", { status: 202 });
    },
  });

  const result = await client.callTool("uploadDataset", { dataset: filePath });
  assert.equal(attempts, 2);
  assert.equal(result.content[0]?.text, "job-123");
});
