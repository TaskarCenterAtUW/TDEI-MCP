import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { SEMANTIC_TOOL_DESCRIPTIONS } from "../src/intents/descriptions.js";
import { resolveUserIntent } from "../src/intents/intent-resolver.js";
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

test("every intent route resolves to a registered tool", async () => {
  const server = new McpServer({ name: "registry-routes", version: "1.0.0" });
  registerSemanticTools(server, createModule());
  const client = new Client({ name: "registry-routes-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const registered = new Set(listed.tools.map((tool) => tool.name));
    const probes = [
      "Which projects can I access?",
      "find the latest OSW dataset",
      "list services for my project",
      "validate this GTFS pathways zip",
      "upload this sidewalk dataset",
      "what are my roles?",
      "show my recent uploads",
      "what is the release status of dataset abc-123?",
      "publish this dataset",
      "delete dataset abc-123",
      "clone this dataset",
      "edit the metadata of this dataset",
      "list viewer feedbacks",
      "show data metrics",
      "which osw versions are supported",
      "show system capabilities",
      "verify my email",
      "help me recover my password",
      "regenerate my api key",
      "Validate and upload this dataset",
    ];
    for (const probe of probes) {
      const result = resolveUserIntent(probe);
      const tools =
        result.status === "complete"
          ? [result.data.tool]
          : result.status === "ambiguous"
            ? result.candidates.map((candidate) => candidate.tool)
            : [];
      assert.ok(tools.length > 0, `${probe} should resolve to at least one tool`);
      for (const tool of tools) {
        assert.ok(registered.has(tool), `${probe} routes to unregistered tool ${tool}`);
      }
    }
  } finally {
    await client.close();
  }
});
