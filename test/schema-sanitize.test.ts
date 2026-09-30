import { strict as assert } from "node:assert";
import test from "node:test";
import { fromJsonSchema } from "@modelcontextprotocol/server";

import { sanitizeJsonSchema } from "../src/aws/register-aws-tools.js";

test("draft-04 boolean exclusiveMinimum rewrites to numeric and converts", () => {
  // Exact shape from live tdei-api-gateway.json (proximity field)
  const schema = { type: "object", properties: { proximity: { type: "number", minimum: 0, exclusiveMinimum: true } } };
  const cleaned = sanitizeJsonSchema(structuredClone(schema)) as Record<string, unknown>;
  assert.deepEqual(
    (cleaned.properties as Record<string, unknown>).proximity,
    { type: "number", minimum: 0, exclusiveMinimum: 0 },
  );
  fromJsonSchema(cleaned);
});

test("boolean exclusive bound without minimum/maximum is dropped", () => {
  const cleaned = sanitizeJsonSchema({ type: "number", exclusiveMaximum: true }) as Record<string, unknown>;
  assert.ok(!("exclusiveMaximum" in cleaned));
  fromJsonSchema(cleaned);
});
