import { strict as assert } from "node:assert";
import test from "node:test";

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
    assert.equal(loginUrl.searchParams.get("client_id"), "tdei-mcp");
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
      clientId: "tdei-mcp",
    });
    assert.equal(auth.getStatus().state, "authenticated");
    assert.equal(await auth.getAccessToken(), "sso-access-token");
  } finally {
    auth.logout();
    globalThis.fetch = originalFetch;
  }
});
