import { strict as assert } from "node:assert";
import test from "node:test";

import { parseTdeiJson, tryParseTdeiJson } from "../src/adapters/parse-tdei-json.js";
import { recordsFrom } from "../src/adapters/tdei-records.js";
import { decodeAwsRecords } from "../src/adapters/aws-result-decoder.js";

const group = {
  tdei_project_group_id: "1ec1c79b-6b7a-4011-936b-c75dbbd903e3",
  project_group_name: "AA Viewer Internal",
};

test("parseTdeiJson strips BOM and markdown fences", () => {
  assert.deepEqual(parseTdeiJson(`\uFEFF${JSON.stringify([group])}`), [group]);
  assert.deepEqual(
    parseTdeiJson("```json\n" + JSON.stringify({ project_groups: [group] }) + "\n```"),
    { project_groups: [group] },
  );
});

test("parseTdeiJson unwraps double-encoded JSON strings", () => {
  assert.deepEqual(parseTdeiJson(JSON.stringify(JSON.stringify([group]))), [group]);
});

test("parseTdeiJson extracts embedded JSON from noisy text", () => {
  assert.deepEqual(
    parseTdeiJson(`Here is the payload:\n${JSON.stringify([group])}\n`),
    [group],
  );
});

test("recordsFrom prefers a non-empty envelope when another key is an empty array", () => {
  assert.deepEqual(
    recordsFrom({ data: [], project_groups: [group] }),
    [group],
  );
});

test("recordsFrom parses JSON text payloads", () => {
  assert.deepEqual(recordsFrom(JSON.stringify([group])), [group]);
});

test("recordsFrom uses a sole unknown array property as records", () => {
  assert.deepEqual(
    recordsFrom({ projectGroupList: [group] }),
    [group],
  );
});

test("decodeAwsRecords handles fenced MCP text and multiple content blocks", () => {
  assert.deepEqual(
    decodeAwsRecords({
      content: [
        { type: "text", text: "note: ignoring preface" },
        {
          type: "text",
          text: "```json\n" + JSON.stringify([group]) + "\n```",
        },
      ],
    }),
    [group],
  );
});

test("tryParseTdeiJson leaves plain errors as strings", () => {
  assert.equal(
    tryParseTdeiJson("tdei_project_group_id is required for non-admin user"),
    "tdei_project_group_id is required for non-admin user",
  );
});
