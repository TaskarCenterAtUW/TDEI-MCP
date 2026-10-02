import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { registerAwsTools } from "../src/aws/register-aws-tools.js";
import { createServer } from "../src/server.js";

test("stdio server exposes semantic tools backed by the AWS child", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
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
      async callTool(name, input) {
        calls.push({ name, input });
        const records = name === "listDatasetFiles" && input.name === "Seattle"
          ? [{ tdei_dataset_id: "dataset-1", name: "Seattle OSW" }]
          : [];
        return {
          content: [{ type: "text" as const, text: JSON.stringify(records) }],
        };
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
    assert.equal(calls.at(-1)?.name, "listDatasetFiles");
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
