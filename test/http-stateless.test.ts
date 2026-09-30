import { strict as assert } from "node:assert";
import test from "node:test";

import { validateSsoCallbackUrl } from "../src/config.js";

test("callback validator rejects https in stdio mode", () => {
  assert.throws(
    () => validateSsoCallbackUrl("https://mcp.example.com/callback", "stdio"),
    /127\.0\.0\.1/,
  );
});

test("callback validator accepts https in http mode", () => {
  assert.equal(
    validateSsoCallbackUrl("https://mcp.example.com/callback", "http"),
    "https://mcp.example.com/callback",
  );
});

test("callback validator accepts loopback in http mode for local dev", () => {
  assert.equal(
    validateSsoCallbackUrl("http://127.0.0.1:3000/callback", "http"),
    "http://127.0.0.1:3000/callback",
  );
});

test("callback validator rejects plain http hostnames in http mode", () => {
  assert.throws(
    () => validateSsoCallbackUrl("http://mcp.example.com/callback", "http"),
    /https/,
  );
});

import { AuthManager, authManager, injectAccessToken } from "../src/auth/auth-manager.js";

test("injectAccessToken does not touch the singleton", () => {
  assert.equal(authManager.getStatus().authenticated, false);
  const ephemeral = injectAccessToken("ephemeral-token", 3600);
  assert.ok(ephemeral instanceof AuthManager);
  assert.notEqual(ephemeral, authManager);
  assert.equal(ephemeral.getStatus().authenticated, true);
  assert.equal(authManager.getStatus().authenticated, false);
});

test("validateToken rejects expired bearer without refresh attempt", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const expired = injectAccessToken("expired-token", 0);
    await assert.rejects(() => expired.validateToken(), /TDEI_TOKEN_EXPIRED/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateToken rejects invalid bearer on probe 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    const bad = injectAccessToken("bad-token", 3600);
    await assert.rejects(() => bad.validateToken(), /TDEI_TOKEN_INVALID/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateToken accepts good bearer on probe success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    const good = injectAccessToken("good-token", 3600);
    await good.validateToken();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
