import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { registerAwsTools } from "../src/aws/register-aws-tools.js";
import { createServer } from "../src/server.js";

test("stdio server exposes semantic tools over direct TDEI HTTP", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    assert.equal(request.headers.get("Authorization"), "Bearer test-token");
    if (new URL(request.url).pathname === "/api/v1/datasets") {
      return new Response(JSON.stringify([
        { tdei_dataset_id: "dataset-1", name: "Seattle OSW" },
      ]), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  });

  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({
        configured: true,
        authenticated: true,
        state: "authenticated" as const,
        loginMethod: "sso" as const,
      }),
      getTokenVersion: () => 1,
      async logout() { throw new Error("not used"); },
    },
    awsMcpClient: {
      async listTools() {
        return {
          tools: ["listDatasetFiles", "listServices"].map((name) => ({
            name,
            description: name,
            inputSchema: {
              type: "object" as const,
              properties: {},
              additionalProperties: true,
            },
          })),
        };
      },
      async callTool(name) {
        throw new Error(`semantic tools must not use AWS child (${name})`);
      },
      async close() {},
      isConnected: () => true,
    },
    registerAwsTools,
  });
  const client = new Client({ name: "semantic-stdio-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "tdei_find_datasets"));
    const result = await client.callTool({
      name: "tdei_find_datasets",
      arguments: { place: "Seattle", dataType: "osw", latest: true },
    });
    const first = result.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.equal(body.status, "complete");
    assert.equal(body.data.selected.tdei_dataset_id, "dataset-1");
    assert.equal(new URL(requests[0]!.url).pathname, "/api/v1/datasets");
  } finally {
    await client.close();
  }
});

test("stdio list my project groups calls GET /api/v1/project-groups", async (t) => {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).pathname, "/api/v1/project-groups");
    assert.equal(request.headers.get("Authorization"), "Bearer test-token");
    return new Response(JSON.stringify([
      {
        tdei_project_group_id: "1ec1c79b-6b7a-4011-936b-c75dbbd903e3",
        project_group_name: "AA Viewer Internal",
      },
    ]), { status: 200 });
  });

  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({
        configured: true,
        authenticated: true,
        state: "authenticated" as const,
        loginMethod: "sso" as const,
      }),
      getTokenVersion: () => 1,
      async logout() { throw new Error("not used"); },
    },
    awsMcpClient: {
      async listTools() { return { tools: [] }; },
      async callTool() { throw new Error("must not use AWS child"); },
      async close() {},
      isConnected: () => false,
    },
    registerAwsTools,
  });
  const client = new Client({ name: "semantic-stdio-groups-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "tdei_list_my_project_groups",
      arguments: { page: 1, pageSize: 10 },
    });
    const first = result.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.equal(body.status, "complete");
    assert.equal(body.data.apiOperation, "listProjectGroups");
    assert.equal(body.data.path, "/api/v1/project-groups");
    assert.equal(
      body.data.projectGroups[0].project_group_name,
      "AA Viewer Internal",
    );
  } finally {
    await client.close();
  }
});

test("stdio semantic validation sends a local file directly to TDEI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdei-semantic-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const datasetPath = join(directory, "dataset.zip");
  const datasetBytes = Buffer.from("504b050600000000000000000000000000000000", "hex");
  await writeFile(datasetPath, datasetBytes);

  const childCalls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).pathname, "/api/v1/osw/validate");
    assert.equal(request.headers.get("Authorization"), "Bearer test-token");
    const form = await request.formData();
    const dataset = form.get("dataset");
    assert.ok(dataset instanceof File);
    assert.equal(dataset.name, "dataset.zip");
    assert.deepEqual(Buffer.from(await dataset.arrayBuffer()), datasetBytes);
    return new Response('"validation-job"', {
      status: 202,
      headers: { Location: "/api/v1/jobs/validation-job" },
    });
  });

  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({
        configured: true,
        authenticated: true,
        state: "authenticated" as const,
        loginMethod: "sso" as const,
      }),
      getTokenVersion: () => 1,
      async logout() { throw new Error("not used"); },
    },
    awsMcpClient: {
      async listTools() { return { tools: [] }; },
      async callTool(name) {
        childCalls.push(name);
        throw new Error("multipart validation must bypass the AWS child");
      },
      async close() {},
      isConnected: () => false,
    },
    registerAwsTools,
  });
  const client = new Client({ name: "semantic-stdio-upload-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "tdei_validate_dataset",
      arguments: {
        dataType: "osw",
        asset: { kind: "local_path", path: datasetPath },
      },
    });
    const first = result.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.deepEqual(body, {
      status: "complete",
      data: {
        jobId: "validation-job",
        location: "/api/v1/jobs/validation-job",
      },
    });
    assert.deepEqual(childCalls, []);
  } finally {
    await client.close();
  }
});
