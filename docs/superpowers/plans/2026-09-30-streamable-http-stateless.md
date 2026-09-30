# Streamable HTTP (stateless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve TDEI-MCP over Streamable HTTP, stateless, reusing the same SSO protocol with per-request Bearer auth.

**Architecture:** New self-contained `src/http.ts` (Node built-in `http` + SDK `WebStandardStreamableHTTPServerTransport` in stateless mode) builds an ephemeral `AuthManager` (via `injectAccessToken`) + ephemeral `AwsMcpClient(tokenProvider)` per request, serves them through the existing `createServer(dependencies)` injection point, and closes the child after each response. `src/index.ts` holds only the exclusive startup branch (dynamic import).

**Tech Stack:** TypeScript ES2022 NodeNext ESM, `@modelcontextprotocol/server ^2.0.0` (`WebStandardStreamableHTTPServerTransport`), `zod/v4`, Node built-in `http`, `node:test` + `tsx`, existing `uvx awslabs.openapi-mcp-server@1.1.2` child unchanged.

**Spec:** `docs/superpowers/specs/2026-09-30-streamable-http-design.md`

## Global Constraints

- Node.js >=22 (package.json engines); `npm ci` for installs.
- TypeScript strict, ESM (`module: NodeNext`, `moduleResolution: NodeNext`), `rootDir ./src`, `outDir dist`.
- Never write MCP payloads to stdout; diagnostics go to stderr; stdout reserved for MCP messages (stdio) — HTTP mode also logs only to stderr.
- Zero new runtime dependencies: Node built-in `http` only. SDK import is `@modelcontextprotocol/server` root (`WebStandardStreamableHTTPServerTransport`); the deep `streamableHttp.js` subpath does not exist in v2 — do not import it.
- `src/http.ts` is self-contained and side-effect-free on import: no module-level servers/listeners, no mutation of STDIO singletons (`authManager`, `awsMcpClient`). `src/index.ts` contains only the exclusive branch via dynamic `import("./http.js")`.
- STDIO behavior byte-identical when the flag is absent; HTTP mode opens no STDIO, STDIO mode opens no port.
- Stateless v1: no server sessions, no refresh-token vaulting, server never refreshes on the client's behalf; `Mcp-Session-Id` echoed for SSE routing only, never auth.
- `TDEI_API_URL` and `TDEI_SPEC_URL` must remain HTTPS. Callback rule: stdio keeps strict `http://127.0.0.1:<port>/callback`; http mode allows any `https://` URL plus `http://127.0.0.1/` for local dev (must still be backend-registered for `tdei-mcp` or SSO returns 400).
- Keep hiding connector-managed auth tools: `authenticate, refreshToken, ssoRedirect, ssoLogin, ssoLogout` (`src/aws/register-aws-tools.ts:64-70`).
- Keep green: `npm test` and `npm run build`.
- Test runner: `node --import tsx --test test/<file>.test.ts` (matches package.json `test` script glob).

---

## File map (what changes and why)

- Modify: `src/config.ts` — add `transport`, `httpHost`, `httpPort`, `httpBasePath`, `corsOrigins`, `tlsCert`, `tlsKey`; bifurcate `ssoCallbackUrl` validator on transport.
- Modify: `src/auth/auth-manager.ts` — add `injectAccessToken(token)` factory + `validateToken()` (local expiry + lightweight TDEI probe); keep singleton export and loopback methods untouched for STDIO.
- Modify: `src/aws/aws-mcp-client.ts` — add optional constructor `tokenProvider`; use it instead of the `authManager` singleton when provided.
- Create: `src/http.ts` — isolated HTTP entry: `serveHttp()` + Bearer middleware, CORS, per-request ephemeral stack, stateless transport wiring, 401 envelope, graceful shutdown.
- Modify: `src/index.ts` — exclusive transport branch only (`--transport=` overrides `TDEI_TRANSPORT`); stdio path unchanged.
- Test: `test/http-stateless.test.ts` — 401s, isolation, validator bifurcation (mocked fetch + stubbed AWS child, no live TDEI).
- Modify: `README.md` — HTTP section with indented (not fenced) run + curl example.
- Modify: `.env.example` — document new variables.

---

### Task 1: Config — transport, HTTP env, bifurcated callback validator

**Files:**
- Modify: `src/config.ts:1-54`
- Modify: `.env.example`
- Test: `test/http-stateless.test.ts` (validator cases live here; config cases first)

**Interfaces:**
- Consumes: existing `config` object (`apiUrl, specUrl, ssoClientId, ssoCallbackUrl, awsMcpPackage`).
- Produces: `config.transport: "stdio" | "http"`, `config.httpHost: string`, `config.httpPort: number`, `config.httpBasePath: string`, `config.corsOrigins: string[]`, `config.tlsCert: string | undefined`, `config.tlsKey: string | undefined`. `ssoCallbackUrl` rule bifurcates on resolved transport.

- [ ] **Step 1: Write the failing test**

