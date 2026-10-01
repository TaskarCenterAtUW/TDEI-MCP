import { strict as assert } from "node:assert";
import test from "node:test";

import { loadConfig, getConfig, TdeiConfigError } from "../src/config.js";

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
  withEnv({ TDEI_API_URL: undefined, TDEI_TRANSPORT: undefined, TDEI_HTTP_PORT: undefined }, () => {
    const result = loadConfig();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.apiUrl, "https://api-dev.tdei.us");
      assert.equal(result.config.transport, "stdio");
      assert.equal(result.config.httpPort, 3000);
    }
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
