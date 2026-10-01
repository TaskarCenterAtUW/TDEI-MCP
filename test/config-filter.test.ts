import { strict as assert } from "node:assert";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerAwsTools } from "../src/aws/register-aws-tools.js";

function fakeClient(names: string[]) {
  return {
    async listTools() {
      return { tools: names.map((name) => ({ name, description: `${name} desc`, inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } })) };
    },
    async callTool(name: string, _args: Record<string, unknown>) {
      return { content: [{ type: "text" as const, text: name }] };
    },
  };
}

async function toolNames(server: McpServer): Promise<string[]> {
  const client = new Client({ name: "filter-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try { return (await client.listTools()).tools.map((t) => t.name); }
  finally { await client.close(); }
}

test("mode:deny hides cloneDataset but keeps built-ins", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  const result = await registerAwsTools(server as never, fakeClient(["listServices", "cloneDataset"]) as never, { mode: "deny", allow: [], deny: ["cloneDataset"] });
  assert.equal(result.skipped, 1);
  const names = await toolNames(server);
  assert.ok(names.includes("listServices"));
  assert.ok(!names.includes("cloneDataset"));
});

test("mode:allow shows only listed plus immune auth tools", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  await registerAwsTools(server as never, fakeClient(["listServices", "cloneDataset", "authenticate"]) as never, { mode: "allow", allow: ["listServices"], deny: [] });
  const names = await toolNames(server);
  assert.ok(names.includes("listServices"));
  assert.ok(!names.includes("cloneDataset"));
  assert.ok(!names.includes("authenticate"));
});

test("mode:all registers everything except connector-managed auth", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  const result = await registerAwsTools(server as never, fakeClient(["listServices", "ssoLogin"]) as never, { mode: "all", allow: [], deny: [] });
  assert.equal(result.registered, 1);
  assert.equal(result.skipped, 1);
});

test("direct call to a denied tool reports the tool is not present", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  await registerAwsTools(server as never, fakeClient(["listServices", "cloneDataset"]) as never, { mode: "deny", allow: [], deny: ["cloneDataset"] });
  const client = new Client({ name: "filter-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    let message = "";
    try {
      const res = await client.callTool({ name: "cloneDataset", arguments: {} });
      message = JSON.stringify(res);
    } catch (error) { message = String(error); }
    assert.match(message, /not found|not present|unknown tool/i);
  } finally { await client.close(); }
});