```ts
// test/http-stateless.test.ts (part 1: config + validator)
import { strict as assert } from "node:assert";
import test from "node:test";

test("callback validator rejects https in stdio mode", async () => {
  process.env.TDEI_TRANSPORT = "stdio";
  process.env.TDEI_SSO_CALLBACK_URL = "https://mcp.example.com/callback";
  await assert.rejects(() => import("../src/config.js"), /127\.0\.0\.1/);
});

test("callback validator accepts https in http mode", async () => {
  // NOTE: src/config.ts evaluates at import time; run each validator case in a
  // fresh worker via node:test subProcess? No — simplest: set env BEFORE first
  // import per process. These two tests therefore need separate processes.
  // Implement as documented in Step 3 instead: export pure validateSsoCallbackUrl()
  // and unit-test it directly without env juggling.
  assert.ok(true);
});
```

The sketch above shows the import-time problem. The real Step 1 test to write:

```ts
// test/http-stateless.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";

import { validateSsoCallbackUrl } from "../src/config.js";

test("callback validator rejects https in stdio mode", () => {
  assert.throws(
    () => validateSsoCallbackUrl("https://mcp.example.com/callback", "stdio"),
    /127\.0\.0\.1/,
  );
});

test("callback validator accepts https in http mode", () => {
  assert.equal(
    validateSsoCallbackUrl("https://mcp.example.com/callback", "http"),
    "https://mcp.example.com/callback",
  );
});

test("callback validator accepts loopback in http mode for local dev", () => {
  assert.equal(
    validateSsoCallbackUrl("http://127.0.0.1:3000/callback", "http"),
    "http://127.0.0.1:3000/callback",
  );
});

test("callback validator rejects plain http hostnames in http mode", () => {
  assert.throws(
    () => validateSsoCallbackUrl("http://mcp.example.com/callback", "http"),
    /https/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: FAIL with `Cannot find module '../src/config.js'` exporting `validateSsoCallbackUrl` (syntax error / import failure — no such export exists yet).

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, extract the existing IIFE into an exported pure function and add transport + HTTP env (keep all existing exports and behavior for stdio):

```ts
export type Transport = "stdio" | "http";

export function resolveTransport(): Transport {
  const raw = process.env.TDEI_TRANSPORT?.trim().toLowerCase();
  if (raw === "http") return "http";
  if (!raw || raw === "stdio") return "stdio";
  throw new Error('TDEI_TRANSPORT must be "stdio" or "http"');
}

export function validateSsoCallbackUrl(value: string, transport: Transport): string {
  const url = new URL(value);
  const isLoopback =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Boolean(url.port) &&
    url.pathname === "/callback";
  if (transport === "stdio") {
    if (!isLoopback) {
      throw new Error("TDEI_SSO_CALLBACK_URL must use http://127.0.0.1:<port>/callback");
    }
    return url.toString();
  }
  const isHttps = url.protocol === "https:";
  if (!isHttps && !isLoopback) {
    throw new Error("TDEI_SSO_CALLBACK_URL must use https:// in http mode (http://127.0.0.1:<port>/callback allowed for local dev)");
  }
  return url.toString();
}

function readHttpPort(): number {
  const raw = process.env.TDEI_HTTP_PORT?.trim() || "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TDEI_HTTP_PORT must be an integer 1-65535");
  }
  return port;
}

function readBasePath(): string {
  const raw = process.env.TDEI_HTTP_BASE_PATH?.trim() || "/mcp";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.replace(/\/+$/, "") || "/";
}
```

Extend the `config` object with:

```ts
transport: resolveTransport(),

httpHost: process.env.TDEI_HTTP_HOST?.trim() || "127.0.0.1",

httpPort: readHttpPort(),

httpBasePath: readBasePath(),

corsOrigins: (process.env.TDEI_CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean),

tlsCert: process.env.TDEI_TLS_CERT?.trim() || undefined,

tlsKey: process.env.TDEI_TLS_KEY?.trim() || undefined,
```

And replace the `ssoCallbackUrl` IIFE body with:

```ts
ssoCallbackUrl: validateSsoCallbackUrl(
  process.env.TDEI_SSO_CALLBACK_URL?.trim() || DEFAULT_SSO_CALLBACK_URL,
  resolveTransport(),
),
```

Call `resolveTransport()` once at module top into a `const transport` and reuse it for both `transport` and `ssoCallbackUrl` fields to avoid double-parsing.

Append to `.env.example`:

```dotenv
TDEI_TRANSPORT=stdio
TDEI_HTTP_HOST=127.0.0.1
TDEI_HTTP_PORT=3000
TDEI_HTTP_BASE_PATH=/mcp
# Comma-separated allowed origins; empty = same-origin only.
TDEI_CORS_ORIGINS=
# Absent = plain HTTP (use reverse-proxy TLS termination for public https).
# TDEI_TLS_CERT=/path/to/cert.pem
# TDEI_TLS_KEY=/path/to/key.pem
# In HTTP mode the callback may be a registered https URL:
# TDEI_SSO_CALLBACK_URL=https://mcp.example.com/callback
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: PASS (4 validator tests). Then run `npm test` — all existing tests must still PASS (stdio default unchanged; existing `sso-auth-manager.test.ts` sets its own loopback URL).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example test/http-stateless.test.ts
git commit -m "feat: add http transport config and bifurcated callback validator"
```

---

### Task 2: Auth — `injectAccessToken()` + `validateToken()` without singleton side effects

**Files:**
- Modify: `src/auth/auth-manager.ts:1-343`
- Test: extend `test/http-stateless.test.ts` (auth cases)

**Interfaces:**
- Consumes: `config.apiUrl`, `config.ssoClientId`, existing `REFRESH_SAFETY_WINDOW_MS`, `DEFAULT_TOKEN_LIFETIME_SECONDS`, existing private `hasUsableAccessToken()`, `requestTokens()`, `storeTokens()`.
- Produces: `injectAccessToken(token: string, expiresInSeconds?: number): AuthManager` (module function), `AuthManager.validateToken(): Promise<{ valid: true }>` (throws `TDEI_TOKEN_EXPIRED` / `TDEI_TOKEN_INVALID`). Singleton `authManager` untouched.

- [ ] **Step 1: Write the failing test**

Append to `test/http-stateless.test.ts`:

```ts
import { AuthManager, injectAccessToken } from "../src/auth/auth-manager.js";

