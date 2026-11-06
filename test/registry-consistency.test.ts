import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { SEMANTIC_TOOL_DESCRIPTIONS } from "../src/intents/descriptions.js";
import { TOOL_ROUTING, renderToolRoutingGuide } from "../src/intents/routing-guide.js";
import { TDEI_CORE_SERVER_INSTRUCTIONS } from "../src/intents/server-instructions.js";
import { registerSemanticTools } from "../src/intents/register-tools.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

function createModule() {
  return new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [];
      },
      async listJobs() {
        return [];
      },
    },
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });
}

test("registered tools match the description registry one-to-one", async () => {
  const server = new McpServer({ name: "registry-consistency", version: "1.0.0" });
  registerSemanticTools(server, createModule());
  const client = new Client({ name: "registry-consistency-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const described = Object.keys(SEMANTIC_TOOL_DESCRIPTIONS).length;
    assert.equal(
      listed.tools.length,
      described,
      `registered tools (${listed.tools.length}) must match description entries (${described})`,
    );
    for (const tool of listed.tools) {
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} needs an object input schema`);
    }
    const names = new Set(listed.tools.map((tool) => tool.name));
    assert.equal(names.size, listed.tools.length, "tool names must be unique");
  } finally {
    await client.close();
  }
});

test("the routing guide and the registered semantic tools stay in sync", async () => {
  const server = new McpServer({ name: "registry-routes", version: "1.0.0" });
  registerSemanticTools(server, createModule());
  const client = new Client({ name: "registry-routes-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const registered = new Set(listed.tools.map((tool) => tool.name));
    const guided = TOOL_ROUTING.map((route) => route.tool);
    assert.equal(new Set(guided).size, guided.length, "a tool has two routing lines");
    for (const tool of guided) assert.ok(registered.has(tool), `routing guide names unregistered tool ${tool}`);
    for (const tool of registered) assert.ok(guided.includes(tool), `registered tool ${tool} has no routing line`);
    assert.ok(!registered.has("tdei_resolve_intent"), "the regex intent resolver tool is gone");
  } finally {
    await client.close();
  }
});

test("server instructions carry the routing guide", () => {
  assert.ok(TDEI_CORE_SERVER_INSTRUCTIONS.includes(renderToolRoutingGuide()));
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /organizations\/orgs/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /tdei_list_jobs/);
});
