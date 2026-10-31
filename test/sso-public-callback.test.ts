import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isAuthCallbackPath, publicAuthCallbackUrl, REGISTERED_SSO_REDIRECT_URI } from "../src/sso-public-callback.js";

test("Keycloak redirect is the loopback callback and the gateway receives the relay", () => {
  assert.equal(REGISTERED_SSO_REDIRECT_URI, "http://127.0.0.1:8765/callback");
  assert.equal(publicAuthCallbackUrl("https://tdei-mcp.example/"), "https://tdei-mcp.example/auth/callback");
  assert.equal(publicAuthCallbackUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000/auth/callback");
  assert.equal(isAuthCallbackPath("/auth/callback", "tdei-core-dev"), true);
  assert.equal(isAuthCallbackPath("/tdei-core-dev/auth/callback", "tdei-core-dev"), true);
  assert.equal(isAuthCallbackPath("/other/auth/callback", "tdei-core-dev"), false);
});

test("nginx walks children for the shared /auth/callback", () => {
  const source = readFileSync(new URL("../scripts/generate-nginx-conf.mjs", import.meta.url), "utf8");
  assert.match(source, /upstream tdei_sso_callback/);
  assert.match(source, /location = \/auth\/callback/);
  assert.match(source, /proxy_next_upstream error timeout http_404/);
  assert.match(source, /proxy_pass http:\/\/tdei_sso_callback\/auth\/callback/);
  assert.match(source, /oauth-protected-resource/);
  assert.match(source, /location \^~ \/\$\{s\.slug\}\/oauth\//);
});
