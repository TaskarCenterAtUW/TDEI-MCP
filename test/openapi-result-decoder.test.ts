import { strict as assert } from "node:assert";
import test from "node:test";

import { decodeOpenApiRecords } from "../src/adapters/openapi-result-decoder.js";

const group = { tdei_project_group_id: "group-1", name: "AA Viewer Internal" };

test("OpenAPI decoder reads a top-level project group array", () => {
  assert.deepEqual(decodeOpenApiRecords([group]), [group]);
});

test("OpenAPI decoder reads project_groups wrapped in MCP text content", () => {
  assert.deepEqual(
    decodeOpenApiRecords({
      content: [
        {
          type: "text",
          text: JSON.stringify({ project_groups: [group] }),
        },
      ],
    }),
    [group],
  );
});

test("OpenAPI decoder reads projectGroups wrapped in MCP text content", () => {
  assert.deepEqual(
    decodeOpenApiRecords({
      content: [
        {
          type: "text",
          text: JSON.stringify({ projectGroups: [group] }),
        },
      ],
    }),
    [group],
  );
});

test("OpenAPI decoder reads structuredContent when text content is absent", () => {
  assert.deepEqual(
    decodeOpenApiRecords({
      content: [{ type: "image", data: "not-json" }],
      structuredContent: { project_groups: [group] },
    }),
    [group],
  );
});

test("OpenAPI decoder surfaces plain-text upstream errors", () => {
  assert.throws(
    () =>
      decodeOpenApiRecords({
        content: [{ type: "text", text: "tdei_project_group_id is required for non-admin user" }],
      }),
    /tdei_project_group_id is required/,
  );
});

test("OpenAPI decoder reads versions envelopes from live API shapes", () => {
  assert.deepEqual(
    decodeOpenApiRecords({
      content: [
        {
          type: "text",
          text: JSON.stringify({ versions: [{ version: "0.3" }] }),
        },
      ],
    }),
    [{ version: "0.3" }],
  );
});

test("OpenAPI decoder prefers non-empty project_groups over empty data", () => {
  assert.deepEqual(
    decodeOpenApiRecords({
      content: [
        {
          type: "text",
          text: JSON.stringify({ data: [], project_groups: [group] }),
        },
      ],
    }),
    [group],
  );
});

test("OpenAPI decoder parses double-encoded MCP text JSON", () => {
  assert.deepEqual(
    decodeOpenApiRecords({
      content: [
        {
          type: "text",
          text: JSON.stringify(JSON.stringify([group])),
        },
      ],
    }),
    [group],
  );
});
