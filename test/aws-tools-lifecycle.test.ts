import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { AwsToolsLifecycle } from "../src/aws/aws-tools-lifecycle.js";
import { registerAwsTools } from "../src/aws/register-aws-tools.js";
import { createServer } from "../src/index.js";

const schema = { type: "object" as const, properties: { x: { type: "string" } }, additionalProperties: false };
const tools = ["listA", "listB", "cloneDataset"].map((name) => ({ name, description: name, inputSchema: schema }));
const awsSession = {
  async listTools() { return { tools }; },
  async callTool(name: string) { return { content: [{ type: "text" as const, text: name }] }; },
  async close() {},
};
const noMultipart = async () => new Set<string>();
const wf = (name: string, tool = "listA", description = "d") => ({ name, description, steps: [{ id: "s1", tool, ask: ["x"], input: { x: "{{user.x}}" } }] });

const savedPath = process.env.TDEI_CONFIG_PATH;
afterEach(() => { if (savedPath === undefined) delete process.env.TDEI_CONFIG_PATH; else process.env.TDEI_CONFIG_PATH = savedPath; });

function useConfig(obj: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "tdei-lc-")), "tdei.config.json");
  writeFileSync(path, JSON.stringify(obj));
  process.env.TDEI_CONFIG_PATH = path;
  return path;
}

function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
  return fn().then((result) => ({ result, logs }), (e) => { throw e; }).finally(() => { console.error = orig; });
}

function make() {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  const lifecycle = new AwsToolsLifecycle(server as never, { logout: async () => ({}) } as never, awsSession as never, registerAwsTools, noMultipart);
  return { server, lifecycle };
}

async function names(server: McpServer): Promise<string[]> {
  const client = new Client({ name: "lc", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try { return (await client.listTools()).tools.map((t) => t.name); } finally { await client.close(); }
}

test("unknown operationId in allow list falls back to allow-all with a warning", async () => {
  useConfig({ endpoints: { mode: "allow", allow: ["listA", "typo"] } });
  const { server, lifecycle } = make();
  const { logs } = await quiet(() => lifecycle.load());
  assert.deepEqual((await names(server)).sort(), ["cloneDataset", "listA", "listB"]);
  assert.match(logs.join("\n"), /unknown operationId.*endpoints\.allow\[1\] "typo".*allow-all/s);
});

test("reload registers a workflow added to the config after startup", async () => {
  const path = useConfig({});
  const { server, lifecycle } = make();
  await quiet(() => lifecycle.load());
  writeFileSync(path, JSON.stringify({ workflows: [wf("w")] }));
  const { result } = await quiet(() => lifecycle.reload());
  assert.deepEqual(result.problems, []);
  assert.ok((await names(server)).includes("workflow_w"));
});

test("reload reports rejected workflows and still registers the valid ones", async () => {
  const path = useConfig({});
  const { server, lifecycle } = make();
  await quiet(() => lifecycle.load());
  writeFileSync(path, JSON.stringify({ workflows: [wf("good"), wf("bad", "nope")] }));
  const { result } = await quiet(() => lifecycle.reload());
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /workflow "bad" rejected.*workflows\.bad\.steps\.s1\.tool "nope" is not present/s);
  const n = await names(server);
  assert.ok(n.includes("workflow_good") && !n.includes("workflow_bad"));
});

test("reload of a changed existing workflow is reported as a duplicate needing restart", async () => {
  const path = useConfig({ workflows: [wf("w")] });
  const { lifecycle } = make();
  await quiet(() => lifecycle.load());
  writeFileSync(path, JSON.stringify({ workflows: [wf("w", "listA", "changed")] }));
  const { result } = await quiet(() => lifecycle.reload());
  assert.match(result.problems.join("\n"), /duplicate workflow.*"w".*restart/s);
});

test("a filtered-out tool in a workflow is rejected as not present", async () => {
  useConfig({ endpoints: { mode: "deny", deny: ["listB"] }, workflows: [wf("w", "listB")] });
  const { lifecycle } = make();
  const { result } = await quiet(() => lifecycle.reload());
  assert.match(result.problems.join("\n"), /not present: disabled by endpoints config/);
});

test("an unwritable default config location does not break loading", async () => {
  process.env.TDEI_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), "tdei-lc-")), "missing-dir", "tdei.config.json");
  const { server, lifecycle } = make();
  const { logs } = await quiet(() => lifecycle.load());
  assert.equal((await names(server)).length, 3);
  assert.match(logs.join("\n"), /could not create the default config file.*TDEI_CONFIG_PATH/s);
});

test("tdei_reload_config tool reloads and returns a confirmation", async () => {
  useConfig({});
  const server = await createServer({
    authManager: { getAccessToken: async () => "t", getStatus: () => ({ configured: true, authenticated: false, state: "signed_out", loginMethod: "sso" }), logout: async () => ({}), startSsoLogin: async () => ({}) } as never,
    awsMcpClient: awsSession as never,
    registerAwsTools,
  });
  const client = new Client({ name: "rc", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = await quiet(() => client.callTool({ name: "tdei_reload_config", arguments: {} }));
    const text = (res.result.content as Array<{ text: string }>).map((c) => c.text).join("\n");
    assert.match(text, /TDEI config reloaded: reloaded/);
    assert.ok(!res.result.isError);
  } finally { await client.close(); }
});
