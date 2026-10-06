import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createHttpSemanticServer } from "../src/http-semantic-server.js";

const liveProjectGroups = [
  {
    tdei_project_group_id: "1ec1c79b-6b7a-4011-936b-c75dbbd903e3",
    project_group_name: "AA Viewer Internal",
    phone: "",
    url: "",
    address: "124 Ketworth way",
    polygon: null,
    poc: [],
  },
  {
    tdei_project_group_id: "d8774a74-a0fc-4bfb-a9a3-fec4b4484727",
    project_group_name: "OSW PG",
    phone: "",
    url: "",
    address: "",
    polygon: null,
    poc: [],
  },
];

test("hosted semantic server calls TDEI directly with its request bearer", async () => {
  const requests: Request[] = [];
  const server = createHttpSemanticServer({
    accessToken: "request-token",
    apiUrl: "https://api.example.test",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(JSON.stringify([
        { tdei_dataset_id: "dataset-1", name: "Seattle OSW" },
      ]), { status: 200 });
    },
  });
  const client = new Client({ name: "semantic-http-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "tdei_find_datasets",
      "tdei_list_my_project_groups",
      "tdei_list_services",
      "tdei_resolve_intent",
      "tdei_upload_dataset",
      "tdei_validate_dataset",
    ]);
    const result = await client.callTool({
      name: "tdei_find_datasets",
      arguments: { place: "Seattle", latest: true },
    });
    const first = result.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.equal(body.data.selected.tdei_dataset_id, "dataset-1");
    assert.equal(requests[0]?.headers.get("Authorization"), "Bearer request-token");
  } finally {
    await client.close();
  }
});

test("HTTP MCP list my project groups uses direct GET /api/v1/project-groups (no AWS child)", async () => {
  const requests: Request[] = [];
  const server = createHttpSemanticServer({
    accessToken: "http-bearer",
    apiUrl: "https://api-dev.tdei.us",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      // Live gateway shape: top-level JSON array (not project_groups envelope).
      return new Response(JSON.stringify(liveProjectGroups), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const client = new Client({ name: "http-groups-client", version: "1.0.0" });
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
    assert.equal(body.data.method, "GET");
    assert.equal(body.data.path, "/api/v1/project-groups");
    assert.equal(body.data.projectGroups.length, 2);
    assert.equal(body.data.projectGroups[0].project_group_name, "AA Viewer Internal");
    assert.equal(body.data.projectGroups[1].project_group_name, "OSW PG");

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.headers.get("Authorization"), "Bearer http-bearer");
    assert.equal(
      new URL(requests[0]!.url).pathname,
      "/api/v1/project-groups",
    );
    assert.equal(new URL(requests[0]!.url).searchParams.get("page_no"), "1");
    assert.equal(new URL(requests[0]!.url).searchParams.get("page_size"), "10");
  } finally {
    await client.close();
  }
});

test("HTTP MCP still parses wrapped project_groups envelopes without returning []", async () => {
  const server = createHttpSemanticServer({
    accessToken: "http-bearer",
    apiUrl: "https://api.example.test",
    fetchImpl: async () => new Response(JSON.stringify({
      data: [],
      project_groups: liveProjectGroups,
    }), { status: 200 }),
  });
  const client = new Client({ name: "http-wrapped-groups-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "tdei_list_my_project_groups",
      arguments: {},
    });
    const first = result.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.equal(body.data.projectGroups.length, 2);
    assert.equal(body.data.projectGroups[0].tdei_project_group_id, liveProjectGroups[0].tdei_project_group_id);
  } finally {
    await client.close();
  }
});