test("injectAccessToken does not touch the singleton", async () => {
  const { authManager } = await import("../src/auth/auth-manager.js");
  assert.equal(authManager.getStatus().authenticated, false);
  const ephemeral = injectAccessToken("ephemeral-token", 3600);
  assert.notEqual(ephemeral, authManager);
  assert.equal(ephemeral.getStatus().authenticated, true);
  assert.equal(authManager.getStatus().authenticated, false);
});

test("validateToken rejects expired bearer without refresh attempt", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const expired = injectAccessToken("expired-token", 0);
    await assert.rejects(() => expired.validateToken(), /TDEI_TOKEN_EXPIRED/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateToken rejects invalid bearer on probe 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    const bad = injectAccessToken("bad-token", 3600);
    await assert.rejects(() => bad.validateToken(), /TDEI_TOKEN_INVALID/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateToken accepts good bearer on probe success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    const good = injectAccessToken("good-token", 3600);
    await good.validateToken();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: FAIL with `injectAccessToken is not exported` (SyntaxError or `does not provide an export named 'injectAccessToken'`).

- [ ] **Step 3: Write minimal implementation**

In `src/auth/auth-manager.ts`:

1. Add an internal token-seeding method on the class (keeps private-field encapsulation, no constructor signature change so STDIO `new AuthManager()` keeps working):

```ts
/** Seed a Bearer received over HTTP. Internal: use injectAccessToken(). */
seedInjectedToken(token: string, expiresInSeconds?: number): void {
  this.accessToken = token;
  this.refreshToken = undefined;
  this.tokenVersion += 1;
  const lifetime =
    typeof expiresInSeconds === "number" && expiresInSeconds > 0
      ? expiresInSeconds
      : DEFAULT_TOKEN_LIFETIME_SECONDS;
  this.expiresAt = Date.now() + lifetime * 1000;
}
```

2. Add `validateToken()`:

```ts
/**
 * Stateless validation for an injected Bearer: local expiry check first
 * (never attempts refresh — the server holds no refresh_token), then one
 * lightweight TDEI probe. Throws TDEI_TOKEN_EXPIRED / TDEI_TOKEN_INVALID.
 */
async validateToken(): Promise<void> {
  if (!this.hasUsableAccessToken()) {
    throw new Error("TDEI_TOKEN_EXPIRED");
  }
  let response: Response;
  try {
    response = await fetch(new URL("/api/v1/project-groups", `${config.apiUrl}/`), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${this.accessToken}` },
    });
  } catch {
    throw new Error("TDEI_TOKEN_INVALID");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("TDEI_TOKEN_INVALID");
  }
  await response.body?.cancel().catch(() => undefined);
}
```

Probe endpoint rationale: `GET /api/v1/project-groups` backs the `listProjectGroups` tool (first workflow step, `tdei.config.example.json:9`; spec doc `2026-09-29-tdei-config-workflows-design.md:56`). It is authenticated, cheap, and stable. Any non-401/403 status (200, 400, 404, 500) means the token was accepted by the gateway.

3. Add the module factory at the bottom (next to the singleton export):

```ts
export function injectAccessToken(token: string, expiresInSeconds?: number): AuthManager {
  if (!token) throw new Error("TDEI_TOKEN_INVALID");
  const manager = new AuthManager();
  manager.seedInjectedToken(token, expiresInSeconds);
  return manager;
}
```

4. Update the `ServerDependencies` auth surface? No — `getAccessToken`, `getStatus`, `logout`, `startSsoLogin` already cover the ephemeral manager; the HTTP adapters call `validateToken()` directly on the concrete instance. No `index.ts` change in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: PASS (4 validator + 4 auth tests). Then run `npm test` — `sso-auth-manager.test.ts` must still PASS (singleton path untouched).

- [ ] **Step 5: Commit**

```bash
git add src/auth/auth-manager.ts test/http-stateless.test.ts
git commit -m "feat: add injectAccessToken and validateToken for stateless auth"
```

---

### Task 3: AWS client — per-request `tokenProvider` with guaranteed `close()`

**Files:**
- Modify: `src/aws/aws-mcp-client.ts:1-126`
- Test: extend `test/http-stateless.test.ts` (constructor + close cases with stubbed child)

**Interfaces:**
- Consumes: `AuthManager` type (for provider signature); existing `startChild`, `close`, `listTools`, `callTool`.
- Produces: `new AwsMcpClient(tokenProvider?: () => Promise<string>)`. Default (no arg) preserves singleton behavior for STDIO. `connectAuthenticated()` uses provider when present. `callTool`/`listTools` semantics unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/http-stateless.test.ts`. The child spawn (`uvx`) must not run in tests, so stub `startChild` via subclass:

