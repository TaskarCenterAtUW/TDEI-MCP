import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createHttpSemanticServer } from "../src/http-semantic-server.js";
import {
  resolveTdeiServerProfile,
  TDEI_CORE_SERVER_INSTRUCTIONS,
  TDEI_SHARED_SERVER_INSTRUCTIONS,
  TDEI_WORKSPACE_SERVER_INSTRUCTIONS,
  tdeiServerInstructions,
} from "../src/intents/server-instructions.js";
import { resolveMultiMcp } from "../src/multi-config.js";

test("core dev, staging, and production share one instruction set", () => {
  const names = ["tdei-core-dev", "tdei-core-staging", "tdei-core-production"];
  for (const name of names) {
    assert.equal(resolveTdeiServerProfile({ name, apiUrl: "https://api-dev.tdei.us" }), "core");
    assert.equal(tdeiServerInstructions(resolveTdeiServerProfile({ name })), TDEI_CORE_SERVER_INSTRUCTIONS);
  }
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /TDEI core data server/);
  assert.doesNotMatch(TDEI_CORE_SERVER_INSTRUCTIONS, /TDEI workspace server/);
});

test("workspace gets its own instructions while sharing login and transfer rules", () => {
  assert.equal(resolveTdeiServerProfile({ name: "tdei-workspace" }), "workspace");
  assert.equal(resolveTdeiServerProfile({ apiUrl: "https://ws-backend-dev.azurewebsites.net/" }), "workspace");
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /TDEI workspace server/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /get_my_workspaces/);
  assert.match(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /workspace_id/);

  for (const instructions of [TDEI_CORE_SERVER_INSTRUCTIONS, TDEI_WORKSPACE_SERVER_INSTRUCTIONS]) {
    assert.ok(instructions.includes(TDEI_SHARED_SERVER_INSTRUCTIONS));
    assert.match(instructions, /tdei_sso_login/);
    assert.match(instructions, /CLIENT machine/);
    assert.match(instructions, /file bytes/i);
  }
});

test("explicit profile wins and multi-config derives per-server profiles", () => {
  assert.equal(resolveTdeiServerProfile({ name: "tdei-core-dev", explicit: "workspace" }), "workspace");
  assert.equal(resolveTdeiServerProfile({ name: "tdei-workspace", explicit: "core" }), "core");

  const resolved = resolveMultiMcp({
    servers: [
      { name: "tdei-core-dev", apiUrl: "https://api-dev.tdei.us" },
      { name: "tdei-core-staging", apiUrl: "https://api-stage.tdei.us" },
      { name: "tdei-core-production", apiUrl: "https://api.tdei.us" },
      { name: "tdei-workspace", apiUrl: "https://ws-backend-dev.azurewebsites.net" },
      { name: "custom-ws", apiUrl: "https://api-dev.tdei.us", profile: "workspace" },
    ],
  });
  assert.deepEqual(
    resolved.map((server) => server.profile),
    ["core", "core", "core", "workspace", "workspace"],
  );
});

async function instructionsForProfile(profile: "core" | "workspace"): Promise<string | undefined> {
  const server = createHttpSemanticServer({ apiUrl: "https://api-dev.tdei.us", profile });
  const client = new Client({ name: "instructions-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return client.getInstructions();
  } finally {
    await client.close();
  }
}

test("the MCP handshake advertises the profile-specific instructions", async () => {
  assert.match((await instructionsForProfile("core")) ?? "", /TDEI core data server/);
  assert.match((await instructionsForProfile("workspace")) ?? "", /TDEI workspace server/);
});
