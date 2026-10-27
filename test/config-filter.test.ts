import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { isToolAllowed, loadConfigFile } from "../src/config-file.js";
import { OpenApiToolsLifecycle } from "../src/openapi/openapi-tools-lifecycle.js";
import { registerTdeiOpenApiTools } from "../src/tdei/register-openapi-tools.js";

function fakeClient(names: Array<string | { name: string; tags?: string[]; description?: string }>) {
  return {
    async listTools() {
      return {
        tools: names.map((entry) => {
          const item = typeof entry === "string" ? { name: entry } : entry;
          return {
            name: item.name,
            description: item.description ?? `${item.name} desc`,
            ...(item.tags ? { tags: item.tags } : {}),
            inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          };
        }),
      };
    },
    async callTool(name: string, _args: Record<string, unknown>) {
      return { content: [{ type: "text" as const, text: name }] };
    },
    async close() {},
  };
}

async function listRegisteredTools(server: McpServer): Promise<Array<{ name: string; description?: string }>> {
  const client = new Client({ name: "filter-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try { return (await client.listTools()).tools; }
  finally { await client.close(); }
}

async function toolNames(server: McpServer): Promise<string[]> {
  return (await listRegisteredTools(server)).map((t) => t.name);
}

test("mode:deny hides cloneDataset but keeps built-ins", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  const result = await registerTdeiOpenApiTools(server as never, fakeClient(["listServices", "cloneDataset"]) as never, { mode: "deny", allow: [], deny: ["cloneDataset"] });
  assert.equal(result.skipped, 1);
  const names = await toolNames(server);
  assert.ok(names.includes("listServices"));
  assert.ok(!names.includes("cloneDataset"));
});

test("mode:allow shows only listed plus immune auth tools", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  await registerTdeiOpenApiTools(server as never, fakeClient(["listServices", "cloneDataset", "authenticate"]) as never, { mode: "allow", allow: ["listServices"], deny: [] });
  const names = await toolNames(server);
  assert.ok(names.includes("listServices"));
  assert.ok(!names.includes("cloneDataset"));
  assert.ok(!names.includes("authenticate"));
});

test("mode:all registers everything except connector-managed auth", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  const result = await registerTdeiOpenApiTools(server as never, fakeClient(["listServices", "ssoLogin"]) as never, { mode: "all", allow: [], deny: [] });
  assert.equal(result.registered, 1);
  assert.equal(result.skipped, 1);
});

test("allowTags registers only tools matching allowed tags and prefixes descriptions", async () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  const client = fakeClient([
    { name: "uploadOsw", tags: ["OSW"], description: "Upload OSW dataset" },
    { name: "uploadFlex", tags: ["GTFS Flex"], description: "[Deprecated] Upload Flex" },
    { name: "listServices", tags: ["Common APIs", "OSW"], description: "[Common APIs, OSW] List services" },
  ]);
  const result = await registerTdeiOpenApiTools(
    server as never,
    client as never,
    { mode: "all", allow: [], deny: [], allowTags: ["OSW"], denyTags: [] },
  );
  assert.equal(result.registered, 2);
  assert.equal(result.skipped, 1);
  const tools = await listRegisteredTools(server);
  assert.deepEqual(tools.map((t) => t.name), ["uploadOsw", "listServices"]);
  assert.equal(tools.find((t) => t.name === "uploadOsw")?.description, "[OSW] Upload OSW dataset");
  assert.equal(tools.find((t) => t.name === "listServices")?.description, "[Common APIs, OSW] List services");
});

test("denyTags overrides allowTags and mode:allow while preserving built-in tools", () => {
  const filter = {
    mode: "allow" as const,
    allow: ["uploadFlex", "uploadOsw"],
    deny: [],
    allowTags: ["OSW", "GTFS Flex"],
    denyTags: ["GTFS Flex"],
  };
  assert.equal(isToolAllowed("uploadFlex", filter, ["GTFS Flex"]), false);
  assert.equal(isToolAllowed("uploadFlex", filter, ["OSW", "GTFS Flex"]), false);
  assert.equal(isToolAllowed("uploadOsw", filter, ["OSW"]), true);
  assert.equal(isToolAllowed("tdei_health", filter, ["GTFS Flex"]), true);
});

test("loadConfigFile parses allowTags and denyTags and lifecycle enforces tag denial", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tdei-cfg-tags-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "tdei.config.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      endpoints: {
        mode: "all",
        allow: [],
        deny: [],
        allowTags: ["OSW"],
        denyTags: ["GTFS Flex"],
      },
      workflows: [],
    }),
  );
  const loaded = loadConfigFile(cfgPath);
  assert.deepEqual(loaded.filter.allowTags, ["OSW"]);
  assert.deepEqual(loaded.filter.denyTags, ["GTFS Flex"]);

  const prevEnv = process.env.TDEI_CONFIG_PATH;
  process.env.TDEI_CONFIG_PATH = cfgPath;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.TDEI_CONFIG_PATH;
    else process.env.TDEI_CONFIG_PATH = prevEnv;
  });

  const server = new McpServer({ name: "t", version: "1.0.0" });
  const openapi = fakeClient([
    { name: "uploadOsw", tags: ["OSW"] },
    { name: "uploadFlex", tags: ["GTFS Flex"] },
    { name: "untaggedTool" },
  ]);
  const auth = {
    getTokenVersion: () => 1,
    async logout() {
      return { logoutUrl: "https://example.com", callbackUrl: "http://127.0.0.1:8765/cb", completion: Promise.resolve() };
    },
  };
  const lifecycle = new OpenApiToolsLifecycle(server, auth, openapi, registerTdeiOpenApiTools);
  await lifecycle.load();
  assert.equal(lifecycle.isDenied("uploadOsw"), false);
  assert.equal(lifecycle.isDenied("uploadFlex"), true);
  assert.equal(lifecycle.isDenied("untaggedTool"), true);
  assert.deepEqual(await toolNames(server), ["uploadOsw"]);
});

test("lifecycle falls back to allow-all when config contains unknown tags", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tdei-cfg-unk-tags-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "tdei.config.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      endpoints: {
        mode: "all",
        allow: [],
        deny: [],
        allowTags: ["NonExistentTag"],
        denyTags: [],
      },
      workflows: [],
    }),
  );
  const prevEnv = process.env.TDEI_CONFIG_PATH;
  process.env.TDEI_CONFIG_PATH = cfgPath;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.TDEI_CONFIG_PATH;
    else process.env.TDEI_CONFIG_PATH = prevEnv;
  });

  const server = new McpServer({ name: "t", version: "1.0.0" });
  const openapi = fakeClient([
    { name: "uploadOsw", tags: ["OSW"] },
    { name: "uploadFlex", tags: ["GTFS Flex"] },
  ]);
  const auth = {
    getTokenVersion: () => 1,
    async logout() {
      return { logoutUrl: "https://example.com", callbackUrl: "http://127.0.0.1:8765/cb", completion: Promise.resolve() };
    },
  };
  const lifecycle = new OpenApiToolsLifecycle(server, auth, openapi, registerTdeiOpenApiTools);
  await lifecycle.load();
  assert.equal(lifecycle.isDenied("uploadOsw"), false);
  assert.equal(lifecycle.isDenied("uploadFlex"), false);
  assert.deepEqual(await toolNames(server), ["uploadOsw", "uploadFlex"]);
});
