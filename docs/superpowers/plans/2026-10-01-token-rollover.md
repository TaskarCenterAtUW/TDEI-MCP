# Token-Rollover Reload (Issue #4 Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AwsToolsLifecycle` detect SSO token rollover and restart the AWS child exactly once, with every forwarded tool call routed through the version check.

**Architecture:** `AwsToolsLifecycle` (`src/aws/aws-tools-lifecycle.ts`) gains `state` + `lastTokenVersion` and a public `callTool()` that runs `ensureFresh()` inside the existing `serialize()` queue before forwarding. The two direct-`awsSession.callTool` call sites are rewired to it.

**Tech Stack:** TypeScript ES2022 NodeNext ESM, `node:test` + `tsx`, `InMemoryTransport` from `@modelcontextprotocol/client` for tests.

**Spec:** `docs/superpowers/specs/2026-10-01-token-rollover-design.md`

## Global Constraints

- Node.js >=22 (package.json engines).
- TypeScript strict, ESM (`module: NodeNext`, `moduleResolution: NodeNext`), `rootDir ./src`, `outDir dist`.
- Never write MCP payloads to stdout; diagnostics go to stderr.
- Keep hiding connector-managed auth tools: `authenticate, refreshToken, ssoRedirect, ssoLogin, ssoLogout` (`src/aws/register-aws-tools.ts:64-70`).
- HTTP path (`src/http.ts`) unchanged — single-Bearer ephemeral stacks cannot roll over mid-request.
- Keep green: full test run via `node --import tsx --test test/*.test.ts` (npm is unavailable in this environment; the package.json `test` script resolves to the same command) and `./node_modules/.bin/tsc --noEmit`.
- Test runner for single files: `node --import tsx --test test/<file>.test.ts`.

---

## File map (what changes and why)

- Modify: `src/aws/aws-tools-lifecycle.ts` — `state` + `lastTokenVersion`, `ensureFresh()`, public `callTool()`, `AuthSession` widens with `getTokenVersion`, `logout()` resets version state.
- Modify: `src/aws/register-aws-tools.ts` — tool-handler closures forward via the lifecycle instead of the raw client.
- Test: `test/token-rollover.test.ts` — rollover restart, single-restart-under-concurrency, logout reset.

---

### Task 1: Lifecycle owns rollover — state, ensureFresh, callTool

**Files:**
- Modify: `src/aws/aws-tools-lifecycle.ts:16-23,79-106,183-192`
- Test: `test/token-rollover.test.ts`

**Interfaces:**
- Consumes: `AuthManager.getTokenVersion(): number` (`src/auth/auth-manager.ts:36`), existing `AwsMcpClient.close/listTools/callTool`, `registerAwsTools`, `serialize()`.
- Produces: `AwsToolsLifecycle.callTool(tool: string, input: Record<string, unknown>): Promise<unknown>`, `AwsToolsLifecycle.isLoaded(): boolean` (unchanged semantics: `state === "loaded"`).

- [ ] **Step 1: Write the failing test**

```ts
// test/token-rollover.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";

import { AwsToolsLifecycle } from "../src/aws/aws-tools-lifecycle.js";
import { registerAwsTools } from "../src/aws/register-aws-tools.js";
import { createServer } from "../src/server.js";

function listServicesTool() {
  return {
    name: "listServices",
    description: "List TDEI services.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  };
}

function makeAuth() {
  let tokenVersion = 1;
  return {
    getTokenVersion: () => tokenVersion,
    bumpVersion: () => { tokenVersion += 1; },
    async logout() {
      return {
        logoutUrl: "https://api-dev.tdei.us/api/v1/sso-logout?test=1",
        callbackUrl: "http://127.0.0.1:8765/callback",
        completion: Promise.resolve(),
      };
    },
  };
}

function makeAws() {
  let starts = 0;
  let closes = 0;
  return {
    get starts() { return starts; },
    get closes() { return closes; },
    async listTools() { return { tools: [listServicesTool()] }; },
    async callTool(name: string, _args: Record<string, unknown>) {
      assert.equal(name, "listServices");
      return { content: [{ type: "text" as const, text: "services" }] };
    },
    async close() { closes += 1; },
    __countStart() { starts += 1; },
  };
}

test("token rollover triggers exactly one child restart", async () => {
  const auth = makeAuth();
  const aws = makeAws();
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    awsMcpClient: aws,
    registerAwsTools,
  });
  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools);
  await lifecycle.load();
  await lifecycle.callTool("listServices", {});
  assert.equal(aws.closes, 0);
  auth.bumpVersion();
  await lifecycle.callTool("listServices", {});
  assert.equal(aws.closes, 1);
  await lifecycle.callTool("listServices", {});
  assert.equal(aws.closes, 1);
});
```

