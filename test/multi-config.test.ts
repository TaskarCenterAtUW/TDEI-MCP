import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveMultiMcp, slugifyName } from "../src/multi-config.js";

describe("multi-config", () => {
  it("slugifies names", () => {
    assert.equal(slugifyName("TDEI Core"), "tdei-core");
    assert.equal(slugifyName("tdei_workspace"), "tdei-workspace");
  });

  it("auto-increments ports and deduces spec + basePath", () => {
    const servers = resolveMultiMcp({
      host: "127.0.0.1",
      basePort: 3000,
      servers: [
        { name: "tdei-core", apiUrl: "https://api-dev.tdei.us" },
        { name: "tdei-workspace", apiUrl: "https://api-stage.tdei.us" },
      ],
    });
    assert.equal(servers.length, 2);
    assert.equal(servers[0]?.port, 3000);
    assert.equal(servers[1]?.port, 3001);
    assert.equal(servers[0]?.basePath, "/tdei-core/mcp");
    assert.equal(servers[1]?.basePath, "/tdei-workspace/mcp");
    assert.equal(servers[0]?.url, "http://127.0.0.1:3000/tdei-core/mcp");
    assert.ok(servers[0]?.specUrl.includes("TDEI-ExternalAPIs/dev"));
    assert.ok(servers[1]?.specUrl.includes("TDEI-ExternalAPIs/stage"));
    assert.equal(servers[0]?.ssoCallbackUrl, "http://127.0.0.1:8765/callback");
    assert.equal(servers[1]?.ssoCallbackUrl, "http://127.0.0.1:8765/callback");
  });

  it("shares one SSO callback URL across every server", () => {
    const servers = resolveMultiMcp({
      ssoCallbackPort: 9000,
      servers: [
        { name: "tdei-core-dev", apiUrl: "https://api-dev.tdei.us" },
        { name: "tdei-core-staging", apiUrl: "https://api-stage.tdei.us" },
        { name: "tdei-core-production", apiUrl: "https://api.tdei.us" },
      ],
    });
    assert.deepEqual(
      servers.map((server) => server.ssoCallbackUrl),
      ["http://127.0.0.1:9000/callback", "http://127.0.0.1:9000/callback", "http://127.0.0.1:9000/callback"],
    );
  });

  it("rejects per-server callback overrides that would split the registered redirect URI", () => {
    assert.throws(
      () =>
        resolveMultiMcp({
          servers: [
            { name: "dev", apiUrl: "https://api-dev.tdei.us" },
            {
              name: "staging",
              apiUrl: "https://api-stage.tdei.us",
              ssoCallbackUrl: "http://127.0.0.1:8766/callback",
            },
          ],
        }),
      /servers\[1\] \(staging\): ssoCallbackUrl "http:\/\/127\.0\.0\.1:8766\/callback" must match "http:\/\/127\.0\.0\.1:8765\/callback"/,
    );
    assert.doesNotThrow(() =>
      resolveMultiMcp({
        servers: [
          { name: "dev", apiUrl: "https://api-dev.tdei.us", ssoCallbackUrl: "http://127.0.0.1:8765/callback" },
          { name: "staging", apiUrl: "https://api-stage.tdei.us", ssoCallbackUrl: "http://127.0.0.1:8765/callback" },
        ],
      }),
    );
  });

  it("rejects duplicate slugs and port collisions", () => {
    assert.throws(() =>
      resolveMultiMcp({
        servers: [
          { name: "a", apiUrl: "https://api-dev.tdei.us" },
          { name: "A", apiUrl: "https://api-dev.tdei.us" },
        ],
      }),
    );
    assert.throws(() =>
      resolveMultiMcp({
        basePort: 3000,
        servers: [
          { name: "a", apiUrl: "https://api-dev.tdei.us", port: 3000 },
          { name: "b", apiUrl: "https://api-dev.tdei.us", port: 3000 },
        ],
      }),
    );
  });
});
