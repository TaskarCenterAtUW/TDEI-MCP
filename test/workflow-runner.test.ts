import { strict as assert } from "node:assert";
import test from "node:test";
import { runWorkflow } from "../src/workflows/runner.js";

const schemas = new Map([["a", { inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }], ["b", { inputSchema: { type: "object", properties: {} } }]] as never);

test("happy chain threads user + step outputs", async () => {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const deps = { async callTool(tool: string, input: Record<string, unknown>) { calls.push({ tool, input }); return tool === "a" ? { id: "d1" } : { ok: true }; }, toolSchemas: schemas };
  const def = { name: "t", steps: [{ id: "s1", tool: "a", ask: ["x"], input: { x: "{{user.x}}" } }, { id: "s2", tool: "b", input: { ref: "{{steps.s1.output.id}}" } }] };
  const result = await runWorkflow(def as never, { x: "hello" }, deps as never);
  assert.deepEqual(calls[0], { tool: "a", input: { x: "hello" } });
  assert.deepEqual(calls[1], { tool: "b", input: { ref: "d1" } });
  assert.equal(result.transcript.length, 2);
});

test("missing ask errors before any call", async () => {
  let called = 0;
  const deps = { async callTool() { called += 1; return {}; }, toolSchemas: schemas };
  const def = { name: "t", steps: [{ id: "s1", tool: "a", ask: ["x"], input: { x: "{{user.x}}" } }] };
  await assert.rejects(() => runWorkflow(def as never, {}, deps as never), /ask.*x/);
  assert.equal(called, 0);
});

test("step-2 failure aborts with transcript preserving step-1", async () => {
  const deps = { async callTool(tool: string) { if (tool === "b") throw new Error("boom"); return { id: "d1" }; }, toolSchemas: schemas };
  const def = { name: "t", steps: [{ id: "s1", tool: "a", ask: [], input: { x: "v" } }, { id: "s2", tool: "b", input: {} }] };
  const error = await runWorkflow(def as never, {}, deps as never).then(() => assert.fail("should throw"), (e) => e);
  assert.match(String(error.message), /s2/);
  assert.match(String(error.message), /boom/);
  const payload = JSON.parse(String(error.message).split("transcript ")[1]);
  assert.equal(payload.failedStepId, "s2");
  assert.equal(payload.stepIndex, 1);
  assert.equal(payload.tool, "b");
  assert.deepEqual(payload.priorOutputs, { s1: { id: "d1" } });
});

test("missing tool schema is an error, not a skipped check", async () => {
  const deps = { async callTool() { return {}; }, toolSchemas: new Map() };
  const def = { name: "t", steps: [{ id: "s1", tool: "zzz", input: {} }] };
  await assert.rejects(() => runWorkflow(def as never, {}, deps as never), /no input schema discovered/);
});

test("multipart operations are rejected before any call", async () => {
  let called = 0;
  const deps = { async callTool() { called += 1; return {}; }, toolSchemas: schemas, multipart: new Set(["a"]) };
  const def = { name: "t", steps: [{ id: "s1", tool: "a", input: { x: "v" } }] };
  await assert.rejects(() => runWorkflow(def as never, {}, deps as never), /multipart/);
  assert.equal(called, 0);
});
