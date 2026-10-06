import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeAwsJson, normalizeAwsToolResult } from "../src/adapters/aws-result-decoder.js";
import { parseTdeiGetResponse } from "../src/adapters/tdei-get-response.js";

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/live-api-shapes.json"), "utf8"),
) as Record<string, unknown>;

test("array GET responses keep API rows and field names", () => {
  for (const key of [
    "listProjectGroups",
    "listServices",
    "listDatasetFiles",
    "oswDatasetViewerFeedbacks",
    "listJobs",
  ]) {
    const parsed = parseTdeiGetResponse(fixtures[key]);
    assert.equal(parsed.kind, "records", key);
    assert.deepEqual(parsed.body, fixtures[key], key);
    if (key === "listJobs") {
      assert.equal(parsed.records.length, 0, key);
      continue;
    }
    assert.ok(parsed.records.length > 0, key);
    // Rows are verbatim API objects (not remapped).
    assert.deepEqual(parsed.records[0], (fixtures[key] as unknown[])[0], key);
  }
});

test("versions GET envelopes preserve body and expose version rows", () => {
  for (const key of [
    "listOswVersions",
    "listApiVersions",
    "listGtfsFlexVersions",
    "listGtfsPathwaysVersions",
  ]) {
    const body = fixtures[key] as { versions: Array<{ version: string }> };
    const parsed = parseTdeiGetResponse(body);
    assert.equal(parsed.kind, "records", key);
    assert.equal(parsed.envelopeKey, "versions", key);
    assert.deepEqual(parsed.body, body, key);
    assert.equal(parsed.records[0]?.version, body.versions[0]?.version, key);
  }
});

test("object GET responses are not collapsed to empty lists", () => {
  for (const key of ["systemCapabilities", "oswDatasetViewerFeedbacksMetadata", "systemMetrics", "dataMetrics"]) {
    if (!(key in fixtures)) continue;
    const parsed = parseTdeiGetResponse(fixtures[key]);
    assert.equal(parsed.kind, "object", key);
    assert.deepEqual(parsed.body, fixtures[key], key);
    assert.deepEqual(parsed.records, [], key);
  }
});

test("service-metrics object keeps services array extractable and full body intact", () => {
  const parsed = parseTdeiGetResponse(fixtures.serviceMetrics);
  assert.equal(parsed.kind, "records");
  assert.equal(parsed.envelopeKey, "services");
  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.body, fixtures.serviceMetrics);
});

test("MCP text wrapping round-trips each GET shape via decodeAwsJson", () => {
  for (const [key, body] of Object.entries(fixtures)) {
    const decoded = decodeAwsJson({
      content: [{ type: "text", text: JSON.stringify(body) }],
    });
    const direct = parseTdeiGetResponse(body);
    assert.equal(decoded.kind, direct.kind, key);
    assert.deepEqual(decoded.body, direct.body, key);
    assert.deepEqual(decoded.records, direct.records, key);
  }
});

test("normalizeAwsToolResult keeps object GET JSON valid for LLMs", () => {
  const normalized = normalizeAwsToolResult({
    content: [{
      type: "text",
      text: "```json\n" + JSON.stringify(fixtures.systemCapabilities) + "\n```",
    }],
  }) as { content: Array<{ text: string }> };
  assert.deepEqual(JSON.parse(normalized.content[0]!.text), fixtures.systemCapabilities);
});

test("normalizeAwsToolResult keeps list GET arrays valid for LLMs", () => {
  const normalized = normalizeAwsToolResult({
    content: [{
      type: "text",
      text: JSON.stringify(JSON.stringify(fixtures.listProjectGroups)),
    }],
  }) as { content: Array<{ text: string }> };
  assert.deepEqual(JSON.parse(normalized.content[0]!.text), fixtures.listProjectGroups);
});
