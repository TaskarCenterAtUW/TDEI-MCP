import { strict as assert } from "assert";
import test from "node:test";

import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";

import {
  createServer,
  type ServerDependencies,
} from "../src/index.js";
import { registerAwsTools } from "../src/aws/register-aws-tools.js";


test("include delayed API tools in the first list, call, logout, and recover", async () => {
  let childConnected = false;
  let closeCount = 0;
  let listCount = 0;
  let serviceCallCount = 0;
  let logoutCount = 0;
  const logoutEvents: string[] = [];

  const awsClient = {
    async listTools() {
      childConnected = true;
      listCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));

      return {
        tools: [
          {
            name: "listServices",
            description: "List TDEI services.",
            inputSchema: {
              type: "object" as const,
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    },
    async callTool(
      name: string,
      _args: Record<string, unknown>,
    ) {
      assert.equal(name, "listServices");
      assert.equal(childConnected, true);
      serviceCallCount += 1;

      return {
        content: [
          {
            type: "text" as const,
            text: `services-call-${serviceCallCount}`,
          },
        ],
      };
    },
    async close() {
      closeCount += 1;
      childConnected = false;
      logoutEvents.push("child-closed");
    },
  };

  const dependencies: ServerDependencies = {
    authManager: {
      async getAccessToken() {
        return "test-token";
      },
      getStatus() {
        return {
          configured: true,
          authenticated: childConnected,
        };
      },
      logout() {
        logoutCount += 1;
        logoutEvents.push("tokens-cleared");
      },
    },
    awsMcpClient: awsClient,
    registerAwsTools,
  };

  const server = await createServer(dependencies);
  const client = new Client({
    name: "session-lifecycle-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const initialTools = await client.listTools();
    assert.ok(
      initialTools.tools.some((tool) => tool.name === "listServices"),
      "The first tool list must include API tools even when discovery is delayed",
    );
    await client.callTool({
      name: "listServices",
      arguments: {},
    });

    assert.equal(listCount, 1);
    assert.equal(serviceCallCount, 1);

    await client.callTool({
      name: "tdei_logout",
      arguments: {},
    });

    assert.equal(childConnected, false);
    assert.equal(closeCount, 1);
    assert.equal(logoutCount, 1);
    assert.deepEqual(logoutEvents, [
      "child-closed",
      "tokens-cleared",
    ]);

    await client.callTool({
      name: "tdei_load_api_tools",
      arguments: {},
    });
    await client.callTool({
      name: "listServices",
      arguments: {},
    });

    assert.equal(childConnected, true);
    assert.equal(listCount, 2);
    assert.equal(serviceCallCount, 2);
  } finally {
    await client.close();
  }
});

test("automatic loading failure leaves the outer server available", async () => {
  let signalLoadAttempted!: () => void;
  const loadAttempted = new Promise<void>((resolve) => {
    signalLoadAttempted = resolve;
  });

  const dependencies: ServerDependencies = {
    authManager: {
      async getAccessToken() {
        throw new Error("TDEI_AUTH_REQUIRED");
      },
      getStatus() {
        return {
          configured: false,
          authenticated: false,
        };
      },
      logout() {},
    },
    awsMcpClient: {
      async listTools() {
        throw new Error("TDEI_AUTH_REQUIRED");
      },
      async callTool() {
        throw new Error("TDEI_AUTH_REQUIRED");
      },
      async close() {},
    },
    async registerAwsTools() {
      signalLoadAttempted();
      throw new Error("TDEI_AUTH_REQUIRED");
    },
  };

  const server = await createServer(dependencies);
  const client = new Client({
    name: "automatic-load-failure-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await loadAttempted;

    const result = await client.callTool({
      name: "tdei_auth_status",
      arguments: {},
    });

    assert.equal(result.isError, undefined);
    assert.match(
      result.content[0]?.type === "text"
        ? result.content[0].text
        : "",
      /"configured": false/,
    );
  } finally {
    await client.close();
  }
});
