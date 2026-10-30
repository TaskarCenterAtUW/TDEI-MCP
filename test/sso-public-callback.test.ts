import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isAuthCallbackPath, publicAuthCallbackUrl } from "../src/sso-public-callback.js";

test("public callback URL is per gateway slug", () => {
  assert.equal(
    publicAuthCallbackUrl("https://tdei-mcp.example/", "tdei-core-dev"),
    "https://tdei-mcp.example/tdei-core-dev/auth/callback",
  );
  assert.equal(
    publicAuthCallbackUrl("http://127.0.0.1:3000", undefined),
    "http://127.0.0.1:3000/auth/callback",
  );
  assert.equal(isAuthCallbackPath("/tdei-core-dev/auth/callback", "tdei-core-dev"), true);
  assert.equal(isAuthCallbackPath("/auth/callback", "tdei-core-dev"), true);
  assert.equal(isAuthCallbackPath("/other/auth/callback", "tdei-core-dev"), false);
  assert.throws(() => publicAuthCallbackUrl("https://tdei-mcp.example", "../etc"), /invalid/);
});

test("nginx proxies each slug callback onto the child /auth/callback", () => {
  const source = readFileSync(new URL("../scripts/generate-nginx-conf.mjs", import.meta.url), "utf8");
  assert.match(source, /location = \/\$\{s\.slug\}\/auth\/callback/);
  assert.match(source, /proxy_pass http:\/\/\$\{target\}\/auth\/callback/);
});
