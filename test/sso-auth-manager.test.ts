import { strict as assert } from "node:assert";
import test from "node:test";

import { TDEI_SSO_CLIENT_ID } from "./helpers/sso-client.js";

process.env.TDEI_SSO_CALLBACK_URL = "http://127.0.0.1:18765/callback";
const { AuthManager } = await import("../src/auth/auth-manager.js");

test("browser callback exchanges code and state for tokens", async () => {
  const originalFetch = globalThis.fetch;
  let exchangeBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/api/v1/sso-login") {
      exchangeBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        access_token: "sso-access-token",
        refresh_token: "sso-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const auth = new AuthManager();
  try {
    const login = await auth.startSsoLogin();
    const loginUrl = new URL(login.loginUrl);
    assert.equal(loginUrl.pathname, "/api/v1/sso-redirect");
    assert.equal(loginUrl.searchParams.get("client_id"), TDEI_SSO_CLIENT_ID);
    assert.equal(loginUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:18765/callback");
    assert.equal(auth.getStatus().state, "login_pending");

    const callbackResponse = await originalFetch(
      "http://127.0.0.1:18765/callback?code=test-code&state=test-state",
    );
    assert.equal(callbackResponse.status, 200);
    await login.completion;

    assert.deepEqual(exchangeBody, {
      code: "test-code",
      state: "test-state",
      clientId: TDEI_SSO_CLIENT_ID,
    });
    assert.equal(auth.getStatus().state, "authenticated");
    assert.equal(await auth.getAccessToken(), "sso-access-token");

    const logout = await auth.logout();
    const logoutUrl = new URL(logout.logoutUrl);
    assert.equal(logoutUrl.pathname, "/api/v1/sso-logout");
    assert.equal(logoutUrl.searchParams.get("client_id"), TDEI_SSO_CLIENT_ID);
    assert.equal(logoutUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:18765/callback");
    assert.equal(auth.getStatus().state, "logout_pending");

    const logoutCallbackResponse = await originalFetch(logout.callbackUrl);
    assert.equal(logoutCallbackResponse.status, 200);
    await logout.completion;
    assert.equal(auth.getStatus().state, "signed_out");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP callback completion exchanges code when the browser cannot reach loopback", async () => {
  const originalFetch = globalThis.fetch;
  let exchangeBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/api/v1/sso-login") {
      exchangeBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        access_token: "relayed-access-token",
        refresh_token: "relayed-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const auth = new AuthManager();
  try {
    const login = await auth.startSsoLogin();
    await auth.completeSsoLogin(
      "http://127.0.0.1:18765/callback?code=relayed-code&state=relayed-state",
    );
    await login.completion;

    assert.deepEqual(exchangeBody, {
      code: "relayed-code",
      state: "relayed-state",
      clientId: TDEI_SSO_CLIENT_ID,
    });
    assert.equal(auth.getStatus().state, "authenticated");
    assert.equal(await auth.getAccessToken(), "relayed-access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startSsoLogin enforces expected state when provided and rejects cross-site subresource callbacks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/api/v1/sso-login") {
      return new Response(JSON.stringify({
        access_token: "csrf-verified-token",
        expires_in: 3600,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const auth = new AuthManager();
  try {
    const login = await auth.startSsoLogin({ state: "csrf-nonce-123" });
    const loginUrl = new URL(login.loginUrl);
    assert.equal(loginUrl.searchParams.get("state"), "csrf-nonce-123");

    // Cross-site subresource fetch (e.g. <img>/<script> CSRF probe) is rejected with 403
    const crossSiteRes = await originalFetch(
      "http://127.0.0.1:18765/callback?code=abc&state=csrf-nonce-123",
      {
        headers: {
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "no-cors",
        },
      },
    );
    assert.equal(crossSiteRes.status, 403);
    assert.equal(crossSiteRes.headers.get("x-content-type-options"), "nosniff");

    // Mismatched state is rejected while keeping pendingLogin alive
    await assert.rejects(
      () => auth.completeSsoLogin("http://127.0.0.1:18765/callback?code=abc&state=wrong-state"),
      /state mismatch/,
    );

    // Matching state succeeds
    await auth.completeSsoLogin("http://127.0.0.1:18765/callback?code=abc&state=csrf-nonce-123");
    await login.completion;
    assert.equal(await auth.getAccessToken(), "csrf-verified-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("seedInjectedToken decodes JWT exp claim and sanitizeAuthErrorDetail strips HTML and caps length", async () => {
  const { injectAccessToken, extractJwtExpirationMs, sanitizeAuthErrorDetail } = await import(
    "../src/auth/auth-manager.js"
  );
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const pastExpSeconds = Math.floor(Date.now() / 1000) - 60;
  const expiredPayload = Buffer.from(JSON.stringify({ sub: "u1", exp: pastExpSeconds })).toString("base64url");
  const expiredJwt = `${header}.${expiredPayload}.sig`;

  assert.equal(extractJwtExpirationMs(expiredJwt), pastExpSeconds * 1000);

  let calledFetch = false;
  const expiredMgr = injectAccessToken(expiredJwt);
  await assert.rejects(
    () =>
      expiredMgr.validateToken(async () => {
        calledFetch = true;
        return new Response("[]", { status: 200 });
      }),
    /TDEI_TOKEN_EXPIRED/,
  );
  assert.equal(calledFetch, false, "expired JWT must fail local expiry check without probing upstream");

  const sanitized = sanitizeAuthErrorDetail("<html><body><h1>Error</h1>\n<script>alert(1)</script>" + "x".repeat(300));
  assert.equal(sanitized.includes("<"), false);
  assert.ok(sanitized.length <= 203);
});
