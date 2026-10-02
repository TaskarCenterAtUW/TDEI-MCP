import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createHttpSemanticServer } from "../src/http-semantic-server.js";

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
