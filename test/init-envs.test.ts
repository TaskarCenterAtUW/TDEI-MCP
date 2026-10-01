import { strict as assert } from "node:assert";
import test from "node:test";
import { assertCallbackUrl, buildCallbackUrl, resolveApiUrl } from "../src/init/envs.js";
import { checkPreflight } from "../src/init/preflight.js";

test("resolveApiUrl maps env names, requires explicit choice, normalizes pasted URLs", () => {
  assert.equal(resolveApiUrl({ env: "stage" }), "https://api-stage.tdei.us");
  assert.equal(resolveApiUrl({ env: "prod" }), "https://api.tdei.us");
  assert.equal(resolveApiUrl({ url: "https://example.com/api/" }), "https://example.com");
  assert.equal(resolveApiUrl({ url: "https://api.tdei.us/api/v1/authenticate" }), "https://api.tdei.us");
  assert.throws(() => resolveApiUrl({}), /no environment given/);
  assert.throws(() => resolveApiUrl({ env: "prod", url: "https://x" }), /mutually exclusive/);
  assert.throws(() => resolveApiUrl({ env: "qa" }), /unknown environment "qa"/);
  assert.throws(() => resolveApiUrl({ env: "dev" }), /unknown environment "dev"/);
  assert.throws(() => resolveApiUrl({ url: "http://insecure" }), /TDEI_API_URL must use HTTPS/);
});

test("callback validation mirrors src/config.ts", () => {
  assert.equal(buildCallbackUrl(8765), "http://127.0.0.1:8765/callback");
  assert.equal(assertCallbackUrl("http://127.0.0.1:9999/callback"), "http://127.0.0.1:9999/callback");
  assert.throws(() => assertCallbackUrl("http://localhost:8765/callback"), /TDEI_SSO_CALLBACK_URL must use http:\/\/127\.0\.0\.1:<port>\/callback/);
});

test("checkPreflight passes on good versions, guides on missing uvx", async () => {
  const ok = await checkPreflight(async (cmd) => ({ stdout: cmd === "node" ? "v22.5.0\n" : "uvx 0.7.0\n" }));
  assert.equal(ok.nodeVersion, "v22.5.0");
  await assert.rejects(
    checkPreflight(async (cmd) => { if (cmd === "uvx") throw new Error("not found"); return { stdout: "v22.5.0\n" }; }),
    /https:\/\/docs\.astral\.sh\/uv\//,
  );
  await assert.rejects(
    checkPreflight(async () => ({ stdout: "v20.1.0\n" })),
    /requires Node\.js >=22/,
  );
});