Note: `makeAws` counts `close()` calls as the restart signal (each reload closes before re-registering). `__countStart` is vestigial — do not include it; count closes only. The `authManager` stub in `createServer` needs `getTokenVersion` because `AwsToolsLifecycle`'s `AuthSession` type widens — but `createServer`'s own `ServerDependencies["authManager"]` pick-type does NOT include `getTokenVersion`, so the stub above (with the extra method) still satisfies it structurally. The `lifecycle` is constructed directly with the `auth` object (which has only `getTokenVersion` + `logout`, satisfying the widened `AuthSession`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/token-rollover.test.ts`
Expected: FAIL with `lifecycle.callTool is not a function` (TypeError).

- [ ] **Step 3: Write minimal implementation**

In `src/aws/aws-tools-lifecycle.ts`, apply these exact changes:

```ts
type AuthSession = Pick<AuthManager, "logout" | "getTokenVersion">;
```

Replace the `loaded` field:

```ts
export class AwsToolsLifecycle {
  private state: "unloaded" | "loading" | "loaded" | "reloading" = "unloaded";
  private lastTokenVersion?: number;
  private operationQueue: Promise<void> =
    Promise.resolve();
```

Replace `load()`:

```ts
  load(): Promise<"loaded" | "already-loaded"> {
    return this.serialize(async () => {
      const current = this.authSession.getTokenVersion();
      if (this.state === "loaded" && this.lastTokenVersion === current) {
        return "already-loaded";
      }
      await this.ensureFreshLocked(current);
      return "loaded";
    });
  }
```

Add after `reload()`:

```ts
  callTool(tool: string, input: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      await this.ensureFreshLocked(this.authSession.getTokenVersion());
      return this.awsSession.callTool(tool, input);
    });
  }

  private async ensureFreshLocked(currentVersion: number): Promise<void> {
    if (this.state === "loaded" && this.lastTokenVersion === currentVersion) {
      return;
    }
    const firstLoad = this.lastTokenVersion === undefined;
    this.state = firstLoad ? "loading" : "reloading";
    if (!firstLoad) {
      console.error("[aws-mcp] token changed; restarting AWS MCP server");
      await this.awsSession.close();
    }
    await this.discoverAndRegister();
    this.lastTokenVersion = currentVersion;
    this.state = "loaded";
  }
```

Update `reload()` body to route through the same gate (keep its `"reloaded"` return):

```ts
  reload(): Promise<"reloaded"> {
    return this.serialize<"reloaded">(async () => {
      this.lastTokenVersion = undefined;
      await this.ensureFreshLocked(this.authSession.getTokenVersion());
      return "reloaded";
    });
  }
```

Update `logout()` finally block:

```ts
      } finally {
        await this.awsSession.close();
        this.lastTokenVersion = undefined;
        this.state = "unloaded";
      }
```

Update `isLoaded()`:

```ts
  isLoaded(): boolean {
    return this.state === "loaded";
  }
