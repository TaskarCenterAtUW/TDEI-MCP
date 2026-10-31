import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { OpenApiToolsLifecycle } from "../src/openapi/openapi-tools-lifecycle.js";
import { registerTdeiOpenApiTools } from "../src/tdei/register-openapi-tools.js";
import { createServer } from "../src/server.js";

function listServicesTool() {
  return {
    name: "listServices",
    description: "List TDEI services.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  };
}

function makeAuth() {
  let tokenVersion = 1;
  return {
    getTokenVersion: () => tokenVersion,
    bumpVersion: () => {
      tokenVersion += 1;
    },
    async logout() {
      return {
        logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
        callbackUrl: "http://127.0.0.1:8765/callback",
        completion: Promise.resolve(),
      };
    },
  };
}

function makeOpenApi() {
  let closes = 0;
  return {
    get closes() {
      return closes;
    },
    async listTools() {
      return { tools: [listServicesTool()] };
    },
    async callTool(name: string, _args: Record<string, unknown>) {
      assert.equal(name, "listServices");
      return { content: [{ type: "text" as const, text: "services" }] };
    },
    async close() {
      closes += 1;
    },
  };
}

test("token rollover does not reset the in-process OpenAPI provider", async () => {
  const auth = makeAuth();
  const openapi = makeOpenApi();
  const server = await createServer({
    authManager: {
      async startSsoLogin() {
        throw new Error("not used");
      },
      async getAccessToken() {
        return "test-token";
      },
      getStatus: () => ({
        configured: true,
        authenticated: true,
        state: "authenticated" as const,
        loginMethod: "sso" as const,
      }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    openApiMcpClient: openapi,
    registerTdeiOpenApiTools,
  });
  const lifecycle = new OpenApiToolsLifecycle(server, auth, openapi, registerTdeiOpenApiTools);
  await lifecycle.load();
  await lifecycle.callTool("listServices", {});
  assert.equal(openapi.closes, 0);
  auth.bumpVersion();
  await lifecycle.callTool("listServices", {});
  assert.equal(openapi.closes, 0);
  await lifecycle.callTool("listServices", {});
  assert.equal(openapi.closes, 0);
});

test("concurrent calls during token refresh keep the provider loaded", async () => {
  const auth = makeAuth();
  const openapi = makeOpenApi();
  const server = await createServer({
    authManager: {
      async startSsoLogin() {
        throw new Error("not used");
      },
      async getAccessToken() {
        return "test-token";
      },
      getStatus: () => ({
        configured: true,
        authenticated: true,
        state: "authenticated" as const,
        loginMethod: "sso" as const,
      }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    openApiMcpClient: openapi,
    registerTdeiOpenApiTools,
  });
  const lifecycle = new OpenApiToolsLifecycle(server, auth, openapi, registerTdeiOpenApiTools);
  await lifecycle.load();
  auth.bumpVersion();
  await Promise.all([
    lifecycle.callTool("listServices", {}),
    lifecycle.callTool("listServices", {}),
    lifecycle.callTool("listServices", {}),
  ]);
  assert.equal(openapi.closes, 0);
});

test("logout resets the provider so next load starts fresh", async () => {
  const auth = makeAuth();
  const openapi = makeOpenApi();
  const server = await createServer({
    authManager: {
      async startSsoLogin() {
        throw new Error("not used");
      },
      async getAccessToken() {
        return "test-token";
      },
      getStatus: () => ({
        configured: true,
        authenticated: true,
        state: "authenticated" as const,
        loginMethod: "sso" as const,
      }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    openApiMcpClient: openapi,
    registerTdeiOpenApiTools,
  });
  const lifecycle = new OpenApiToolsLifecycle(server, auth, openapi, registerTdeiOpenApiTools);
  await lifecycle.load();
  await lifecycle.logout();
  auth.bumpVersion();
  await lifecycle.load();
  assert.equal(openapi.closes, 1);
});

test("registered tool handlers keep using the loaded provider after token rollover", async () => {
  const auth = makeAuth();
  const openapi = makeOpenApi();
  const server = await createServer({
    authManager: {
      async startSsoLogin() {
        throw new Error("not used");
      },
      async getAccessToken() {
        return "test-token";
      },
      getStatus: () => ({
        configured: true,
        authenticated: true,
        state: "authenticated" as const,
        loginMethod: "sso" as const,
      }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    openApiMcpClient: openapi,
    registerTdeiOpenApiTools,
  });
  const client = new Client({ name: "rollover-closure-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await client.callTool({ name: "listServices", arguments: {} });
    assert.equal(openapi.closes, 0);
    auth.bumpVersion();
    await client.callTool({ name: "listServices", arguments: {} });
    assert.equal(openapi.closes, 0);
  } finally {
    await client.close();
  }
});
