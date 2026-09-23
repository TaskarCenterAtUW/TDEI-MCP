import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createServer, type ServerDependencies } from "../src/index.js";
import { registerAwsTools } from "../src/aws/register-aws-tools.js";

function signedOutStatus() {
  return {
    configured: true,
    authenticated: false,
    state: "signed_out" as const,
    loginMethod: "sso" as const,
  };
}

test("SSO login loads API tools and supports calls and logout", async () => {
  let completeLogin!: () => void;
  const completion = new Promise<void>((resolve) => {
    completeLogin = resolve;
  });
  let authenticated = false;
  let closeCount = 0;
  let serviceCallCount = 0;
  let logoutCount = 0;

  const awsClient = {
    async listTools() {
      return {
        tools: [
          {
            name: "listServices",
            description: "List TDEI services.",
            inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          },
          ...["authenticate", "refreshToken", "ssoRedirect", "ssoLogin", "ssoLogout"].map((name) => ({
            name,
            description: `Raw auth operation ${name}`,
            inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          })),
        ],
      };
    },
    async callTool(name: string, _args: Record<string, unknown>) {
      assert.equal(authenticated, true, "API calls require completed SSO");
      assert.equal(name, "listServices");
      serviceCallCount += 1;
      return { content: [{ type: "text" as const, text: "services" }] };
    },
    async close() {
      closeCount += 1;
    },
  };

  const dependencies: ServerDependencies = {
    authManager: {
      async startSsoLogin() {
        return {
          loginUrl: "https://api-dev.tdei.us/api/v1/sso-redirect?test=1",
          callbackUrl: "http://127.0.0.1:8765/callback",
          completion: completion.then(() => { authenticated = true; }),
        };
      },
      async getAccessToken() {
        if (!authenticated) throw new Error("TDEI_SSO_REQUIRED");
        return "test-token";
      },
      getStatus() {
        return authenticated
          ? { ...signedOutStatus(), authenticated: true, state: "authenticated" as const }
          : signedOutStatus();
      },
      async logout() {
        authenticated = false;
        logoutCount += 1;
        return {
          logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
          callbackUrl: "http://127.0.0.1:8765/callback",
          completion: Promise.resolve(),
        };
      },
    },
    awsMcpClient: awsClient,
    registerAwsTools,
  };

  const server = await createServer(dependencies);
  const client = new Client({ name: "session-lifecycle-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const initialTools = await client.listTools();
    assert.ok(initialTools.tools.some((tool) => tool.name === "tdei_sso_login"));
    assert.ok(
      initialTools.tools.some((tool) => tool.name === "listServices"),
      "API tools must be present in the initial catalogue before SSO",
    );

    const login = await client.callTool({ name: "tdei_sso_login", arguments: {} });
    assert.match(login.content[0]?.type === "text" ? login.content[0].text : "", /loginUrl/);
    completeLogin();

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const tools = await client.listTools();
      if (tools.tools.some((tool) => tool.name === "listServices")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const loadedTools = await client.listTools();
    assert.ok(loadedTools.tools.some((tool) => tool.name === "listServices"));
    for (const name of ["authenticate", "refreshToken", "ssoRedirect", "ssoLogin", "ssoLogout"]) {
      assert.ok(
        !loadedTools.tools.some((tool) => tool.name === name),
        `${name} must remain hidden because the connector manages authentication`,
      );
    }
    await client.callTool({ name: "listServices", arguments: {} });
    assert.equal(serviceCallCount, 1);

    const logout = await client.callTool({ name: "tdei_logout", arguments: {} });
    assert.match(logout.content[0]?.type === "text" ? logout.content[0].text : "", /logoutUrl/);
    assert.equal(closeCount, 1);
    assert.equal(logoutCount, 1);
  } finally {
    await client.close();
  }
});

test("signed-out server remains available for SSO login", async () => {
  const neverCompletes = new Promise<void>(() => {});
  const dependencies: ServerDependencies = {
    authManager: {
      async startSsoLogin() {
        return {
          loginUrl: "https://api-dev.tdei.us/api/v1/sso-redirect?test=1",
          callbackUrl: "http://127.0.0.1:8765/callback",
          completion: neverCompletes,
        };
      },
      async getAccessToken() { throw new Error("TDEI_SSO_REQUIRED"); },
      getStatus: signedOutStatus,
      async logout() {
        return {
          logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
          callbackUrl: "http://127.0.0.1:8765/callback",
          completion: Promise.resolve(),
        };
      },
    },
    awsMcpClient: {
      async listTools() { throw new Error("TDEI_SSO_REQUIRED"); },
      async callTool() { throw new Error("TDEI_SSO_REQUIRED"); },
      async close() {},
    },
    registerAwsTools,
  };

  const server = await createServer(dependencies);
  const client = new Client({ name: "signed-out-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({ name: "tdei_auth_status", arguments: {} });
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /"state": "signed_out"/);
  } finally {
    await client.close();
  }
});
