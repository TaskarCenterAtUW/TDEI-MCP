import { strict as assert } from "node:assert";
import test from "node:test";

import { formatError, truncateText, MAX_OUTPUT_BYTES } from "../src/mcp/errors.js";

test("formatError maps SSO-required to coded JSON", () => {
  const result = formatError(new Error("TDEI_SSO_REQUIRED"));
  assert.equal(result.isError, true);
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_SSO_REQUIRED");
  assert.match(body.hint, /tdei_sso_login/);
  assert.equal(body.retryable, false);
});

test("formatError surfaces backend permission on 403", () => {
  const result = formatError({ status: 403, body: { message: "requires project-group admin" } });
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_FORBIDDEN");
  assert.match(body.message, /project-group admin/);
  assert.equal(body.retryable, false);
});

test("formatError maps 5xx to retryable upstream error", () => {
  const result = formatError({ status: 503, body: "unavailable" });
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_UPSTREAM_5XX");
  assert.equal(body.retryable, true);
});

test("truncateText caps at 256KB with flag", () => {
  const big = "x".repeat(MAX_OUTPUT_BYTES + 100);
  const { text, truncated } = truncateText(big);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES + 500);
  assert.match(text, /"truncated":true/);
  const small = truncateText("hello");
  assert.equal(small.truncated, false);
  assert.equal(small.text, "hello");
});

test("tdei-client.ts is gone", async () => {
  const { execSync } = await import("node:child_process");
  // Scoped to src: no production code may reference the deleted dead client.
  const hits = execSync("grep -rn 'tdei-client\\|tdeiRequest\\|TdeiApiError' src --include='*.ts' || true", { encoding: "utf-8" }).trim();
  assert.equal(hits, "");
});
