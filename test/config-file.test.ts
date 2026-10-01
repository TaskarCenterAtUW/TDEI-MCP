import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { isToolAllowed, loadConfigFile } from "../src/config-file.js";
import { registerWorkflows } from "../src/workflows/register.js";

function load(obj: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "tdei-cfg-"));
  const path = join(dir, "tdei.config.json");
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj));
  const orig = console.error; console.error = () => {};
  try { return loadConfigFile(path); } finally { console.error = orig; }
}
const step = (id: string) => ({ id, tool: "listA", input: {} });

test("allow+deny both set -> allow-all fallback with warning naming file", () => {
  const cfg = load({ endpoints: { mode: "allow", allow: ["a"], deny: ["b"] } });
  assert.equal(cfg.filter.mode, "all");
  assert.match(cfg.warnings[0] ?? "", /mutually exclusive/);
  assert.match(cfg.warnings[0] ?? "", /tdei\.config\.json/);
});

test("duplicate workflow names and step ids are schema issues with JSON paths", () => {
  const dupName = load({ workflows: [{ name: "w", steps: [step("s")] }, { name: "w", steps: [step("s")] }] });
  assert.match(dupName.warnings[0] ?? "", /workflows\.1\.name: duplicate workflow name "w"/);
  const dupStep = load({ workflows: [{ name: "w", steps: [step("s"), step("s")] }] });
  assert.match(dupStep.warnings[0] ?? "", /workflows\.0\.steps\.1\.id: duplicate step id "s"/);
});

test("built-ins and connector auth tools are immune from filtering", () => {
  const deny = { mode: "deny" as const, allow: [], deny: ["tdei_sso_login", "authenticate"] };
  const allow = { mode: "allow" as const, allow: ["x"], deny: [] };
  for (const f of [deny, allow]) {
    assert.ok(isToolAllowed("tdei_sso_login", f));
    assert.ok(isToolAllowed("authenticate", f));
  }
});

test("re-registering an identical workflow is a no-op; a changed or conflicting one throws", () => {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  const deps = { callTool: async () => ({}), toolSchemas: new Map([["listA", { inputSchema: {} }]]), denied: new Set<string>(), configPath: "/c.json" };
  const def = { name: "w", steps: [step("s1")] };
  assert.equal(registerWorkflows(server, [def], deps).registered.length, 1);
  assert.equal(registerWorkflows(server, [def], deps).registered.length, 0);
  assert.throws(() => registerWorkflows(server, [{ ...def, description: "changed" }], deps), /duplicate workflow.*restart/);
});
