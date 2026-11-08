import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/server";

import { loadConfig } from "../src/config.js";
import { userApiUrlForApiUrl, userSpecUrlForUserApiUrl } from "../src/init/envs.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";
import { resolveMultiMcp } from "../src/multi-config.js";
import { OpenApiMcpClient } from "../src/openapi/openapi-mcp-client.js";
import { registerTdeiOpenApiTools } from "../src/tdei-core/register-openapi-tools.js";
import { webUiHandoff } from "../src/tdei-shared/web-ui-handoffs.js";
import { createOpenApiClient } from "../src/tdei-user/client.js";
import { CompositeOpenApiClient } from "../src/tdei-user/composite-client.js";
import {
  isUserApiHidden,
  USER_API_HIDDEN,
  USER_API_NEVER_EXPOSED,
  USER_API_TOOL_NAMES,
  userOperationName,
} from "../src/tdei-user/operation-names.js";
import { TDEI_USER_TOOL_INSTRUCTIONS } from "../src/tdei-user/tool-instructions.js";

const spec = JSON.parse(readFileSync(new URL("./fixtures/user-management-spec.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};
const operationIds = Object.values(spec.paths).flatMap((item) =>
  Object.values(item).flatMap((op) => (op.operationId ? [op.operationId] : [])),
);

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("every User API operation is either given a tdei_* name or hidden, and nothing is stale", () => {
  assert.equal(operationIds.length, 32);
  for (const id of operationIds) {
    const name = userOperationName(id);
    const exposed = Object.hasOwn(USER_API_TOOL_NAMES, id);
    assert.ok(exposed || isUserApiHidden(name), `${id} (${name}) must be named or hidden`);
  }
  for (const id of Object.keys(USER_API_TOOL_NAMES)) assert.ok(operationIds.includes(id), `stale name for ${id}`);
  const finalNames = new Set(operationIds.map(userOperationName));
  for (const hidden of Object.keys(USER_API_HIDDEN)) assert.ok(finalNames.has(hidden), `stale hidden entry ${hidden}`);
  for (const never of USER_API_NEVER_EXPOSED) assert.ok(isUserApiHidden(never), `${never} must also be hidden`);
});

test("every exposed User API tool has guidance, and guidance exists only for exposed tools", () => {
  const exposed = Object.values(USER_API_TOOL_NAMES).sort();
  assert.deepEqual(Object.keys(TDEI_USER_TOOL_INSTRUCTIONS).sort(), exposed);
  for (const text of Object.values(TDEI_USER_TOOL_INSTRUCTIONS)) assert.ok(text.length > 20);
  assert.match(TDEI_USER_TOOL_INSTRUCTIONS.portal_create_service ?? "", /poc role/);
  assert.match(TDEI_USER_TOOL_INSTRUCTIONS.portal_assign_project_group_roles ?? "", /registered TDEI email/);
});

test("user API URLs are derived per core environment and can be overridden or disabled", () => {
  assert.equal(userApiUrlForApiUrl("https://api-dev.tdei.us"), "https://portal-api-dev.tdei.us");
  assert.equal(userApiUrlForApiUrl("https://api-stage.tdei.us"), "https://portal-api-stage.tdei.us");
  assert.equal(userApiUrlForApiUrl("https://api.tdei.us/"), "https://portal-api.tdei.us");
  assert.equal(userApiUrlForApiUrl("https://ws-backend-dev.azurewebsites.net"), undefined);
  assert.equal(
    userSpecUrlForUserApiUrl("https://portal-api.tdei.us/"),
    "https://portal-api.tdei.us/api-docs/swagger.json",
  );

  const base = { TDEI_USER_API_URL: undefined, TDEI_USER_SPEC_URL: undefined };
  const derived = withEnv({ ...base, TDEI_API_URL: "https://api-stage.tdei.us" }, () => loadConfig());
  assert.ok(derived.ok);
  if (derived.ok) {
    assert.equal(derived.config.userApiUrl, "https://portal-api-stage.tdei.us");
    assert.equal(derived.config.userSpecUrl, "https://portal-api-stage.tdei.us/api-docs/swagger.json");
  }
  const custom = withEnv({ ...base, TDEI_API_URL: "https://api.example.org" }, () => loadConfig());
  assert.ok(custom.ok);
  if (custom.ok) assert.equal(custom.config.userApiUrl, undefined);
  const off = withEnv({ ...base, TDEI_API_URL: "https://api-dev.tdei.us", TDEI_USER_API_URL: "off" }, () =>
    loadConfig(),
  );
  assert.ok(off.ok);
  if (off.ok) assert.equal(off.config.userApiUrl, undefined);
  const explicit = withEnv(
    { ...base, TDEI_API_URL: "https://api-dev.tdei.us", TDEI_USER_API_URL: "https://portal.example.org" },
    () => loadConfig(),
  );
  assert.ok(explicit.ok);
  if (explicit.ok) assert.equal(explicit.config.userSpecUrl, "https://portal.example.org/api-docs/swagger.json");
  const bad = withEnv({ ...base, TDEI_API_URL: "https://api-dev.tdei.us", TDEI_USER_API_URL: "http://insecure" }, () =>
    loadConfig(),
  );
  assert.equal(bad.ok, false);
});

test("shipped mcps.json gives each core server the User API of its own environment", () => {
  const file = JSON.parse(readFileSync(new URL("../mcps.json", import.meta.url), "utf8")) as {
    servers: Array<{ name: string; userApiUrl?: string; userSpecUrl?: string; profile?: string }>;
  };
  const expected: Record<string, string> = {
    "tdei-core-dev": "https://portal-api-dev.tdei.us",
    "tdei-core-staging": "https://portal-api-stage.tdei.us",
    "tdei-core-production": "https://portal-api.tdei.us",
  };
  for (const [name, url] of Object.entries(expected)) {
    const entry = file.servers.find((server) => server.name === name);
    assert.equal(entry?.userApiUrl, url, name);
    assert.equal(entry?.userSpecUrl, `${url}/api-docs/swagger.json`, name);
  }
  for (const server of file.servers.filter((s) => s.profile === "workspace")) {
    assert.equal(server.userApiUrl, undefined, `${server.name} must not load the User API`);
  }
});

test("multi-config parses userApiUrl and derives userSpecUrl", () => {
  const [server] = resolveMultiMcp({
    servers: [
      { name: "tdei-core-dev", apiUrl: "https://api-dev.tdei.us", userApiUrl: "https://portal-api-dev.tdei.us/" },
    ],
  });
  assert.equal(server?.userApiUrl, "https://portal-api-dev.tdei.us");
  assert.equal(server?.userSpecUrl, "https://portal-api-dev.tdei.us/api-docs/swagger.json");
  const [plain] = resolveMultiMcp({ servers: [{ name: "tdei-core-dev", apiUrl: "https://api-dev.tdei.us" }] });
  assert.equal(plain?.userApiUrl, undefined);
});

// --- composite client -------------------------------------------------------------------------------

function fakeClient(names: string[], label: string, calls: string[] = []) {
  return {
    listTools: async () => ({
      tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
    }),
    callTool: async (name: string) => {
      calls.push(`${label}:${name}`);
      return { content: [{ type: "text" as const, text: `${label}:${name}` }] };
    },
    close: async () => {
      calls.push(`${label}:close`);
    },
    isConnected: () => true,
    refresh: async () => false,
  };
}

test("the composite client merges both specs, drops name collisions and routes calls to the owning spec", async () => {
  const calls: string[] = [];
  const composite = new CompositeOpenApiClient(
    fakeClient(["listServices", "authenticate"], "core", calls),
    fakeClient(["portal_create_service", "authenticate"], "user", calls),
  );
  const listed = await composite.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["listServices", "authenticate", "portal_create_service"],
  );
  await composite.callTool("portal_create_service", {});
  await composite.callTool("listServices", {});
  await composite.callTool("authenticate", {});
  assert.deepEqual(calls, ["user:portal_create_service", "core:listServices", "core:authenticate"]);
});

test("a User API outage leaves the core tools working", async () => {
  const logs: string[] = [];
  const failing = {
    ...fakeClient([], "user"),
    listTools: async () => Promise.reject(new Error("503 from portal-api")),
  };
  const composite = new CompositeOpenApiClient(fakeClient(["listServices"], "core"), failing, (line) =>
    logs.push(line),
  );
  const listed = await composite.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["listServices"],
  );
  assert.match(logs.join("\n"), /User Management API tools unavailable \(503 from portal-api\)/);
});

test("a call made before tools are listed still reaches the right spec, and close closes both", async () => {
  const calls: string[] = [];
  const composite = new CompositeOpenApiClient(
    fakeClient(["listServices"], "core", calls),
    fakeClient(["portal_list_roles"], "user", calls),
  );
  await composite.callTool("portal_list_roles", {});
  await composite.close();
  assert.deepEqual(calls, ["user:portal_list_roles", "core:close", "user:close"]);
});

const noHeaders = async () => ({});

test("only core servers get the composite client", () => {
  const config = {
    apiUrl: "https://api-dev.tdei.us",
    specUrl: "https://example.org/core.json",
    userApiUrl: "https://portal-api-dev.tdei.us",
    userSpecUrl: "https://portal-api-dev.tdei.us/api-docs/swagger.json",
  };
  assert.ok(
    createOpenApiClient({ config, profile: "core", headersProvider: noHeaders }) instanceof CompositeOpenApiClient,
  );
  assert.ok(
    createOpenApiClient({ config, profile: "workspace", headersProvider: noHeaders }) instanceof OpenApiMcpClient,
  );
  assert.ok(
    createOpenApiClient({
      config: { ...config, userApiUrl: undefined, userSpecUrl: undefined } as never,
      profile: "core",
      headersProvider: noHeaders,
    }) instanceof OpenApiMcpClient,
  );
});

test("the real User API spec compiles into the friendly tool names", async () => {
  const client = new OpenApiMcpClient({
    apiUrl: "https://portal-api-dev.tdei.us",
    loadSpec: async () =>
      JSON.parse(readFileSync(new URL("./fixtures/user-management-spec.json", import.meta.url), "utf8")),
    operationName: userOperationName,
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of Object.values(USER_API_TOOL_NAMES)) assert.ok(names.includes(name), name);
  assert.ok(names.includes("refresh_token"));
});

// --- registrar --------------------------------------------------------------------------------------

function registered(server: McpServer): string[] {
  // oxlint-disable-next-line no-underscore-dangle -- SDK keeps its registry on a private field; no public listing without a transport.
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}
const all = { mode: "all" as const, allow: [], deny: [], allowTags: [], denyTags: [] };
const userNames = [
  "portal_create_service",
  "portal_list_roles",
  "getService",
  "getProjectGroup",
  "searchUsers",
  "createProjectGroup",
  "authenticateWithReferralCode",
  "registerUser",
];
const registrarClient = {
  listTools: async () => ({
    tools: userNames.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
  }),
  callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

test("core registers the exposed User API tools and hides overlaps, admin-only and credential operations", async () => {
  delete process.env.TDEI_EXPOSE_ALL_RAW_TOOLS;
  const server = new McpServer({ name: "t", version: "0" });
  await registerTdeiOpenApiTools(server, registrarClient, all);
  assert.deepEqual(registered(server).sort(), ["portal_create_service", "portal_list_roles"]);
});

test("an allow-list can expose a hidden admin operation but never a credential one", async () => {
  delete process.env.TDEI_EXPOSE_ALL_RAW_TOOLS;
  const server = new McpServer({ name: "t", version: "0" });
  await registerTdeiOpenApiTools(server, registrarClient, {
    mode: "allow",
    allow: ["searchUsers", "registerUser", "portal_list_roles"],
    deny: [],
    allowTags: [],
    denyTags: [],
  });
  assert.deepEqual(registered(server).sort(), ["portal_list_roles", "searchUsers"]);
});

// --- tdei_my_project_group_roles --------------------------------------------------------------------

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(payload: Record<string, unknown>): string {
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function rolesModule(fetchImpl: typeof fetch, userApiUrl: string | null = "https://portal-api-dev.tdei.us") {
  return new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [];
      },
      async listJobs() {
        return [];
      },
    },
    places: { forwardGeocode: async () => [] },
    fetchImpl,
    ...(userApiUrl ? { userApiUrl } : {}),
  });
}

