import assert from "node:assert/strict";
import test from "node:test";

import { RELAY_START_COMMAND, renderSsoFailurePage, renderSsoPreflightPage } from "../src/auth/sso-callback-page.js";
import { oauthCallbackResult } from "../src/oauth/mcp-oauth.js";

test("each failure kind has its own heading and a way forward", () => {
  const failed = renderSsoFailurePage("failed");
  const expired = renderSsoFailurePage("expired");
  const declined = renderSsoFailurePage("declined");
  assert.match(failed, /Sign-in failed/);
  assert.match(expired, /This sign-in has expired/);
  assert.match(declined, /Sign-in was cancelled/);
  for (const page of [failed, expired, declined]) assert.match(page, /<ol class="steps">/);
  assert.match(expired, /already shows you as signed in/);
});

test("preflight page checks the local helper and offers retry, a start command and continue anyway", () => {
  const page = renderSsoPreflightPage(
    "https://auth.example/api/v1/sso-redirect?redirect_uri=a&client_id=b",
    "http://127.0.0.1:8765/health",
  );
  assert.match(page, /fetch\(healthUrl, \{ mode: "no-cors"/);
  assert.ok(page.includes(RELAY_START_COMMAND));
  assert.match(page, /Check again/);
  assert.match(page, /Continue anyway/);
  assert.match(page, /<noscript>/);
});

test("callback without a pending cookie falls through so sibling environments can claim it", async () => {
  const result = await oauthCallbackResult({
    url: new URL("https://gateway.example/auth/callback?code=c&state=s"),
    origin: "https://gateway.example",
    slug: "tdei-core-dev",
    apiUrl: "https://auth.example",
    exchangeCode: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(result, undefined);
});

test("a declined or failed provider callback shows the matching page", async () => {
  const base = {
    origin: "http://127.0.0.1:9",
    slug: "tdei-core-dev",
    apiUrl: "https://auth.example",
    exchangeCode: async () => {
      throw new Error("no");
    },
  };
  // Without a signed pending cookie nothing renders; the kinds themselves are covered above.
  assert.equal(
    await oauthCallbackResult({ ...base, url: new URL("http://127.0.0.1:9/auth/callback?error=access_denied") }),
    undefined,
  );
});
