import assert from "node:assert/strict";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createServer } from "../src/index.js";
import { awsMcpClient } from "../src/aws/aws-mcp-client.js";

const server = await createServer();
const client = new Client({ name: "tdei-live-session-smoke-test", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

async function call(name: string) {
  const result = await client.callTool({ name, arguments: {} });
  if (result.isError) {
    const message = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    throw new Error(`${name} returned an error: ${message}`);
  }
  return result;
}

try {
  const login = await call("tdei_sso_login");
  const loginMessage = login.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  console.log("Open the loginUrl below in your browser:\n");
  console.log(loginMessage);

  const loginDeadline = Date.now() + 5 * 60_000;
  while (Date.now() < loginDeadline) {
    const status = await call("tdei_auth_status");
    const statusText = status.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (statusText.includes('"authenticated": true')) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const status = await call("tdei_auth_status");
  const statusText = status.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.match(statusText, /"authenticated": true/, "SSO login did not complete within five minutes");

  const toolDeadline = Date.now() + 30_000;
  while (Date.now() < toolDeadline) {
    const { tools } = await client.listTools();
    if (tools.some((tool) => tool.name === "listServices")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "listServices"), "listServices was not loaded after SSO login");
  await call("listServices");
  await call("tdei_logout");
  assert.equal(awsMcpClient.isConnected(), false);
  console.log("Live SSO session smoke test passed.");
} finally {
  await awsMcpClient.close();
  await client.close();
}
