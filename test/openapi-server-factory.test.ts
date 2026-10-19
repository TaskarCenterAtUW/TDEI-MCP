import { strict as assert } from "node:assert";
import test from "node:test";

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as z from "zod/v4";

import {
  bearerHeadersForRequest,
  createOpenApiMcpServer,
  serveOpenApiHttp,
} from "../src/openapi/index.js";

const petSpec = {
  openapi: "3.0.1",
  paths: {
    "/pets": {
      get: {
        operationId: "list-pets",
        responses: { "200": { description: "OK" } },
      },
      post: {
        operationId: "create-pet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
    "/admin/purge": {
      delete: {
        operationId: "purge-all-pets",
        responses: { "204": { description: "Purged" } },
      },
    },
  },
};

test("generic factory prefixes, filters, and configures a second API", async () => {
  const context = await createOpenApiMcpServer({
    name: "pet-api-mcp",
    version: "1.0.0",
    apiUrl: "https://pets.example.test",
    loadSpec: async () => structuredClone(petSpec),
    toolPrefix: "pet_",
    excludeOperations: new Set(["pet_purge_all_pets"]),
    configure: ({ server }) => {
      server.registerTool(
        "pet_health",
        { description: "Health", inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    },
  });
  const client = new Client({ name: "pet-factory-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    context.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["pet_create_pet", "pet_health", "pet_list_pets"]);
  } finally {
    await client.close();
    await context.provider.close();
  }
});

test("generic Streamable HTTP forwards an isolated request bearer", async () => {
  const upstreamRequests: Request[] = [];
  let specificationLoads = 0;
  const handle = await serveOpenApiHttp(
    {
      name: "pet-api-mcp",
      version: "1.0.0",
      apiUrl: "https://pets.example.test",
      loadSpec: async () => {
        specificationLoads += 1;
        return structuredClone(petSpec);
      },
      includeOperations: new Set(["list_pets"]),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        upstreamRequests.push(request);
        return Response.json([{ name: "Milo" }]);
      },
    },
    {
      port: 0,
      headersForRequest: bearerHeadersForRequest,
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { Authorization: "Bearer request-token" } },
  });
  const client = new Client({ name: "pet-http-test", version: "1.0.0" });
  try {
    const unauthorized = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(specificationLoads, 0);
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["list_pets"]);
    const result = await client.callTool({ name: "list_pets", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0]?.headers.get("Authorization"), "Bearer request-token");
    assert.equal(specificationLoads, 1);
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
  }
});

test("generic stdio serves and executes a second API specification", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "test/fixtures/generic-openapi-stdio.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "pet-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["get_pet"]);
    const result = await client.callTool({
      name: "get_pet",
      arguments: { pet_id: "pet/1" },
    });
    const content = result.content[0];
    assert.equal(content?.type, "text");
    assert.deepEqual(
      JSON.parse(content?.type === "text" ? content.text : "{}"),
      { path: "/pets/pet%2F1", apiKey: "stdio-secret" },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
});