```

The private `callTool` closure inside `discoverAndRegister` (`const callTool = (tool, input) => this.awsSession.callTool(tool, input)`) stays as-is — it forwards workflow steps to the already-fresh child within a load/reload operation.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/token-rollover.test.ts`
Expected: PASS. Then run the full suite `node --import tsx --test test/*.test.ts` — `session-lifecycle.test.ts` must still PASS. Note: its auth stubs lack `getTokenVersion`, but they never construct `AwsToolsLifecycle` directly with those stubs... actually `createServer` constructs the lifecycle with `dependencies.authManager` — the widened `AuthSession` pick-type requires `getTokenVersion` on whatever is passed. The existing stubs in `session-lifecycle.test.ts:56-86` do NOT have `getTokenVersion`, so TypeScript will fail to compile that test file. Fix by adding `getTokenVersion: () => 1` to both auth stubs in `session-lifecycle.test.ts` (lines ~57 and ~135). That is part of this step, not a separate task.

- [ ] **Step 5: Commit**

```bash
git add src/aws/aws-tools-lifecycle.ts test/session-lifecycle.test.ts test/token-rollover.test.ts
git commit -m "feat: lifecycle-owned token-rollover reload with routed callTool"
```

---

### Task 2: Rewire tool closures to lifecycle.callTool + concurrency test

**Files:**
- Modify: `src/aws/register-aws-tools.ts:72-76,124-140`
- Test: extend `test/token-rollover.test.ts` (concurrency + logout-reset cases)

**Interfaces:**
- Consumes: `AwsToolsLifecycle.callTool` from Task 1.
- Produces: registrar closures that cannot bypass the version gate.

- [ ] **Step 1: Write the failing tests**

Append to `test/token-rollover.test.ts` (reuse `makeAuth`, `makeAws`, `listServicesTool` from Task 1 — do not redefine):

```ts
test("concurrent calls during refresh issue one restart only", async () => {
  const auth = makeAuth();
  const aws = makeAws();
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    awsMcpClient: aws,
    registerAwsTools,
  });
  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools);
  await lifecycle.load();
  auth.bumpVersion();
  await Promise.all([
    lifecycle.callTool("listServices", {}),
    lifecycle.callTool("listServices", {}),
    lifecycle.callTool("listServices", {}),
  ]);
  assert.equal(aws.closes, 1);
});

test("logout resets version so next load starts fresh", async () => {
  const auth = makeAuth();
  const aws = makeAws();
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { return "test-token"; },
      getStatus: () => ({ configured: true, authenticated: true, state: "authenticated" as const, loginMethod: "sso" as const }),
      logout: auth.logout,
      getTokenVersion: auth.getTokenVersion,
    },
    awsMcpClient: aws,
    registerAwsTools,
  });
  const lifecycle = new AwsToolsLifecycle(server, auth, aws, registerAwsTools);
  await lifecycle.load();
  await lifecycle.logout();
  auth.bumpVersion();
  await lifecycle.load();
  assert.equal(aws.closes, 1);
});
```

