import { strict as assert } from "node:assert";
import test from "node:test";
import { validateWorkflow } from "../src/workflows/validate.js";

const toolSchemas = new Map<string, unknown>([["listA", {}], ["getB", {}], ["denied", {}], ["upload", {}]]);
const deps = { toolSchemas, denied: new Set(["denied"]), multipart: new Set(["upload"]), configPath: "/c/tdei.config.json" };
const wf = (steps: unknown[]) => ({ name: "w", steps }) as never;

test("valid workflow passes", () => {
  validateWorkflow(wf([
    { id: "s1", tool: "listA", ask: ["x"], input: { x: "{{user.x}}" } },
    { id: "s2", tool: "getB", input: { id: "{{steps.s1.output.id}}" } },
  ]), deps);
});

test("rejects unknown, denied, multipart and auth tools with JSON paths", () => {
  const run = (tool: string) => () => validateWorkflow(wf([{ id: "s1", tool, input: {} }]), deps);
  assert.throws(run("nope"), /workflows\.w\.steps\.s1\.tool "nope" is not present/);
  assert.throws(run("denied"), /not present: disabled by endpoints config/);
  assert.throws(run("upload"), /multipart/);
  assert.throws(run("authenticate"), /connector-managed/);
});

test("rejects forward refs and undeclared user refs at config time", () => {
  assert.throws(() => validateWorkflow(wf([{ id: "s1", tool: "listA", input: { a: "{{steps.s2.output.id}}" } }, { id: "s2", tool: "getB", input: {} }]), deps), /forward step ref|unknown/);
  assert.throws(() => validateWorkflow(wf([{ id: "s1", tool: "listA", input: { a: "{{user.missing}}" } }]), deps), /not declared in any step's "ask"/);
});

test("reports every problem in one error", () => {
  assert.throws(() => validateWorkflow(wf([{ id: "s1", tool: "nope", input: {} }, { id: "s2", tool: "denied", input: {} }]), deps), (e: Error) => /nope/.test(e.message) && /denied/.test(e.message));
});
