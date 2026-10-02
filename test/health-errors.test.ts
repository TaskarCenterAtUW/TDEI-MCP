import { strict as assert } from "node:assert";
import test from "node:test";

import { formatError, truncateText, MAX_OUTPUT_BYTES } from "../src/mcp/errors.js";

test("formatError maps SSO-required to coded JSON", () => {
  const result = formatError(new Error("TDEI_SSO_REQUIRED"));
  assert.equal(result.isError, true);
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_SSO_REQUIRED");
  assert.match(body.hint, /tdei_sso_login/);
  assert.equal(body.retryable, false);
});

test("formatError surfaces backend permission on 403", () => {
  const result = formatError({ status: 403, body: { message: "requires project-group admin" } });
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_FORBIDDEN");
  assert.match(body.message, /project-group admin/);
  assert.equal(body.retryable, false);
});

test("formatError maps 5xx to retryable upstream error", () => {
  const result = formatError({ status: 503, body: "unavailable" });
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_UPSTREAM_5XX");
  assert.equal(body.retryable, true);
});

test("truncateText caps at 256KB with flag", () => {
  const big = "x".repeat(MAX_OUTPUT_BYTES + 100);
  const { text, truncated } = truncateText(big);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES + 500);
  assert.match(text, /"truncated":true/);
  const small = truncateText("hello");
  assert.equal(small.truncated, false);
  assert.equal(small.text, "hello");
});

test("tdei-client.ts is gone", async () => {
  const { execSync } = await import("node:child_process");
  // Scoped to src: no production code may reference the deleted dead client.
  const hits = execSync("grep -rn 'tdei-client\\|tdeiRequest\\|TdeiApiError' src --include='*.ts' || true", { encoding: "utf-8" }).trim();
  assert.equal(hits, "");
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createServer } from "../src/server.js";
import { hashToken } from "../src/mcp/log.js";

test("logger hashes tokens in json mode", async () => {
  process.env.LOG_LEVEL = "json";
  const lines: string[] = [];
  const originalError = console.error;
  console.error = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.error;
  try {
    const { log } = await import("../src/mcp/log.js");
    log("error", "probe failed", { tool: "tdei_health", sessionHash: hashToken("secret-token-abc") });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, "error");
    assert.equal(parsed.tool, "tdei_health");
    assert.ok(!lines[0].includes("secret-token-abc"));
    assert.match(parsed.sessionHash, /^[0-9a-f]{12}$/);
  } finally {
    console.error = originalError;
    delete process.env.LOG_LEVEL;
  }
});

test("tdei_health works signed-out with stubbed probes", async () => {
  const { checkHealth } = await import("../src/server.js");
  const report = await checkHealth(
    {
      auth: { getStatus: () => ({ configured: true, authenticated: false, state: "signed_out" as const, loginMethod: "sso" as const }) },
      aws: { isConnected: () => false },
    },
    {
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      runUvx: (async () => "uvx 0.12.7") as () => Promise<string>,
      canBind: (async () => true) as () => Promise<boolean>,
    },
  );
  assert.equal(report.ok, true);
  assert.equal(report.auth.state, "signed_out");
  assert.equal(report.spec.reachable, true);
  assert.equal(report.uvx.found, true);
  assert.equal(report.callback.portFree, true);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("secret"));
});

test("tdei_health tool is listed and callable", async () => {
  const awsStub = {
    async listTools() { return { tools: [] }; },
    async callTool() { throw new Error("TDEI_SSO_REQUIRED"); },
    async close() {},
    isConnected: () => false,
  };
  const { registerAwsTools } = await import("../src/aws/register-aws-tools.js");
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { throw new Error("TDEI_SSO_REQUIRED"); },
      getStatus: () => ({ configured: true, authenticated: false, state: "signed_out" as const, loginMethod: "sso" as const }),
      getTokenVersion: () => 1,
      async logout() { throw new Error("not used"); },
    },
    awsMcpClient: awsStub,
    registerAwsTools,
  });
  const client = new Client({ name: "health-tool-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "tdei_health"));
    const result = await client.callTool({ name: "tdei_health", arguments: {} });
    const first = result.content[0];
    const body = JSON.parse(String(first.type === "text" ? first.text : "{}"));
    assert.equal(typeof body.ok, "boolean");
    assert.equal(body.auth.state, "signed_out");
  } finally {
    await client.close();
  }
});
