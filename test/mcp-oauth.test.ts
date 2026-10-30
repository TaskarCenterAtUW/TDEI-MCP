import { createHash, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  codeChallengeS256,
  isAllowedClientRedirect,
  issueOAuthCookie,
  openAuthorizationCode,
  readOAuthCookie,
  sealAuthorizationCode,
} from "../src/oauth/mcp-oauth.js";

test("authorization codes open only with the PKCE verifier", () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = codeChallengeS256(verifier);
  const code = sealAuthorizationCode(
    { access_token: "access", refresh_token: "refresh", expires_in: 1800 },
    "http://127.0.0.1:9/callback",
    challenge,
  );
  const opened = openAuthorizationCode(code, verifier);
  assert.equal(opened.access_token, "access");
  assert.equal(opened.refresh_token, "refresh");
  assert.throws(() => openAuthorizationCode(code, "wrong-verifier"), /invalid_grant/);
});

test("oauth cookie is bound to the gateway slug", () => {
  const pending = {
    slug: "tdei-core-dev",
    redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback",
    state: "state-1",
    codeChallenge: createHash("sha256").update("verifier").digest("base64url"),
    exp: Date.now() + 60_000,
  };
  const header = issueOAuthCookie(pending, "https://api-dev.tdei.us", true);
  const pair = header.split(";")[0] ?? "";
  assert.equal(readOAuthCookie(pair, "https://api-dev.tdei.us", "tdei-core-dev")?.state, "state-1");
  assert.equal(readOAuthCookie(pair, "https://api-dev.tdei.us", "tdei-core-staging"), undefined);
  assert.equal(isAllowedClientRedirect("https://evil.example/callback"), false);
  assert.equal(isAllowedClientRedirect("http://127.0.0.1:8787/callback"), true);
});
