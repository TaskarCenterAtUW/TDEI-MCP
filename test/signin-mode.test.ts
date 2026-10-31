import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createHttpSemanticServer } from "../src/http-semantic-server.js";
import { formatError, setSignInMode } from "../src/mcp/errors.js";
import { serveTestHttp } from "./helpers/test-http-server.js";

test("tool mode names tdei_sso_login while gateway/bearer modes do not", () => {
  try {
    setSignInMode("tool");
    const tool = formatError(new Error("TDEI_SSO_REQUIRED"));
    assert.match(String(JSON.parse(String(tool.content[0].text)).message), /tdei_sso_login/);
    assert.match(String(JSON.parse(String(tool.content[0].text)).hint), /tdei_sso_login/);

    setSignInMode("gateway");
    const gateway = formatError(new Error("TDEI_SSO_REQUIRED"));
    const gatewayBody = JSON.parse(String(gateway.content[0].text)) as { message: string; hint: string };
    assert.match(gatewayBody.message, /Reconnect this MCP server/);
    assert.doesNotMatch(gatewayBody.message, /tdei_sso_login/);
    assert.doesNotMatch(gatewayBody.hint, /tdei_sso_login/);

    setSignInMode("bearer");
    const bearer = formatError(new Error("TDEI_TOKEN_INVALID"));
    const bearerBody = JSON.parse(String(bearer.content[0].text)) as { message: string; hint: string };
    assert.match(bearerBody.message, /Authorization: Bearer header/);
    assert.doesNotMatch(bearerBody.message, /tdei_sso_login/);
    assert.doesNotMatch(bearerBody.hint, /tdei_sso_login/);
  } finally {
    setSignInMode("tool");
  }
});

test("bearer-path tools/list and every description omit tdei_sso_login", async () => {
  setSignInMode("bearer");
  try {
    const server = createHttpSemanticServer({ accessToken: "bearer-token", apiUrl: "https://api.example.test" });
    const client = new Client({ name: "signin-mode-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.length > 0);
      for (const tool of tools.tools) {
        assert.notEqual(tool.name, "tdei_sso_login");
        assert.doesNotMatch(tool.description ?? "", /tdei_sso_login/);
      }
    } finally {
      await client.close();
    }
  } finally {
    setSignInMode("tool");
  }
});

test("gateway 401 body does not name tdei_sso_login", async () => {
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    const response = await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, "TDEI_SSO_REQUIRED");
    assert.doesNotMatch(String(body.message), /tdei_sso_login/);
  } finally {
    await handle.close();
    setSignInMode("tool");
  }
});
