import assert from "node:assert/strict";

import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";

import { createServer } from "../src/index.js";
import { awsMcpClient } from "../src/aws/aws-mcp-client.js";

const server = await createServer();
const client = new Client({
  name: "tdei-live-session-smoke-test",
  version: "1.0.0",
});
const [clientTransport, serverTransport] =
  InMemoryTransport.createLinkedPair();

await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

async function call(name: string) {
  const result = await client.callTool({
    name,
    arguments: {},
  });

  if (result.isError) {
    const message = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    throw new Error(
      `${name} returned an error: ${message}`,
    );
  }
}

try {
  const automaticLoadDeadline = Date.now() + 30_000;

  while (Date.now() < automaticLoadDeadline) {
    const { tools } = await client.listTools();

    if (tools.some((tool) => tool.name === "listServices")) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const { tools } = await client.listTools();
  assert.ok(
    tools.some((tool) => tool.name === "listServices"),
    "listServices was not loaded automatically",
  );

  await call("listServices");
  await call("tdei_logout");
  assert.equal(awsMcpClient.isConnected(), false);

  await call("tdei_load_api_tools");
  await call("listServices");

  console.log("Live session lifecycle smoke test passed.");
} finally {
  await awsMcpClient.close();
  await client.close();
}
