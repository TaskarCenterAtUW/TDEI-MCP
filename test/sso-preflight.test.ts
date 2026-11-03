import { strict as assert } from "node:assert";
import test from "node:test";

import { preflightSsoLogin } from "../src/auth/sso-preflight.js";

const REDIRECT_URI = "http://127.0.0.1:18767/callback";
const KEYCLOAK_URL = "https://account-stage.tdei.us/realms/tdei/protocol/openid-connect/auth";

function keycloakResponse(body: string, status = 400): Response {
  const response = new Response(body, { status, headers: { "Content-Type": "text/html" } });
  Object.defineProperty(response, "url", { value: KEYCLOAK_URL });
  return response;
}

function stubFetch(response: Response | (() => Promise<never>)): typeof fetch {
  return (async () => (typeof response === "function" ? response() : response)) as typeof fetch;
}

test("reports an unregistered redirect_uri with the Keycloak console fix", async () => {
  const message = await preflightSsoLogin("https://api-stage.tdei.us/api/v1/sso-redirect?x=1", {
    redirectUri: REDIRECT_URI,
    clientId: "tdei-mcp",
    fetchImpl: stubFetch(
      keycloakResponse('<html><body><p class="instruction">Invalid parameter: redirect_uri</p></body></html>'),
    ),
  });

  assert.ok(message, "expected a preflight failure message");
  assert.match(message, /Keycloak rejected the SSO redirect_uri "http:\/\/127\.0\.0\.1:18767\/callback"/);
  assert.match(message, /client "tdei-mcp"/);
  assert.match(message, /realm "tdei"/);
  assert.match(message, /https:\/\/account-stage\.tdei\.us\/admin/);
  assert.match(message, /Valid redirect URIs/);
  assert.match(message, /call tdei_sso_login again/);
  assert.match(message, /No MCP-side setting can work around this/);
});

test("reports a missing Keycloak client", async () => {
  const message = await preflightSsoLogin("https://api-stage.tdei.us/api/v1/sso-redirect", {
    redirectUri: REDIRECT_URI,
    clientId: "tdei-mcp",
    fetchImpl: stubFetch(keycloakResponse("<html><p>Client not found</p></html>")),
  });

  assert.ok(message);
  assert.match(message, /does not know the SSO client "tdei-mcp"/);
  assert.match(message, /TDEI_SSO_CLIENT_ID/);
});

test("returns undefined for a healthy Keycloak login form", async () => {
  const message = await preflightSsoLogin("https://api-stage.tdei.us/api/v1/sso-redirect", {
    redirectUri: REDIRECT_URI,
    clientId: "tdei-mcp",
    fetchImpl: stubFetch(keycloakResponse('<html><form id="kc-form-login"></form></html>', 200)),
  });

  assert.equal(message, undefined);
});

test("fails open when the preflight request itself fails", async () => {
  const message = await preflightSsoLogin("https://api-stage.tdei.us/api/v1/sso-redirect", {
    redirectUri: REDIRECT_URI,
    clientId: "tdei-mcp",
    fetchImpl: stubFetch(async () => {
      throw new Error("network down");
    }),
  });

  assert.equal(message, undefined);
});

test("fails open on non-Keycloak error pages", async () => {
  const message = await preflightSsoLogin("https://api-stage.tdei.us/api/v1/sso-redirect", {
    redirectUri: REDIRECT_URI,
    clientId: "tdei-mcp",
    fetchImpl: stubFetch(keycloakResponse("<html><h1>502 Bad Gateway</h1></html>", 502)),
  });

  assert.equal(message, undefined);
});