The concurrency test passes trivially today (no version check exists anywhere in the call path — closes stays 0, not 1). It fails as specified. The logout test: `logout()` closes once (closes=1 from logout itself), then load-after-bump... without the reset, `lastTokenVersion` is still 1 vs current 2 → reload → closes=2. Hmm — that PASSES the assertion for the wrong reason. Fix the assertion: after `logout()`, closes is 1 (logout's own close). After bump + load, a correct implementation closes... wait: logout resets `lastTokenVersion = undefined`, so next load is a first-load (no close, silent) → closes stays 1. Without the reset, load sees version mismatch → close + reload → closes becomes 2. So `assert.equal(aws.closes, 1)` FAILS before the fix (actual 2) and PASSES after. Correct as written — the comment in the code block should note this. Add above the logout test:

```ts
// Without the logout reset, load-after-bump would see a version mismatch and
// close+reload (closes=2). With the reset, post-logout load is a silent first
// load (closes stays 1 — logout's own close).
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/token-rollover.test.ts`
Expected: FAIL — concurrency test gets `closes === 0` (expected 1); logout test gets `closes === 2` (expected 1).

- [ ] **Step 3: Write minimal implementation**

In `src/aws/register-aws-tools.ts`, the registrar currently takes `client: AwsToolClient` and closures call `client.callTool(...)`. Change the call sites to route through the lifecycle:

The registrar signature is `registerAwsTools(server, client, filter)`. The lifecycle's `discoverAndRegister` builds `discoveryClient` (list-once stub + live `callTool`) and passes it. Minimal change honoring the spec ("registrar signature takes the lifecycle or a bound callTool"): add an optional fourth parameter `onCall?: (tool: string, input: Record<string, unknown>) => Promise<unknown>` used by the tool closures when provided:

```ts
export async function registerAwsTools(
  server: McpServer,
  client: AwsToolClient = awsMcpClient,
  filter: EndpointFilter = { mode: "all", allow: [], deny: [] },
  onCall?: (tool: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<AwsToolRegistrationResult> {
```

In the tool-registration closure (`:124-140`):

```ts
      async (args) => {
        try {
          return await (onCall
            ? onCall(awsTool.name, args)
            : client.callTool(awsTool.name, args));
        } catch (error) {
          return errorResult(error);
        }
      },
```

In `src/aws/aws-tools-lifecycle.ts` `discoverAndRegister`, pass the bound lifecycle call:

```ts
    const reg = await this.registrar(
      this.server,
      discoveryClient,
      effectiveFilter,
      (tool, input) => this.callTool(tool, input),
    );
```

Deadlock check: `discoverAndRegister` runs INSIDE `serialize()` (via load/reload/ensureFreshLocked). The bound `(tool, input) => this.callTool(tool, input)` calls `this.serialize(...)` again — `serialize` chains onto `operationQueue`, which is currently blocked waiting for the outer operation that invoked the closure... but closures only fire later, when an MCP client calls the tool — strictly after `load()` resolves and the queue drains. At call time the queue is idle, so no self-deadlock. The workflow `callTool` built in `discoverAndRegister` (`(tool, input) => this.awsSession.callTool(tool, input)`) is invoked by `registerWorkflows` handlers, also post-load — but THOSE bypass the gate. Rewire it too:

```ts
    const callTool = (tool: string, input: Record<string, unknown>) =>
      this.callTool(tool, input);
```

Same post-load timing argument applies — safe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/token-rollover.test.ts`
Expected: PASS (3 tests). Then full suite `node --import tsx --test test/*.test.ts` — all PASS. Then `./node_modules/.bin/tsc --noEmit` — clean (the `onCall` param is optional; existing `registerAwsTools` callers unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/aws/register-aws-tools.ts src/aws/aws-tools-lifecycle.ts test/token-rollover.test.ts
git commit -m "feat: route tool calls through lifecycle version gate"
```

---

## Self-review

- Spec coverage: §3 lifecycle changes (Task 1: state, ensureFresh, callTool, AuthSession widening, logout reset) · registrar rewire incl. workflow callTool (Task 2) · `test/token-rollover.test.ts` with restart + concurrency cases (Tasks 1-2) · §4 acceptance (exactly-one-restart asserted via close counts; next-call-succeeds asserted by callTool resolving) · HTTP exclusion honored (no `src/http.ts` change).
- Placeholder scan: every step has exact files, code blocks, run commands, expected outputs. The `__countStart` vestige is explicitly called out as excluded. The logout-test inverted assertion is explained inline.
- Type consistency: `callTool(tool: string, input: Record<string, unknown>): Promise<unknown>` in Task 1, reused identically in Task 2's `onCall` param and workflow `callTool`. `AuthSession = Pick<AuthManager, "logout" | "getTokenVersion">`. `state` union `"unloaded" | "loading" | "loaded" | "reloading"` used identically. `load()` keeps `"loaded" | "already-loaded"`, `reload()` keeps `"reloaded"`.
- Risk noted inline: `session-lifecycle.test.ts` stub fix (missing `getTokenVersion`) is assigned to Task 1 Step 4, not left dangling.
- Deadlock risk analyzed inline: bound `callTool` closures fire post-load when the queue is idle.