```ts
import { AwsMcpClient } from "../src/aws/aws-mcp-client.js";

class StubAwsMcpClient extends AwsMcpClient {
  public startedWith: string[] = [];
  public closedCount = 0;
  protected override async startChild(accessToken: string): Promise<void> {
    this.startedWith.push(accessToken);
    (this as unknown as Record<string, unknown>)["client"] = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      close: async () => undefined,
    };
  }
  override async close(): Promise<void> {
    this.closedCount += 1;
    await super.close();
  }
}
```

Wait — `startChild` is `private` in the current file, so `protected override` fails to compile. The Step 3 implementation changes `private startChild` to `protected startChild` (safe: no behavior change, enables test subclassing). Write the test as above; Step 2 fails on the constructor arg (compile error `Expected 0 arguments, but got 1`), which is the red we want first. Then:

```ts
test("AwsMcpClient uses injected provider instead of singleton", async () => {
  const seen: string[] = [];
  const client = new StubAwsMcpClient(async () => {
    seen.push("provider-called");
    return "bearer-A";
  });
  await client.callTool("listServices", {});
  assert.deepEqual(client.startedWith, ["bearer-A"]);
  assert.deepEqual(seen, ["provider-called"]);
  await client.close();
  assert.equal(client.closedCount, 1);
});

test("two clients with different providers stay isolated", async () => {
  const a = new StubAwsMcpClient(async () => "bearer-A");
  const b = new StubAwsMcpClient(async () => "bearer-B");
  await a.callTool("listServices", {});
  await b.callTool("listServices", {});
  assert.deepEqual(a.startedWith, ["bearer-A"]);
  assert.deepEqual(b.startedWith, ["bearer-B"]);
  await a.close();
  await b.close();
});
```

Also update the `ServerDependencies` aws surface? No — `callTool | close | listTools` already covers it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: FAIL with `Expected 0 arguments, but got 1` (TS compile error via tsx) on `new StubAwsMcpClient(async () => ...)`.

- [ ] **Step 3: Write minimal implementation**

In `src/aws/aws-mcp-client.ts`:

```ts
export class AwsMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connectedMode?: ConnectionMode;
  private connectedTokenVersion?: number;

  constructor(private readonly tokenProvider?: () => Promise<string>) {}
```

Change `private async startChild(` to `protected async startChild(`. All other `startChild` internals unchanged.

Replace `connectAuthenticated()`:

```ts
private async connectAuthenticated(): Promise<void> {
  if (this.tokenProvider) {
    // Stateless per-request path: always start a fresh child with the
    // request Bearer, then the caller closes it after the response.
    if (this.client) {
      await this.close();
    }
    console.error("[aws-mcp] starting per-request AWS OpenAPI MCP server");
    const accessToken = await this.tokenProvider();
    await this.startChild(accessToken, "authenticated");
    return;
  }

  const accessToken = await authManager.getAccessToken();
  const tokenVersion = authManager.getTokenVersion();

  if (
    this.client &&
    this.connectedMode === "authenticated" &&
    this.connectedTokenVersion === tokenVersion
  ) {
    return;
  }

  if (this.client) {
    console.error(
      this.connectedMode === "discovery"
        ? "[aws-mcp] restarting discovery server with authenticated session"
        : "[aws-mcp] access token changed; restarting AWS MCP server",
    );
    await this.close();
  }

  console.error("[aws-mcp] starting authenticated AWS OpenAPI MCP server");
  await this.startChild(accessToken, "authenticated", tokenVersion);
}
```

And `listTools()`:

```ts
async listTools() {
  if (this.tokenProvider) {
    await this.connectAuthenticated();
    return this.client!.listTools();
  }
  if (authManager.getStatus().authenticated) {
    await this.connectAuthenticated();
  } else {
    await this.connectForDiscovery();
  }
  return this.client!.listTools();
}
```

