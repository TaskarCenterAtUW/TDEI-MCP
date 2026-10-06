import { strict as assert } from "node:assert";
import test from "node:test";

import { decodeAwsRecords } from "../src/adapters/aws-result-decoder.js";

const group = { tdei_project_group_id: "group-1", name: "AA Viewer Internal" };

test("AWS decoder reads a top-level project group array", () => {
  assert.deepEqual(decodeAwsRecords([group]), [group]);
});

test("AWS decoder reads project_groups wrapped in MCP text content", () => {
  assert.deepEqual(decodeAwsRecords({
    content: [{
      type: "text",
      text: JSON.stringify({ project_groups: [group] }),
    }],
  }), [group]);
});

test("AWS decoder reads projectGroups wrapped in MCP text content", () => {
  assert.deepEqual(decodeAwsRecords({
    content: [{
      type: "text",
      text: JSON.stringify({ projectGroups: [group] }),
    }],
  }), [group]);
});

test("AWS decoder reads structuredContent when text content is absent", () => {
  assert.deepEqual(decodeAwsRecords({
    content: [{ type: "image", data: "not-json" }],
    structuredContent: { project_groups: [group] },
  }), [group]);
});

test("AWS decoder surfaces plain-text upstream errors", () => {
  assert.throws(
    () => decodeAwsRecords({
      content: [{ type: "text", text: "tdei_project_group_id is required for non-admin user" }],
    }),
    /tdei_project_group_id is required/,
  );
});

test("AWS decoder reads versions envelopes from live API shapes", () => {
  assert.deepEqual(decodeAwsRecords({
    content: [{
      type: "text",
      text: JSON.stringify({ versions: [{ version: "0.3" }] }),
    }],
  }), [{ version: "0.3" }]);
});

test("AWS decoder prefers non-empty project_groups over empty data", () => {
  assert.deepEqual(decodeAwsRecords({
    content: [{
      type: "text",
      text: JSON.stringify({ data: [], project_groups: [group] }),
    }],
  }), [group]);
});

test("AWS decoder parses double-encoded MCP text JSON", () => {
  assert.deepEqual(decodeAwsRecords({
    content: [{
      type: "text",
      text: JSON.stringify(JSON.stringify([group])),
    }],
  }), [group]);
});