test("my project-group roles uses the token's user id, one call, and parses roles", async () => {
  const urls: string[] = [];
  const headers: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    headers.push(String((init.headers as Record<string, string>).Authorization));
    return new Response(
      JSON.stringify([
        { tdei_project_group_id: "g1", project_group_name: "Demo", roles: ["poc", "member"] },
        { tdei_project_group_id: "g2", project_group_name: "Other", roles: ["member"] },
      ]),
      { status: 200, headers: { "X-Total-Count": "2" } },
    );
  }) as unknown as typeof fetch;
  const token = jwt({ sub: "user-123" });
  const result = await rolesModule(fetchImpl).myProjectGroupRoles({ projectGroupName: "Dem" }, { accessToken: token });
  assert.equal(result.status, "complete");
  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? "", /^https:\/\/portal-api-dev\.tdei\.us\/api\/v1\/project-group-roles\/user-123\?/);
  assert.match(urls[0] ?? "", /searchText=Dem/);
  assert.equal(headers[0], `Bearer ${token}`);
  if (result.status === "complete") {
    assert.deepEqual(result.data.projectGroups?.[0], {
      tdei_project_group_id: "g1",
      project_group_name: "Demo",
      roles: ["poc", "member"],
    });
    assert.equal(result.data.total, undefined);
  }
});