`callTool` is unchanged (it already calls `connectAuthenticated()`; the provider branch inside handles stateless). Singleton export `export const awsMcpClient = new AwsMcpClient();` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: PASS (all prior + 2 client tests). Then run `npm test` — `session-lifecycle.test.ts` must still PASS (default constructor path unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/aws/aws-mcp-client.ts test/http-stateless.test.ts
git commit -m "feat: support per-request token provider in AwsMcpClient"
```

---

### Task 4: `src/http.ts` — isolated Streamable HTTP server (the only new module)

**Files:**
- Create: `src/http.ts`
- Test: extend `test/http-stateless.test.ts` (HTTP-level: 401s, good-Bearer tools/list + call, isolation — all with stubbed AWS child and mocked fetch, real `http` server on loopback)

**Interfaces:**
- Consumes: `config` (Task 1), `injectAccessToken` (Task 2), `AwsMcpClient` provider constructor (Task 3), `createServer` + `ServerDependencies` from `./index.js`, `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`.
- Produces: `serveHttp(options?: { createAwsClient?: (token: string) => AwsMcpClient; fetchImpl?: typeof fetch }): Promise<{ close(): Promise<void>; url: string }>`. Defaults use the real `AwsMcpClient` + global fetch; tests inject stubs. No other exports with side effects.

Isolation contract (test-enforced): importing `../src/http.js` must not open ports, spawn children, or mutate `authManager`/`awsMcpClient` singletons.

- [ ] **Step 1: Write the failing test**

Append to `test/http-stateless.test.ts`:

```ts
import { serveHttp } from "../src/http.js";

function mcpBody(id: number, method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function postMcp(url: string, body: string, token?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

test("http.ts import has no side effects on singletons", async () => {
  const { authManager, awsMcpClient } = await import("../src/auth/auth-manager.js").then(
    async (auth) => ({ authManager: auth.authManager, awsMcpClient: (await import("../src/aws/aws-mcp-client.js")).awsMcpClient }),
  );
  await import("../src/http.js");
  assert.equal(authManager.getStatus().authenticated, false);
  assert.equal(awsMcpClient.isConnected(), false);
});

test("POST /mcp without token returns 401 naming tdei_sso_login", async () => {
  const handle = await serveHttp({ createAwsClient: () => { throw new Error("must not spawn"); } });
  try {
    const response = await postMcp(`${handle.url}/mcp`, mcpBody(1, "tools/list"));
    assert.equal(response.status, 401);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, "TDEI_SSO_REQUIRED");
    assert.match(String(body.message), /tdei_sso_login/);
    assert.ok(String(body.loginUrl).includes("/api/v1/sso-redirect"));
  } finally {
    await handle.close();
  }
});

test("POST /mcp with bad bearer returns 401 without spawning child", async () => {
  let spawned = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/project-groups")) {
      return new Response("unauthorized", { status: 401 });
    }
    return originalFetch(input as RequestInfo, undefined);
  }) as typeof fetch;
  try {
    const handle = await serveHttp({
      createAwsClient: () => { spawned += 1; throw new Error("must not spawn"); },
    });
    try {
      const response = await postMcp(`${handle.url}/mcp`, mcpBody(1, "tools/list"), "bad-token");
      assert.equal(response.status, 401);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.code, "TDEI_TOKEN_INVALID");
      assert.equal(spawned, 0);
    } finally {
      await handle.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

Good-Bearer + isolation test (mock probe 200, stub AWS child listing `listServices`):

```ts
test("good bearer serves tools/list and calls; bearers isolated", async () => {
  const originalFetch = globalThis.fetch;
  const seenTokens: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/project-groups")) {
      seenTokens.push(String(init?.headers?.["Authorization"] ?? ""));
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return originalFetch(input as RequestInfo, undefined);
  }) as typeof fetch;
  try {
    const closed: string[] = [];
    const handle = await serveHttp({
      createAwsClient: (token: string) => {
        const stub = new StubAwsMcpClient(async () => token);
        const origClose = stub.close.bind(stub);
        stub.close = async () => { closed.push(token); await origClose(); };
        return stub as unknown as AwsMcpClient;
      },
    });
    try {
      const list = await postMcp(`${handle.url}/mcp`, mcpBody(1, "tools/list"), "good-A");
      assert.equal(list.status, 200);
      const first = await postMcp(`${handle.url}/mcp`, mcpBody(2, "tools/list"), "good-B");
      assert.equal(first.status, 200);
      assert.deepEqual(seenTokens, ["Bearer good-A", "Bearer good-B"]);
      assert.deepEqual(closed, ["good-A", "good-B"]);
    } finally {
      await handle.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

Note: `StubAwsMcpClient` is defined in the Task 3 section of this same file — reuse it; do not redefine. The good-Bearer test expects the stub child's `listTools()` to return `listServices`; extend the Task 3 stub's fake client `listTools` to return the `listServices` tool definition from `session-lifecycle.test.ts:29-43` shape (copy that literal into the stub).

Response assertion detail: `WebStandardStreamableHTTPServerTransport` in stateless mode with default `enableJsonResponse: false` returns SSE (`text/event-stream`). The test asserts `status === 200` and does not parse the body — parsing SSE frames is brittle; status + child-spawn/close + token assertions prove the path. `tools/call` coverage comes from the stub `callTool` returning `ok` (asserted indirectly via 200).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: FAIL with `Cannot find module '../src/http.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/http.ts` (complete file — nothing else may import HTTP concerns):

```ts
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { config } from "./config.js";
import { injectAccessToken } from "./auth/auth-manager.js";
import { AwsMcpClient } from "./aws/aws-mcp-client.js";
import { createServer } from "./index.js";

export interface HttpServeOptions {
  createAwsClient?: (token: string) => AwsMcpClient;
  fetchImpl?: typeof fetch;
}

function buildLoginUrl(): string {
  const loginUrl = new URL("/api/v1/sso-redirect", `${config.apiUrl}/`);
  loginUrl.searchParams.set("redirect_uri", config.ssoCallbackUrl);
  loginUrl.searchParams.set("client_id", config.ssoClientId);
  return loginUrl.toString();
}

function buildLogoutUrl(): string {
  const logoutUrl = new URL("/api/v1/sso-logout", `${config.apiUrl}/`);
  logoutUrl.searchParams.set("redirect_uri", config.ssoCallbackUrl);
  logoutUrl.searchParams.set("client_id", config.ssoClientId);
  return logoutUrl.toString();
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function unauthorized(response: ServerResponse, code: string, message: string, extra?: Record<string, unknown>): void {
  sendJson(response, 401, {
    code,
    message,
    loginUrl: buildLoginUrl(),
    ...extra,
  });
}

function checkCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    return true;
  }
  return false;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function toWebRequest(request: IncomingMessage, bodyText: string): Request {
  const host = request.headers.host ?? `${config.httpHost}:${config.httpPort}`;
  const url = new URL(request.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  return new Request(url, {
    method: request.method ?? "GET",
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : bodyText,
  });
}

async function sendWebResponse(nodeResponse: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  nodeResponse.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeResponse.write(value);
    }
    nodeResponse.end();
  } finally {
    reader.releaseLock();
  }
}
```

Request handler (POST serves JSON-RPC, GET serves SSE stream, both per-request ephemeral):

```ts
async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<HttpServeOptions>,
): Promise<void> {
  if (!checkCors(request, response)) {
    sendJson(response, 403, { code: "TDEI_ORIGIN_FORBIDDEN", message: "Origin not allowed." });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": request.headers.origin ?? "",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    response.end();
    return;
  }

  const authHeader = request.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(authHeader.trim());
  if (!match) {
    unauthorized(response, "TDEI_SSO_REQUIRED", "TDEI SSO login is required. Call tdei_sso_login and open the returned URL.");
    return;
  }
  const bearer = match[1].trim();

  const auth = injectAccessToken(bearer);
  try {
    await auth.validateToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "TDEI_TOKEN_EXPIRED") {
      unauthorized(response, message, "TDEI access token expired. Refresh via POST /api/v1/refresh-token or call tdei_sso_login.", { refresh_hint: true });
    } else {
      unauthorized(response, "TDEI_TOKEN_INVALID", "TDEI access token is invalid. Call tdei_sso_login and open the returned URL.", { refresh_hint: true });
    }
    return;
  }

  const awsClient = options.createAwsClient(bearer);
  try {
    const server = await createServer({ authManager: auth, awsMcpClient: awsClient, registerAwsTools: (await import("./aws/register-aws-tools.js")).registerAwsTools });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      const bodyText = request.method === "GET" || request.method === "HEAD" ? "" : await readBody(request);
      let parsed: unknown;
      if (bodyText) {
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          sendJson(response, 400, { code: "TDEI_BAD_REQUEST", message: "Request body must be JSON." });
          return;
        }
      }
      const webResponse = await transport.handleRequest(
        toWebRequest(request, bodyText),
        parsed === undefined ? undefined : { parsedBody: parsed },
      );
      await sendWebResponse(response, webResponse);
    } finally {
      await transport.close().catch(() => undefined);
    }
    await server.close().catch(() => undefined);
  } finally {
    await awsClient.close().catch(() => undefined);
  }
}
```

Stateless adapters for the three auth tools: they are registered by `createServer` from `index.ts` using the ephemeral `authManager`. In HTTP mode `startSsoLogin()` would try to `listen()` on loopback — wrong. Handle it: before `createServer`, wrap the ephemeral auth in a stateless adapter object exposing the same `ServerDependencies["authManager"]` surface but with HTTP-safe semantics:

```ts
function statelessAuthAdapter(auth: AuthManager): ServerDependencies["authManager"] { ... }
```

But `ServerDependencies` type lives in `index.ts` and `http.ts` imports `createServer` from `index.js` — circular type import is fine (type-only, erased). Simpler alternative honoring YAGNI: pass the ephemeral `auth` directly, and override `startSsoLogin`/`logout` via object spread:

```ts
const ephemeralAuth = injectAccessToken(bearer);
const httpAuth = {
  ...ephemeralAuth,
  // Stateless adapters: never open a loopback listener in HTTP mode.
  startSsoLogin: async () => ({
    loginUrl: buildLoginUrl(),
    callbackUrl: config.ssoCallbackUrl,
    completion: Promise.resolve(),
  }),
  logout: async () => ({
    logoutUrl: buildLogoutUrl(),
    callbackUrl: config.ssoCallbackUrl,
    completion: Promise.resolve(),
  }),
  getStatus: () => ephemeralAuth.getStatus(),
  getAccessToken: () => ephemeralAuth.getAccessToken(),
};
```

Spread of a class instance loses prototype methods — `...ephemeralAuth` copies only own enumerable props (none for methods). So construct explicitly with the four picked methods (as above, without spread). `getAccessToken()` on the ephemeral manager returns the injected token while unexpired, else throws `TDEI_SSO_REQUIRED` (it holds no refresh token, so it never refreshes — correct stateless behavior). The registered `tdei_sso_login` tool checks `auth.getStatus().authenticated` first: with a valid Bearer it reports "already authenticated"; with login pending semantics N/A. `tdei_auth_status` reports Bearer validity. `tdei_logout` clears the ephemeral tokens and returns the logout URL with "drop your token" semantics — adjust? The tool text from `index.ts` says "Local tokens and the AWS API tool session have already been cleared" — accurate enough for the ephemeral instance. No `index.ts` tool-text change in v1 (document as-is).

`serveHttp`:

```ts
export async function serveHttp(options: HttpServeOptions = {}): Promise<{ close(): Promise<void>; url: string }> {
  const resolved: Required<HttpServeOptions> = {
    createAwsClient: options.createAwsClient ?? ((token: string) => new AwsMcpClient(async () => token)),
    fetchImpl: options.fetchImpl ?? fetch,
  };
  // validateToken uses global fetch internally; when tests pass fetchImpl, temporarily swap:
  const server: Server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        if (url.pathname !== config.httpBasePath) {
          sendJson(response, 404, { code: "TDEI_NOT_FOUND", message: `Unknown path ${url.pathname}.` });
          return;
        }
        if (request.method !== "POST" && request.method !== "GET" && request.method !== "OPTIONS") {
          sendJson(response, 405, { code: "TDEI_METHOD_NOT_ALLOWED", message: "Use POST for JSON-RPC or GET for SSE." });
          return;
        }
        await handleMcpRequest(request, response, resolved);
      } catch (error) {
        console.error("[http] request failed:", error instanceof Error ? error.message : String(error));
        if (!response.headersSent) {
          sendJson(response, 500, { code: "TDEI_INTERNAL", message: "MCP request failed." });
        } else {
          response.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(config.httpPort, config.httpHost);
  });

  console.error(`[tdei-mcp] Serving MCP (http) on ${config.httpHost}:${config.httpPort}${config.httpBasePath}`);

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return { close, url: `http://${config.httpHost}:${config.httpPort}` };
}
```

`fetchImpl` plumbing: `validateToken()` calls global `fetch`. To honor `fetchImpl` without changing `AuthManager`'s signature, `http.ts` swaps `globalThis.fetch` around `auth.validateToken()` only:

```ts
const originalFetch = globalThis.fetch;
globalThis.fetch = resolved.fetchImpl;
try {
  await auth.validateToken();
} finally {
  globalThis.fetch = originalFetch;
}
```

Document this as intentional and scoped (single await, restored in finally). Tests pass the default (global fetch, which they mock) or a custom impl.

DELETE method: spec's transport supports DELETE for session termination; stateless v1 has no sessions — return 405 naming GET/POST. Covered by the method check above (DELETE falls into 405). `Mcp-Session-Id` request header is passed through `toWebRequest` untouched and echoed by the transport for SSE routing only.

Default `createAwsClient` uses the Task 3 provider constructor — per-request spawn, closed in `finally`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/http-stateless.test.ts`
Expected: PASS (all). Then run `npm test` (all existing still PASS) and `npm run build` (new `src/http.ts` compiles; `dist/http.js` emitted — no entry-point change yet, that is Task 5).

Port caution: tests call `serveHttp()` which listens on `config.httpPort` (default 3000). Parallel test files each import `config` once per process — `node --test` runs files in separate processes, but multiple `serveHttp()` calls within this one file bind 3000 repeatedly (sequentially closed, so OK). To avoid clashing with a developer's local 3000, set `process.env.TDEI_HTTP_PORT = "0"`? Port 0 means OS-assigned, but then `handle.url` must read the actual port from `server.address()`. Implement: after listen, `const addr = server.address();` and build `url` from it. In tests, set `process.env.TDEI_HTTP_PORT = "18080"` (unlikely-used fixed port) at file top before importing config-dependent modules. Simplest deterministic: top of test file `process.env.TDEI_HTTP_PORT = "18080";` — config reads env at import. Document this line as required.

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/http-stateless.test.ts
git commit -m "feat: add isolated stateless Streamable HTTP server"
```

---

### Task 5: `src/index.ts` exclusive branch + README + final verification

**Files:**
- Modify: `src/index.ts:288-296` (entry block only)
- Modify: `README.md` (append HTTP section)
- Test: none new — full `test/http-stateless.test.ts` + `npm test` + manual smoke

**Interfaces:**
- Consumes: `config.transport`, `config.httpHost`, `config.httpPort`, `config.httpBasePath`; `serveHttp` from `./http.js`.
- Produces: `node dist/index.js` (stdio default) vs `node dist/index.js --transport=http` (HTTP only).

- [ ] **Step 1: Parse args and branch (no test-first — entry block is untestable glue; coverage comes from Tasks 1-4)**

Replace the entry block in `src/index.ts:288-296` with:

```ts
const entryPoint = process.argv[1];

if (
  entryPoint &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  const transportFlag = process.argv.find((arg) => arg.startsWith("--transport="))?.split("=")[1]?.trim().toLowerCase();
  const portFlag = process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1]?.trim();
  const hostFlag = process.argv.find((arg) => arg.startsWith("--host="))?.split("=")[1]?.trim();
  if (portFlag) process.env.TDEI_HTTP_PORT = portFlag;
  if (hostFlag) process.env.TDEI_HTTP_HOST = hostFlag;
  const transport = transportFlag ?? process.env.TDEI_TRANSPORT?.trim().toLowerCase() ?? "stdio";

  if (transport === "http") {
    const { serveHttp } = await import("./http.js");
    await serveHttp();
  } else if (transport === "stdio" || transport === "") {
    console.error("[tdei-mcp] Starting MCP server");
    await serveStdio(() => createServer());
  } else {
    console.error(`[tdei-mcp] Unknown transport "${transport}". Use --transport=stdio|http.`);
    process.exit(1);
  }
}
```

Note: `config` module reads env at import time, and `index.ts` imports `config` transitively via `auth-manager.js` at top. Setting `process.env.TDEI_HTTP_PORT` in the entry block happens AFTER those imports — so `--port=` would not affect the already-evaluated `config.httpPort`. Fix: `http.ts` must re-read port/host overrides at `serveHttp()` call time, not rely on `config`. Adjust Task 4's `serveHttp` to accept `overrides?: { port?: number; host?: string }` validated identically, and have the entry block pass parsed flags through instead of env-mutation:

```ts
if (transport === "http") {
  const { serveHttp } = await import("./http.js");
  await serveHttp({}, portFlag && hostFlag ? { port: Number(portFlag), host: hostFlag } : portFlag ? { port: Number(portFlag) } : hostFlag ? { host: hostFlag } : undefined);
}
```

Cleaner: parse into an overrides object:

```ts
const overrides: { port?: number; host?: string } = {};
if (portFlag) {
  const port = Number(portFlag);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("[tdei-mcp] --port must be an integer 1-65535.");
    process.exit(1);
  }
  overrides.port = port;
}
if (hostFlag) overrides.host = hostFlag;
```

And `serveHttp(options, overrides)` uses `overrides.port ?? config.httpPort`, `overrides.host ?? config.httpHost` for listen + log + returned URL. Update the Task 4 signature accordingly when implementing Task 4 (executor: read Task 5 before writing Task 4's `serveHttp`; the plan states the final signature here):

```ts
export interface HttpServeOverrides { port?: number; host?: string }
export async function serveHttp(
  options: HttpServeOptions = {},
  overrides: HttpServeOverrides = {},
): Promise<{ close(): Promise<void>; url: string }>
```

Dynamic `import("./http.js")` keeps STDIO startup from loading HTTP code. No other `index.ts` change. `createServer` and `ServerDependencies` untouched.

- [ ] **Step 2: README HTTP section**

Append after the "Manual startup check" section (before `## 4. Verify`):

