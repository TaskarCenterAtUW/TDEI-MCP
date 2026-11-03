import { createHash, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  codeChallengeS256,
  dispatchOAuth,
  isAllowedClientRedirect,
  issueOAuthCookie,
  oauthEndpoints,
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

test("authorize returns a Claude Desktop client straight to its own callback", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const clientRedirect = "claude://claude.ai/mcp-auth-callback/sdk";
  const url = new URL(oauthEndpoints("https://gateway.example", "tdei-workspace", "/mcp").authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "tdei-mcp",
    redirect_uri: clientRedirect,
    state: "claude-state",
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: "S256",
    scope: "openid",
    resource: "https://gateway.example/tdei-workspace/mcp",
  }).toString();
  const result = await dispatchOAuth({
    method: "GET",
    url,
    origin: "https://gateway.example",
    slug: "tdei-workspace",
    mcpPath: "/mcp",
    apiUrl: "https://api-stage.tdei.us",
    exchangeCode: async () => {
      throw new Error("must not exchange when a session token is reused");
    },
    refreshToken: async () => {
      throw new Error("must not refresh when a session token is reused");
    },
    getValidSessionTokens: async () => ({ access_token: "seeded", expires_in: 600 }),
  });
  assert.equal(result?.status, 302);
  const location = new URL(result?.headers.Location ?? "");
  assert.equal(location.protocol, "claude:");
  assert.equal(location.hostname, "claude.ai");
  assert.equal(location.pathname, "/mcp-auth-callback/sdk");
  assert.equal(location.searchParams.get("state"), "claude-state");
  assert.equal(openAuthorizationCode(location.searchParams.get("code") ?? "", verifier).access_token, "seeded");
});

test("authorize rejects a Claude look-alike callback", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(oauthEndpoints("https://gateway.example", "tdei-workspace", "/mcp").authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "tdei-mcp",
    redirect_uri: "claude://evil.example/mcp-auth-callback/sdk",
    state: "s",
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: "S256",
  }).toString();
  const result = await dispatchOAuth({
    method: "GET",
    url,
    origin: "https://gateway.example",
    slug: "tdei-workspace",
    mcpPath: "/mcp",
    apiUrl: "https://api-stage.tdei.us",
    exchangeCode: async () => {
      throw new Error("must not exchange");
    },
    refreshToken: async () => {
      throw new Error("must not refresh");
    },
  });
  assert.equal(result?.status, 400);
  assert.match(result?.body ?? "", /must be a localhost, Cursor, VS Code, or Claude callback/);
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

test("Claude and other native MCP client callbacks are accepted, look-alikes are not", () => {
  // Claude Desktop sends this exact shape after its own connector flow.
  assert.equal(isAllowedClientRedirect("claude://claude.ai/mcp-auth-callback/sdk"), true);
  assert.equal(isAllowedClientRedirect("claude://claude.ai/mcp-auth-callback/claude-code"), true);
  assert.equal(isAllowedClientRedirect("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isAllowedClientRedirect("cursor://anysphere.cursor-mcp/oauth/callback"), true);
  assert.equal(isAllowedClientRedirect("vscode://anthropic.claude-code/callback"), true);

  // Wrong host, wrong path, or a look-alike domain must stay rejected.
  assert.equal(isAllowedClientRedirect("claude://evil.example/mcp-auth-callback/sdk"), false);
  assert.equal(isAllowedClientRedirect("claude://claude.ai:pass@evil.example/cb"), false);
  assert.equal(isAllowedClientRedirect("claude://claude.ai/other/sdk"), false);
  assert.equal(isAllowedClientRedirect("https://claude.ai.evil.example/api/mcp/auth_callback"), false);
  assert.equal(isAllowedClientRedirect("https://claude.ai/other"), false);
  assert.equal(isAllowedClientRedirect("https://claude.com/api/mcp/auth_callback"), false);
});