test("my project-group roles reports when the API holds more groups than were returned", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify([{ tdei_project_group_id: "g1", project_group_name: "A", roles: ["member"] }]), {
      status: 200,
      headers: { "X-Total-Count": "120" },
    })) as unknown as typeof fetch;
  const result = await rolesModule(fetchImpl).myProjectGroupRoles({}, { accessToken: jwt({ sub: "u" }) });
  assert.equal(result.status, "complete");
  if (result.status === "complete") {
    assert.equal(result.data.total, 120);
    assert.match(result.data.hint, /Showing 1 of 120/);
  }
});

test("my project-group roles degrades clearly without a configured API, a token or a successful answer", async () => {
  const never = (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
  assert.equal(
    (await rolesModule(never, null).myProjectGroupRoles({}, { accessToken: jwt({ sub: "u" }) })).status,
    "unsupported",
  );
  const unauth = await rolesModule(never).myProjectGroupRoles({}, {});
  assert.equal(unauth.status, "complete");
  if (unauth.status === "complete") assert.equal(unauth.data.authenticated, false);
  const forbidden = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
  const denied = await rolesModule(forbidden).myProjectGroupRoles({}, { accessToken: jwt({ sub: "u" }) });
  assert.equal(denied.status, "unsupported");
  if (denied.status === "unsupported") assert.match(denied.reason, /403/);
});

test("service and member handoffs are API-first with the web UI as the fallback", () => {
  const env = { TDEI_MCP_NAME: "tdei-core-dev" } as NodeJS.ProcessEnv;
  const service = webUiHandoff("create_service", env);
  assert.match(service, /use portal_create_service/);
  assert.match(service, /Only if those tools are not available/);
  assert.match(service, /portal-dev\.tdei\.us/);
  const members = webUiHandoff("manage_project_group_members", env);
  assert.match(members, /use portal_assign_project_group_roles/);
  assert.match(members, /confirmed twice/);
  assert.match(webUiHandoff("register_account", env), /^Web UI only, no MCP operation/);
});