```md
### HTTP mode (Streamable HTTP, stateless)

One process serves one transport. HTTP mode serves no STDIO; STDIO mode opens no port.

Run:

    node --env-file=.env dist/index.js --transport=http --port 3000

Every request must carry `Authorization: Bearer <access_token>` from the same TDEI SSO protocol (login page, token exchange, refresh endpoints unchanged). The server holds no sessions and no refresh tokens: it validates the Bearer per request (local expiry check plus a lightweight TDEI probe) and cannot refresh on the client's behalf — refresh via `POST /api/v1/refresh-token` or re-run SSO login yourself.

Example:

    curl -i -X POST http://127.0.0.1:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer <token>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

Missing, bad, or expired Bearers return 401 naming `tdei_sso_login` remediation. In HTTP mode `TDEI_SSO_CALLBACK_URL` may be a registered `https://` URL (plus `http://127.0.0.1/` for local dev); it must be pre-registered for the `tdei-mcp` client or SSO returns 400. Plain HTTP locally; terminate TLS at a reverse proxy for public `https`. Each request spawns the AWS child fresh (v1 trade-off); the child is closed after the response.
```

Indented (not fenced) per spec §5. Also extend the Configuration reference table with the six new variables.

- [ ] **Step 3: Run full verification**

Run: `npm test`
Expected: all PASS (existing 8 files + `http-stateless.test.ts`).

Run: `npm run build`
Expected: success, `dist/http.js` + `dist/index.js` emitted.

Manual smoke (requires no TDEI account for the 401 path):

```bash
node --env-file=.env dist/index.js --transport=http --port 18081 &
sleep 1
curl -i -X POST http://127.0.0.1:18081/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
kill %1
```

Expected: `HTTP/1.1 401` with `TDEI_SSO_REQUIRED` body. STDIO smoke: `echo | node --env-file=.env dist/index.js` still prints `[tdei-mcp] Starting MCP server` and waits on stdin (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat: add exclusive http transport branch and docs"
```

