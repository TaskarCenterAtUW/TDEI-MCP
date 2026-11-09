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

async function toolNamesForProfile(profile: "core" | "workspace"): Promise<string[]> {
  const server = createHttpSemanticServer({ apiUrl: "https://api-dev.tdei.us", profile });
  const client = new Client({ name: "tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

test("workspace servers do not register the core semantic tdei_* tools", async () => {
  const core = await toolNamesForProfile("core");
  const workspace = await toolNamesForProfile("workspace");
  assert.ok(core.includes("tdei_find_datasets"));
  assert.ok(core.includes("tdei_upload_dataset"));
  assert.deepEqual(
    workspace.filter(
      (name) => name.startsWith("tdei_") && !["tdei_sso_login", "tdei_auth_status", "tdei_sso_logout"].includes(name),
    ),
    [],
  );
});

test("core instructions describe the dataset lifecycle and error behaviour", () => {
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /response_props\.tdei_dataset_id/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /valid_from or valid_to/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /409/);
  assert.doesNotMatch(TDEI_WORKSPACE_SERVER_INSTRUCTIONS, /response_props\.tdei_dataset_id/);
});

test("core instructions cover job filters, clone semantics and feedback rules", () => {
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /ABANDONED/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /Dataset-Road-Tag/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /Clone is synchronous/);
  assert.match(TDEI_CORE_SERVER_INSTRUCTIONS, /feedback_id, status/);
});

test("instructions tell each server its environment and require the user to pick one", () => {
  for (const profile of ["core", "workspace"] as const) {
    const shared = tdeiServerInstructions(profile);
    assert.match(shared, /has not named one, ask which environment/);
    assert.match(shared, /for the rest of the conversation/);
    assert.match(shared, /Never silently fall back to another environment/);
    assert.match(shared, /core and workspace servers of the SAME environment/);
    assert.match(shared, /Never pass an id from one environment to a server of a different environment/);

    const dev = tdeiServerInstructions(profile, "dev");
    const prod = tdeiServerInstructions(profile, "prod");
    assert.match(dev, /This server is the dev \(development\) environment/);
    assert.match(prod, /This server is the prod \(production, live data\) environment/);
    assert.doesNotMatch(dev, /This server is the prod/);
  }
  assert.equal(tdeiServerInstructions("core"), TDEI_CORE_SERVER_INSTRUCTIONS);
});
