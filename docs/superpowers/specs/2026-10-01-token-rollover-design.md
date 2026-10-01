# Issue #4 Part A Design — token-rollover reload (lifecycle-owned)

Date: 2026-10-01. Source: TaskarCenterAtUW/TDEI-MCP#4 (Part A).
Status: approved for implementation. Parts B (health + errors) and C (CI +
lazy config) are separate specs; this file covers Part A only.

## 1. Problem

`src/aws/aws-mcp-client.ts:28` tracks `connectedTokenVersion` and
`connectAuthenticated()` restarts the child when the SSO token changes
(`:27-46`). But `src/aws/aws-tools-lifecycle.ts:27 load()` short-circuits on
`loaded=true` and never re-checks the version, so a refreshed SSO token keeps
serving through the old Bearer until process restart. Additionally, tool-call
closures (`src/aws/register-aws-tools.ts:130-140`) call
`awsSession.callTool` directly, bypassing any lifecycle check.

## 2. Agreed decisions (user-confirmed)

- **Owner:** `AwsToolsLifecycle` only. Rejected: background poll watcher
  (timer races, wakeups with zero traffic); client-owned reload (splits
  ownership, discovery-mode version semantics murky).
- **Check point:** new `AwsToolsLifecycle.callTool()` routes every forwarded
  call through `ensureFresh()`; the two closure sites are rewired to it.
  Rejected: per-closure `ensureFresh()` calls (every future site must remember);
  load-time-only checks (refresh between load and call still serves stale).
- **HTTP path:** unchanged. `src/http.ts` builds a single-Bearer ephemeral
  stack per request, so rollover cannot occur mid-request.

## 3. Changes

- `src/aws/aws-tools-lifecycle.ts`:
  - Replace `loaded: boolean` with
    `state: "unloaded" | "loading" | "loaded" | "reloading"` plus
    `lastTokenVersion: number | undefined`.
  - `AuthSession` pick-type widens from `"logout"` to
    `"logout" | "getTokenVersion"` (method exists,
    `src/auth/auth-manager.ts:36`).
  - Private `ensureFresh()` (always called inside the existing `serialize()`
    queue): compare `authSession.getTokenVersion()` against
    `lastTokenVersion`. On mismatch (or first load): set
    `state = "loading" | "reloading"`, `awsSession.close()`,
    `discoverAndRegister()`, record `lastTokenVersion`, set
    `state = "loaded"`. Log the existing `token changed; restarting AWS MCP
    server` message on the reload path only; first load keeps current
    (silent) behavior.
  - New public `callTool(tool, input)`: `serialize()` → `ensureFresh()` →
    forward to `awsSession.callTool`. Single per-call check point.
  - `load()` / `reload()` keep their signatures and return values; both route
    through `ensureFresh()`. `logout()` additionally resets
    `lastTokenVersion = undefined` and `state = "unloaded"`.
  - Concurrency: the existing `serialize()` queue means concurrent calls
    during a refresh collapse to exactly one restart — no new locking.
- `src/aws/register-aws-tools.ts`: tool-handler closures and the workflow
  `callTool` built in `discoverAndRegister` route via
  `lifecycle.callTool` instead of raw `awsSession.callTool`. Registrar
  signature takes the lifecycle (or a bound `callTool`); raw client no
  longer escapes to call sites.
- Tests: new `test/token-rollover.test.ts` following the
  `InMemoryTransport` pattern in `test/session-lifecycle.test.ts`:
  login → call → bump `tokenVersion` → call again asserts exactly one child
  restart and success; concurrent calls during a refresh assert one restart
  only.

## 4. Acceptance criteria (from issue, Part A)

- SSO refresh mid-session triggers exactly one AWS child restart; next
  `listServices` succeeds without client reconnect or restart.
- `npm test` and `npm run build` green. No change to STDIO/HTTP transport
  selection, `tdei.config.json` schema, or behavior when no rollover occurs.

## 5. Out of scope

- Parts B and C of Issue #4 (separate specs).
- Refresh-token vaulting for stateless HTTP (documented v2).
- No NPX UX, filtering, workflow, or transport changes (Issues 1-3).

## 6. References

- `src/aws/aws-tools-lifecycle.ts:15-68` (current `loaded` flag, `serialize`)
- `src/aws/aws-mcp-client.ts:23-46,90-104` (version tracking, restart log)
- `src/auth/auth-manager.ts:36-55` (`getTokenVersion`, `getStatus`)
- `src/aws/register-aws-tools.ts:82-140` (registrar, call closures)
- `test/session-lifecycle.test.ts:18-130` (test pattern to follow)