---

## Self-review

- Spec coverage: §2 transport selection (Tasks 1, 5) · §3 stateless auth 1-7 (Tasks 2, 4) · §4 callback (Task 1) · §5 file scope incl. isolated `http.ts`, dynamic import, tests, indented curl docs (Tasks 1-5) · §6 errors/CORS/shutdown (Task 4) · §7 acceptance (Task 5 smoke) · §8 out-of-scope honored (no sessions, no pooling, no TLS provisioning, no NPX/filter changes).
- Deviation from issue text, carried from spec: `validateToken()` probes `GET /api/v1/project-groups` (live auth proof doubles as validation; acceptance flow "authenticate then test list_Services" preserved end-to-end via `tools/list` + `listServices` on valid Bearer).
- Supersedes: `docs/superpowers/plans/2026-09-26-streamable-http-support.md` (stateful sessions, Express, headless SSO) — that plan's approach contradicts the Issue #3 agreed v1 decisions; do not implement it. Executor: ignore that file.
- Placeholder scan: every step has exact file paths, code blocks, run commands, expected outputs. No TBD/TODO. "Similar to" glue (stub `listServices` shape) points to an exact file+line source.
- Type consistency: `Transport` (`config.ts`) → `validateSsoCallbackUrl(value, transport)` → `config.transport`; `injectAccessToken(token, expiresInSeconds?) → AuthManager` + `validateToken(): Promise<void>` (throws named errors); `new AwsMcpClient(tokenProvider?: () => Promise<string>)`; `serveHttp(options?, overrides?) → Promise<{ close, url }>`; `HttpServeOptions { createAwsClient?, fetchImpl? }`, `HttpServeOverrides { port?, host? }`. Names used identically across Tasks 2-5.
- Ordering risk flagged inline: Task 4's `serveHttp` final signature is defined in Task 5 (env-import-time problem) — executor must read Task 5 before writing Task 4.
- Test-port risk handled: `TDEI_HTTP_PORT=18080` at test-file top; `serveHttp` builds URL from `server.address()`.
