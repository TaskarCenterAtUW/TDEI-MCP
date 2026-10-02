import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerSemanticTools } from "../src/intents/register-tools.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

test("common semantic tools are discoverable and callable", async () => {
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() { return []; },
      async listServices() { return []; },
    },
    places: {
      async forwardGeocode() { return []; },
    },
  });
  const server = new McpServer({ name: "semantic-tools-test", version: "1.0.0" });
  registerSemanticTools(server, module);
  const client = new Client({ name: "semantic-tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const semantic = listed.tools
      .filter((tool) => tool.name.startsWith("tdei_"))
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(semantic, [
      "tdei_find_datasets",
      "tdei_list_my_project_groups",
      "tdei_list_services",
      "tdei_upload_dataset",
      "tdei_validate_dataset",
    ]);
    const find = listed.tools.find((tool) => tool.name === "tdei_find_datasets");
    assert.match(find?.description ?? "", /latest dataset for Seattle/i);

    const membership = await client.callTool({
      name: "tdei_list_my_project_groups",
      arguments: {},
    });
    const first = membership.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.equal(body.status, "unsupported");

    const upload = await client.callTool({
      name: "tdei_upload_dataset",
      arguments: { dataType: "osw" },
    });
    const uploadFirst = upload.content[0];
    const uploadBody = JSON.parse(
      uploadFirst?.type === "text" ? uploadFirst.text : "{}",
    );
    assert.equal(uploadBody.status, "needs_input");
    assert.ok(uploadBody.missing.some((item: { field: string }) =>
      item.field === "metadata.dataset_detail.name"
    ));
  } finally {
    await client.close();
  }
});
