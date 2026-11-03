import { createHash, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Isolate the file-backed session from any real ~/.tdei-mcp login.
// sessionsDir() reads this lazily, so setting it here covers all imports.
process.env.TDEI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tdei-shared-sessions-"));

import { AuthManager, injectAccessToken } from "../src/auth/auth-manager.js";
import {
  clearSharedSession,
  expiresAtForTokens,
  loadSharedSession,
  saveSharedSession,
} from "../src/auth/shared-session.js";
import type { TokenResponse } from "../src/auth/types.js";
import { getConfig } from "../src/config.js";
import {
  dispatchOAuth,
  oauthEndpoints,
  openAuthorizationCode,
  type OAuthDispatchInput,
} from "../src/oauth/mcp-oauth.js";
import { serveTestHttp } from "./helpers/test-http-server.js";

const TEST_API_URL = "https://api-test.tdei.example";
const seededTokens: TokenResponse = {
  access_token: "shared-access-token",
  refresh_token: "shared-refresh-token",
  expires_in: 3600,
};

function seedShared(apiUrl: string = TEST_API_URL): void {
  saveSharedSession(apiUrl, seededTokens, Date.now() + 3600 * 1000);
}

test("shared session file round-trips tokens", () => {
  clearSharedSession(TEST_API_URL);
  seedShared();
  const loaded = loadSharedSession(TEST_API_URL);
  assert.equal(loaded?.access_token, "shared-access-token");
  assert.equal(loaded?.refresh_token, "shared-refresh-token");
  clearSharedSession(TEST_API_URL);
  assert.equal(loadSharedSession(TEST_API_URL), undefined);
});

test("expired shared session loads as undefined and is cleaned up", () => {
  saveSharedSession(TEST_API_URL, seededTokens, Date.now() - 1000);
  assert.equal(loadSharedSession(TEST_API_URL), undefined);
  assert.equal(loadSharedSession(TEST_API_URL), undefined);
});

test("expiresAtForTokens prefers expires_in, then JWT exp, then fallback", () => {
  const now = Date.now();
  assert.equal(expiresAtForTokens({ access_token: "x", expires_in: 100 }, now), now + 100_000);

  const exp = Math.floor(now / 1000) + 500;
  const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  assert.equal(expiresAtForTokens({ access_token: jwt }, now), exp * 1000);

  const fallback = expiresAtForTokens({ access_token: "opaque" }, now);
  assert.ok(fallback > now + 20 * 60 * 1000);
});

function mockProbe(status: number) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/project-groups")) {
      return new Response(status === 200 ? "{}" : "unauthorized", { status });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("restoreSharedSession adopts a valid shared login without a browser roundtrip", async () => {
  const apiUrl = getConfig().authApiUrl;
  clearSharedSession(apiUrl);
  saveSharedSession(apiUrl, seededTokens, Date.now() + 3600 * 1000);
  const restore = mockProbe(200);
  try {
    const auth = new AuthManager();
    assert.equal(auth.getStatus().authenticated, false);
    assert.equal(await auth.restoreSharedSession(), true);
    assert.equal(auth.getStatus().authenticated, true);
    assert.equal(await auth.getAccessToken(), "shared-access-token");
  } finally {
    restore();
    clearSharedSession(apiUrl);
  }
});

test("restoreSharedSession rejects an invalid shared login and clears it", async () => {
  const apiUrl = getConfig().authApiUrl;
  clearSharedSession(apiUrl);
  saveSharedSession(apiUrl, seededTokens, Date.now() + 3600 * 1000);
  const restore = mockProbe(401);
  try {
    const auth = new AuthManager();
    assert.equal(await auth.restoreSharedSession(), false);
    assert.equal(auth.getStatus().authenticated, false);
    assert.equal(loadSharedSession(apiUrl), undefined);
  } finally {
    restore();
    clearSharedSession(apiUrl);
  }
});

test("restoreSharedSession short-circuits when already authenticated", async () => {
  const auth = injectAccessToken("in-memory-token", 3600);
  const restore = mockProbe(401);
  try {
    // Must not touch the network: the in-memory login is already usable.
    assert.equal(await auth.restoreSharedSession(), true);
  } finally {
    restore();
  }
});

function authorizeInput({ verifier, ...rest }: Partial<OAuthDispatchInput> & { verifier: string }): {
  input: OAuthDispatchInput;
  clientRedirect: string;
  verifier: string;
} {
  const endpoints = oauthEndpoints("https://gateway.example", "tdei-core-dev", "/mcp");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const clientRedirect = "http://127.0.0.1:9/callback";
  const url = new URL(endpoints.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "tdei-mcp",
    redirect_uri: clientRedirect,
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return {
    input: {
      method: "GET",
      url,
      origin: "https://gateway.example",
      slug: "tdei-core-dev",
      mcpPath: "/mcp",
      apiUrl: TEST_API_URL,
      exchangeCode: async () => {
        throw new Error("must not exchange in the shortcut path");
      },
      refreshToken: async () => {
        throw new Error("must not refresh in the shortcut path");
      },
      ...rest,
    },
    clientRedirect,
    verifier,
  };
}

test("authorize seals a PKCE code for valid session tokens instead of SSO redirect", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const { input, clientRedirect } = authorizeInput({
    verifier,
    getValidSessionTokens: async () => ({ ...seededTokens }),
  });
  const result = await dispatchOAuth(input);
  assert.equal(result?.status, 302);
  const location = new URL(result?.headers.Location ?? "");
  assert.equal(location.origin + location.pathname, clientRedirect);
  assert.equal(location.searchParams.get("state"), "client-state");
  const opened = openAuthorizationCode(location.searchParams.get("code") ?? "", verifier);
  assert.equal(opened.access_token, "shared-access-token");
  assert.equal(result?.headers["Set-Cookie"], undefined);
});

test("authorize falls back to the SSO redirect when no session tokens validate", async () => {
  for (const hook of [undefined, async () => undefined]) {
    const verifier = randomBytes(32).toString("base64url");
    const { input } = authorizeInput({
      verifier,
      ...(hook ? { getValidSessionTokens: hook } : {}),
    });
    const result = await dispatchOAuth(input);
    assert.equal(result?.status, 302);
    assert.match(result?.headers.Location ?? "", /api\/v1\/sso-redirect/);
    assert.match(result?.headers["Set-Cookie"] ?? "", /^tdei_oauth=/);
  }
});

test("gateway authorize falls back to SSO when no shared login exists", async () => {
  const apiUrl = getConfig().authApiUrl;
  clearSharedSession(apiUrl);
  const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await fetch(
      `${handle.url}/tdei-core-dev/oauth/authorize?response_type=code&client_id=tdei-mcp&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/callback")}&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    assert.equal(authorize.status, 302);
    assert.match(authorize.headers.get("location") ?? "", /api\/v1\/sso-redirect/);
  } finally {
    await handle.close();
    clearSharedSession(apiUrl);
  }
});

test("gateway authorize reuses a sibling shared login end to end", async () => {
  const apiUrl = getConfig().authApiUrl;
  clearSharedSession(apiUrl);
  saveSharedSession(apiUrl, seededTokens, Date.now() + 3600 * 1000);
  const restore = mockProbe(200);
  try {
    // Fresh gateway with a signed-out sessionAuth, like a second mcps.json entry.
    const handle = await serveTestHttp({ gatewaySlug: "tdei-core-dev" });
    try {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const clientRedirect = "http://127.0.0.1:9/callback";
      const authorize = await fetch(
        `${handle.url}/tdei-core-dev/oauth/authorize?response_type=code&client_id=tdei-mcp&redirect_uri=${encodeURIComponent(clientRedirect)}&state=sibling-state&code_challenge=${challenge}&code_challenge_method=S256`,
        { redirect: "manual" },
      );
      assert.equal(authorize.status, 302);
      const back = new URL(authorize.headers.get("location") ?? "");
      assert.equal(back.origin + back.pathname, clientRedirect);
      assert.equal(back.searchParams.get("state"), "sibling-state");

      const tokenRes = await fetch(`${handle.url}/tdei-core-dev/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: back.searchParams.get("code") ?? "",
          code_verifier: verifier,
          redirect_uri: clientRedirect,
          client_id: "tdei-mcp",
        }),
      });
      assert.equal(tokenRes.status, 200);
      const token = (await tokenRes.json()) as { access_token: string };
      assert.equal(token.access_token, "shared-access-token");
    } finally {
      await handle.close();
    }
  } finally {
    restore();
    clearSharedSession(apiUrl);
  }
});
