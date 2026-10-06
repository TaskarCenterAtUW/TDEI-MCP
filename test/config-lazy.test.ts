import { strict as assert } from "node:assert";
import test from "node:test";

import { loadConfig, getConfig, TdeiConfigError } from "../src/config.js";
import { TDEI_SSO_CLIENT_ID } from "./helpers/sso-client.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("bad api url yields ok:false naming var and rule (no throw)", () => {
  withEnv({ TDEI_API_URL: "http://insecure.example.com" }, () => {
    const result = loadConfig();
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1);
    const first = result.errors[0];
    assert.equal(first.var, "TDEI_API_URL");
    assert.match(first.rule, /HTTPS/);
    assert.ok(first.example.startsWith("https://"));
  });
});

test("valid env yields ok:true with defaults", () => {
  withEnv({
    TDEI_API_URL: undefined,
    TDEI_TRANSPORT: undefined,
    TDEI_HTTP_PORT: undefined,
    // Env override must be ignored — client id is fixed to tdei-mcp.
    TDEI_SSO_CLIENT_ID: "tdei-gateway",
  }, () => {
    const result = loadConfig();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.apiUrl, "https://api-dev.tdei.us");
      assert.equal(result.config.ssoClientId, TDEI_SSO_CLIENT_ID);
      assert.equal(result.config.ssoClientId, "tdei-mcp");
      assert.equal(result.config.transport, "stdio");
      assert.equal(result.config.httpPort, 3000);
      assert.equal(
        result.config.specUrl,
        "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json",
      );
      assert.equal(result.config.ssoCallbackUrl, "http://127.0.0.1:8765/callback");
      assert.equal(result.config.awsMcpPackage, "awslabs.openapi-mcp-server@1.1.2");
    }
  });
});

test("spec URL follows TDEI_API_URL when TDEI_SPEC_URL is unset", () => {
  withEnv({
    TDEI_API_URL: "https://api-stage.tdei.us",
    TDEI_SPEC_URL: undefined,
  }, () => {
    const result = loadConfig();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.config.specUrl,
      "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/stage/tdei-api-gateway.json",
    );
  });
});

test("optional geocoder configuration requires HTTPS and preserves identity", () => {
  withEnv({
    TDEI_GEOCODER_URL: "https://geo.example.test/search",
    TDEI_GEOCODER_USER_AGENT: "tdei-mcp/example-contact",
  }, () => {
    const result = loadConfig();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.geocoderUrl, "https://geo.example.test/search");
    assert.equal(result.config.geocoderUserAgent, "tdei-mcp/example-contact");
  });
  withEnv({ TDEI_GEOCODER_URL: "http://geo.example.test/search" }, () => {
    const result = loadConfig();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.var === "TDEI_GEOCODER_URL"));
  });
});

test("getConfig throws TdeiConfigError carrying errors", () => {
  withEnv({ TDEI_HTTP_PORT: "banana" }, () => {
    assert.throws(() => getConfig(), (error: unknown) => {
      assert.ok(error instanceof TdeiConfigError);
      assert.ok(error.errors.some((e) => e.var === "TDEI_HTTP_PORT"));
      return true;
    });
  });
});

// getConfig() memoizes the first SUCCESSFUL load per process; earlier tests
// use loadConfig() (unmemoized), so this stays order-safe.
test("getConfig memoizes successful loads", () => {
  withEnv({ TDEI_HTTP_PORT: undefined }, () => {
    const first = getConfig();
    const second = getConfig();
    assert.equal(first, second);
  });
});
