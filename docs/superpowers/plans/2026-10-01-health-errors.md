# Health + Structured Errors (Issue #4 Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tdei_health` tool, a structured error vocabulary (`TdeiMcpError` + `formatError()`), JSON logging support, and a 256KB output cap — deleting the dead `tdei-client.ts`.

**Architecture:** New `src/mcp/errors.ts` (codes + `inferCode()` absorbing the dead client's status table + `formatError()` emitting JSON-in-text) wired into the two error surfaces (AWS tool closures, workflow runner abort); new `tdei_health` tool in `src/server.ts` with lightweight injectable probes; new `src/mcp/log.ts` adopted in new code only.

**Tech Stack:** TypeScript ES2022 NodeNext ESM, `node:test` + `tsx`, `InMemoryTransport` from `@modelcontextprotocol/client` for tests.

**Spec:** `docs/superpowers/specs/2026-10-01-health-errors-design.md`

## Global Constraints

- Node.js >=22 (package.json engines).
- TypeScript strict, ESM (`module: NodeNext`, `moduleResolution: NodeNext`), `rootDir ./src`, `outDir dist`.
- Never write MCP payloads to stdout; diagnostics go to stderr.
- Error shape: `{isError: true, content: [{type: "text", text: "<JSON {code,message,hint,retryable[,stepRef]}>"}]}` — no `structuredContent`.
- `tdei_health` is read-only, works signed-out, never emits tokens.
- `LOG_LEVEL=pretty|json`, default `pretty` (byte-identical to today's `console.error`).
- Truncation cap 262144 bytes (UTF-8).
- Keep green: full suite via `node --import tsx --test test/*.test.ts` (npm unavailable here) and `./node_modules/.bin/tsc --noEmit`.
- Single-file runs: `node --import tsx --test test/<file>.test.ts`.

---

## File map (what changes and why)

- Create: `src/mcp/errors.ts` — codes, `TdeiMcpError`, `inferCode()`, `formatError()`, truncation helper.
- Delete: `src/api/tdei-client.ts` — dead code (verified: no file imports `tdeiRequest` or `TdeiApiError`; confirm with grep before deleting).
- Modify: `src/aws/register-aws-tools.ts` — closure catch `errorResult` → `formatError` + truncation.
- Modify: `src/workflows/runner.ts` — step-abort error carries `code + stepRef`.
- Create: `src/mcp/log.ts` — `LOG_LEVEL`-gated pretty/JSON logger with token hashing.
- Modify: `src/server.ts` — new `tdei_health` tool (probes injectable for tests).
- Modify: `src/http.ts` — 401 body gains `retryable`.
- Test: `test/health-errors.test.ts`.
- Modify: `README.md` — Troubleshooting rows + `tdei_health` example (indented block).

---

### Task 1: errors.ts + tdei-client.ts deletion + wiring

**Files:**
- Create: `src/mcp/errors.ts`
- Delete: `src/api/tdei-client.ts`
- Modify: `src/aws/register-aws-tools.ts:124-140` (closure catch)
- Modify: `src/workflows/runner.ts:97-122` (abort path)
- Test: `test/health-errors.test.ts` (error half)

**Interfaces:**
- Consumes: nothing new. `inferCode()` absorbs the status table from `src/api/tdei-client.ts:81-117` (delete only after folding it in).
- Produces: `TdeiErrorCode` (union), `TdeiMcpError {code, message, hint, retryable, stepRef?}`, `formatError(err: unknown): {isError: true, content: [{type: "text", text: string}]}`, `truncateText(text: string): {text: string, truncated: boolean}`, `MAX_OUTPUT_BYTES = 262144`.

- [ ] **Step 1: Write the failing test**

```ts
// test/health-errors.test.ts (part 1: errors)
import { strict as assert } from "node:assert";
import test from "node:test";

import { formatError, truncateText, MAX_OUTPUT_BYTES } from "../src/mcp/errors.js";

test("formatError maps SSO-required to coded JSON", () => {
  const result = formatError(new Error("TDEI_SSO_REQUIRED"));
  assert.equal(result.isError, true);
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_SSO_REQUIRED");
  assert.match(body.hint, /tdei_sso_login/);
  assert.equal(body.retryable, false);
});

test("formatError surfaces backend permission on 403", () => {
  const result = formatError({ status: 403, body: { message: "requires project-group admin" } });
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_FORBIDDEN");
  assert.match(body.message, /project-group admin/);
  assert.equal(body.retryable, false);
});

test("formatError maps 5xx to retryable upstream error", () => {
  const result = formatError({ status: 503, body: "unavailable" });
  const body = JSON.parse(String(result.content[0].text));
  assert.equal(body.code, "TDEI_UPSTREAM_5XX");
  assert.equal(body.retryable, true);
});

test("truncateText caps at 256KB with flag", () => {
  const big = "x".repeat(MAX_OUTPUT_BYTES + 100);
  const { text, truncated } = truncateText(big);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES + 500);
  assert.match(text, /"truncated":true/);
  const small = truncateText("hello");
  assert.equal(small.truncated, false);
  assert.equal(small.text, "hello");
});

test("tdei-client.ts is gone", async () => {
  const { execSync } = await import("node:child_process");
  const hits = execSync("grep -rn 'tdeiRequest\\|TdeiApiError' src test scripts --include='*.ts' || true", { encoding: "utf-8" }).trim();
  assert.equal(hits, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/health-errors.test.ts`
Expected: FAIL with `Cannot find module '../src/mcp/errors.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/errors.ts` (complete file):

```ts
export const MAX_OUTPUT_BYTES = 262144;

const TRUNCATION_HINT = "Output exceeded 256KB; refine filters or call a narrower operation.";

export type TdeiErrorCode =
  | "TDEI_SSO_REQUIRED"
  | "TDEI_TOKEN_EXPIRED"
  | "TDEI_TOKEN_INVALID"
  | "TDEI_FORBIDDEN"
  | "TDEI_NOT_FOUND"
  | "TDEI_CONFLICT"
  | "TDEI_UPSTREAM_5XX"
  | "TDEI_CONFIG_INVALID"
  | "TDEI_TOOL_DISABLED"
  | "TDEI_CHILD_UNAVAILABLE";

export interface TdeiErrorStepRef {
  workflow: string;
  stepId: string;
  stepIndex: number;
  tool: string;
}

export interface TdeiMcpError {
  code: TdeiErrorCode;
  message: string;
  hint: string;
  retryable: boolean;
  stepRef?: TdeiErrorStepRef;
}

interface BackendShaped {
  status?: number;
  body?: unknown;
}

function extractBackendMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body ? body : undefined;
  }
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}

// Status table folded in from src/api/tdei-client.ts getErrorMessage()
// (deleted: nothing imported tdeiRequest).
export function inferCode(err: unknown): { code: TdeiErrorCode; message: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const status = typeof err === "object" && err !== null && typeof (err as BackendShaped).status === "number"
    ? (err as BackendShaped).status as number
    : undefined;
  const backendMessage = typeof err === "object" && err !== null
    ? extractBackendMessage((err as BackendShaped).body)
    : undefined;

  if (/TDEI_SSO_REQUIRED/.test(message)) {
    return { code: "TDEI_SSO_REQUIRED", message: "TDEI SSO login is required. Call tdei_sso_login and open the returned URL.", retryable: false };
  }
  if (/TDEI_TOKEN_EXPIRED/.test(message)) {
    return { code: "TDEI_TOKEN_EXPIRED", message: "TDEI access token expired. Refresh via POST /api/v1/refresh-token or call tdei_sso_login.", retryable: true };
  }
  if (/TDEI_TOKEN_INVALID/.test(message)) {
    return { code: "TDEI_TOKEN_INVALID", message: "TDEI access token is invalid. Call tdei_sso_login and open the returned URL.", retryable: false };
  }
  if (status === 403 || /forbidden|permission/i.test(message)) {
    return {
      code: "TDEI_FORBIDDEN",
      message: backendMessage ? `You do not have permission: ${backendMessage}` : "You do not have permission to perform this TDEI operation.",
      retryable: false,
    };
  }
  if (status === 404) {
    return { code: "TDEI_NOT_FOUND", message: "The requested TDEI resource was not found.", retryable: false };
  }
  if (status === 409) {
    return { code: "TDEI_CONFLICT", message: backendMessage ? `TDEI request conflict: ${backendMessage}` : "The TDEI request conflicts with the current resource state.", retryable: false };
  }
  if ((status !== undefined && status >= 500) || /child|spawn|ENOENT|ECONNRESET/i.test(message)) {
    return { code: status !== undefined && status >= 500 ? "TDEI_UPSTREAM_5XX" : "TDEI_CHILD_UNAVAILABLE", message: status !== undefined && status >= 500 ? "The TDEI service returned a server error." : "The AWS tool child is unavailable.", retryable: true };
  }
  if (/disabled by config/.test(message)) {
    return { code: "TDEI_TOOL_DISABLED", message, retryable: false };
  }
  if (status === 400) {
    return { code: "TDEI_CONFIG_INVALID", message: backendMessage ? `TDEI request was invalid: ${backendMessage}` : "TDEI request was invalid.", retryable: false };
  }
  return { code: "TDEI_UPSTREAM_5XX", message: message || "Unexpected TDEI error.", retryable: false };
}

const HINTS: Record<TdeiErrorCode, string> = {
  TDEI_SSO_REQUIRED: "Call tdei_sso_login and open the returned URL.",
  TDEI_TOKEN_EXPIRED: "Refresh via POST /api/v1/refresh-token or call tdei_sso_login.",
  TDEI_TOKEN_INVALID: "Call tdei_sso_login and open the returned URL.",
  TDEI_FORBIDDEN: "Check your TDEI account's project-group permissions for this operation.",
  TDEI_NOT_FOUND: "Verify the resource id and environment (dev/stage/prod).",
  TDEI_CONFLICT: "Re-read the resource state and retry with current values.",
  TDEI_UPSTREAM_5XX: "Retry; if it persists, check TDEI environment status.",
  TDEI_CONFIG_INVALID: "Check .env values and tdei.config.json against the documented schema.",
  TDEI_TOOL_DISABLED: "Enable the tool in tdei.config.json or call tdei_reload_config.",
  TDEI_CHILD_UNAVAILABLE: "Call tdei_load_api_tools to restart the AWS child.",
};

export function formatError(err: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const inferred = inferCode(err);
  const stepRef = typeof err === "object" && err !== null && "stepRef" in err
    ? (err as { stepRef: TdeiErrorStepRef }).stepRef
    : undefined;
  const payload: TdeiMcpError = {
    code: inferred.code,
    message: inferred.message,
    hint: HINTS[inferred.code],
    retryable: inferred.retryable,
    ...(stepRef ? { stepRef } : {}),
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function truncateText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  let end = MAX_OUTPUT_BYTES;
  while (end > 0 && (text.charCodeAt(end) & 0xc0) === 0x80) end -= 1;
  const suffix = `\n{"truncated":true,"hint":${JSON.stringify(TRUNCATION_HINT)}}`;
  return { text: text.slice(0, end) + suffix, truncated: true };
}
```

Then: (a) verify no importers — `grep -rn "tdei-client" src test scripts`; (b) delete `src/api/tdei-client.ts` (`git rm`); if the directory `src/api/` becomes empty, leave the empty dir (git ignores it; do not add placeholder files).

Then rewire the two sites. In `src/aws/register-aws-tools.ts`, closure catch:

```ts
      async (args) => {
        try {
          const raw = await (onCall
            ? onCall(awsTool.name, args)
            : client.callTool(
              awsTool.name,
              args,
            ));
          return truncateResult(raw);
        } catch (error) {
          return formatError(error);
        }
      },
```

with a local helper in the same file:

```ts
function truncateResult(result: unknown): unknown {
  if (
    typeof result === "object" && result !== null &&
    "content" in result && Array.isArray((result as { content: unknown }).content)
  ) {
    const content = (result as { content: Array<Record<string, unknown>> }).content.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        const { text } = truncateText(block.text);
        return { ...block, text };
      }
      return block;
    });
    return { ...(result as Record<string, unknown>), content };
  }
  return result;
}
```

Import: `import { formatError, truncateText } from "../mcp/errors.js";` and remove the now-unused `errorResult` import ONLY if no other use remains in the file (check: the file's only errorResult use is this closure — verify with grep; if unused, remove the import to keep `tsc` clean... note `noUnusedLocals` is NOT yet enabled (that's Part C), but keep it tidy anyway).

In `src/workflows/runner.ts` abort path (`:103-122`): attach `stepRef` so `formatError`-shaped consumers (and the JSON text) carry it. Change the catch to throw an object carrying stepRef:

```ts
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transcript.push({
        id: step.id,
        tool: step.tool,
        input: resolved,
        error: message,
      });
      const payload = {
        failedStepId: step.id,
        stepIndex: index,
        tool: step.tool,
        input: resolved,
        error: message,
        priorOutputs: { ...outputs },
      };
      const abort = new Error(
        `[workflows.${def.name}] step ${step.id} (${step.tool}) failed: ${message} — transcript ${JSON.stringify(payload)}`,
      );
      (abort as unknown as { stepRef: TdeiErrorStepRef }).stepRef = {
        workflow: def.name,
        stepId: step.id,
        stepIndex: index,
        tool: step.tool,
      };
      throw abort;
    }
```

Import type: `import type { TdeiErrorStepRef } from "../mcp/errors.js";`. The workflow tool registration (`src/workflows/register.ts`) catches runner errors — check whether it uses `errorResult`; if so, switch that site to `formatError` too (read the file first; one-line change either way).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/health-errors.test.ts`
Expected: PASS (5 tests). Then full suite + `./node_modules/.bin/tsc --noEmit` clean (deletion must not break imports).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/errors.ts src/aws/register-aws-tools.ts src/workflows/runner.ts src/workflows/register.ts test/health-errors.test.ts && git rm -q src/api/tdei-client.ts && git commit -m "feat: structured errors with coded JSON and output cap"
```

---

### Task 2: log.ts + tdei_health + http retryable

**Files:**
- Create: `src/mcp/log.ts`
- Modify: `src/server.ts` (new tool after `tdei_auth_status`)
- Modify: `src/http.ts` (401 body `+ retryable`)
- Test: extend `test/health-errors.test.ts` (health + logger half)

**Interfaces:**
- Consumes: `formatError` not needed here; `auth.getStatus()`, `awsClient.isConnected()` (exists, `aws-mcp-client.ts:123`), `config.{apiUrl,specUrl,ssoCallbackUrl,transport}`, `loadConfigFile().filter.mode` (`config-file.ts:55`).
- Produces: `log(level: "debug"|"info"|"warn"|"error", msg: string, fields?: {tool?: string; sessionHash?: string}): void`; `hashToken(token: string): string`; `tdei_health` tool callable with `{}` input.

- [ ] **Step 1: Write the failing test**

Append to `test/health-errors.test.ts`:

```ts
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createServer } from "../src/server.js";
import { hashToken } from "../src/mcp/log.js";

test("logger hashes tokens in json mode", async () => {
  process.env.LOG_LEVEL = "json";
  const lines: string[] = [];
  const originalError = console.error;
  console.error = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.error;
  try {
    const { log } = await import("../src/mcp/log.js");
    log("error", "probe failed", { tool: "tdei_health", sessionHash: hashToken("secret-token-abc") });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, "error");
    assert.equal(parsed.tool, "tdei_health");
    assert.ok(!lines[0].includes("secret-token-abc"));
    assert.match(parsed.sessionHash, /^[0-9a-f]{12}$/);
  } finally {
    console.error = originalError;
    delete process.env.LOG_LEVEL;
  }
});

test("tdei_health works signed-out with stubbed probes", async () => {
  const { checkHealth } = await import("../src/server.js");
  const report = await checkHealth({
    fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    runUvx: (async () => "uvx 0.12.7") as () => Promise<string>,
    canBind: (async () => true) as () => Promise<boolean>,
  });
  assert.equal(report.ok, true);
  assert.equal(report.auth.state, "signed_out");
  assert.equal(report.spec.reachable, true);
  assert.equal(report.uvx.found, true);
  assert.equal(report.callback.portFree, true);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("secret"));
});

test("tdei_health tool is listed and callable", async () => {
  const server = await createServer({
    authManager: {
      async startSsoLogin() { throw new Error("not used"); },
      async getAccessToken() { throw new Error("TDEI_SSO_REQUIRED"); },
      getStatus: () => ({ configured: true, authenticated: false, state: "signed_out" as const, loginMethod: "sso" as const }),
      getTokenVersion: () => 1,
      async logout() { throw new Error("not used"); },
    },
    awsMcpClient: {
      async listTools() { return { tools: [] }; },
      async callTool() { throw new Error("TDEI_SSO_REQUIRED"); },
      async close() {},
      isConnected: () => false,
    },
    registerAwsTools: (async () => ({ discovered: 0, registered: 0, skipped: 0, toolSchemas: new Map() })) as never,
  });
  const client = new Client({ name: "health-tool-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "tdei_health"));
    const result = await client.callTool({ name: "tdei_health", arguments: {} });
    const body = JSON.parse(String(result.content[0].type === "text" ? result.content[0].text : "{}"));
    assert.equal(typeof body.ok, "boolean");
    assert.equal(body.auth.state, "signed_out");
  } finally {
    await client.close();
  }
});
```

Notes for the executor: the `registerAwsTools: ... as never` cast — `createServer`'s `ServerDependencies` requires the real registrar type; the cast bypasses it since this test's server never loads AWS tools (auth stub throws). If `tsc` complains about the cast target, use the real `registerAwsTools` import instead (it will run discovery against the stub client returning `{tools: []}` — safe). Prefer the real import; fall back to the cast only if discovery fails. The `awsMcpClient` stub adds `isConnected` — but `ServerDependencies["awsMcpClient"]` pick is `"callTool" | "close" | "listTools"` (no `isConnected`); extra property on an object literal triggers excess-property checks. Fix: define the stub as a variable first (`const awsStub = {...};`) then pass `awsMcpClient: awsStub` — excess properties are allowed through a variable. Same for the auth literal (it matches exactly, fine). And `checkHealth` needs the server's auth/aws — signature: `checkHealth(deps: {auth: {getStatus()}, aws: {isConnected()}, probes?: HealthProbes})`. Design it so the tool handler calls `checkHealth({auth, aws})` with real probes, tests inject stubs.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/health-errors.test.ts`
Expected: FAIL with `Cannot find module '../src/mcp/log.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/log.ts`:

```ts
import { createHash } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, fields: { tool?: string; sessionHash?: string } = {}): void {
  if ((process.env.LOG_LEVEL?.trim().toLowerCase() || "pretty") === "json") {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
    return;
  }
  const suffix = fields.tool ? ` [${fields.tool}]` : "";
  console.error(`[${level}]${suffix} ${msg}`);
}
```

In `src/server.ts`, add after the `tdei_auth_status` registration:

```ts
export interface HealthProbes {
  fetchImpl?: typeof fetch;
  runUvx?: () => Promise<string>;
  canBind?: (port: number, host: string) => Promise<boolean>;
}

export interface HealthReport {
  ok: boolean;
  auth: { state: string; expiresAt?: number };
  child: { connected: boolean; mode: string };
  spec: { url: string; reachable: boolean; latencyMs?: number; hint?: string };
  uvx: { found: boolean; version?: string; hint?: string };
  callback: { url: string; portFree: boolean | "n/a"; hint?: string };
  config: { transport: string; mode: string };
}

export async function checkHealth(
  deps: {
    auth: Pick<AuthManager, "getStatus">;
    aws: { isConnected(): boolean };
  },
  probes: HealthProbes = {},
): Promise<HealthReport> {
  const fetchImpl = probes.fetchImpl ?? fetch;
  const status = deps.auth.getStatus();
  let spec: HealthReport["spec"];
  const specStart = Date.now();
  try {
    const response = await Promise.race([
      fetchImpl(config.specUrl, { method: "GET" }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    await response.body?.cancel().catch(() => undefined);
    spec = { url: config.specUrl, reachable: response.ok, latencyMs: Date.now() - specStart };
  } catch {
    spec = { url: config.specUrl, reachable: false, hint: "Spec URL unreachable; check network and TDEI_SPEC_URL." };
  }

  let uvx: HealthReport["uvx"];
  try {
    const version = await (probes.runUvx ?? defaultRunUvx)();
    uvx = { found: true, version: version.trim() };
  } catch {
    uvx = { found: false, hint: "uvx not found on PATH; install uv (https://docs.astral.sh/uv/getting-started/installation/)." };
  }

  let callback: HealthReport["callback"];
  try {
    const url = new URL(config.ssoCallbackUrl);
    if (url.protocol === "https:") {
      callback = { url: config.ssoCallbackUrl, portFree: "n/a", hint: "https callback terminates remotely; no local bind applies." };
    } else {
      const port = Number(url.port);
      const free = await (probes.canBind ?? defaultCanBind)(port, url.hostname);
      callback = free
        ? { url: config.ssoCallbackUrl, portFree: true }
        : { url: config.ssoCallbackUrl, portFree: false, hint: `Port ${port} is in use; stop the occupying process before SSO login.` };
    }
  } catch {
    callback = { url: config.ssoCallbackUrl, portFree: false, hint: "Callback URL is invalid; check TDEI_SSO_CALLBACK_URL." };
  }

  const ok = spec.reachable && uvx.found && callback.portFree !== false;
  return {
    ok,
    auth: { state: status.state, ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}) },
    child: { connected: deps.aws.isConnected(), mode: status.authenticated ? "authenticated" : "discovery" },
    spec,
    uvx,
    callback,
    config: { transport: config.transport, mode: loadConfigFile().filter.mode },
  };
}
```

Helpers in `server.ts` (private):

```ts
async function defaultRunUvx(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("uvx", ["--version"], { timeout: 10_000 });
  return stdout;
}

async function defaultCanBind(port: number, host: string): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}
```

Imports to add in `server.ts`: `config` from `./config.js`, `loadConfigFile` from `./config-file.js`, `AuthManager` type already imported, `log` from `./mcp/log.js` (use `log("info", ...)` in the health handler for the partial-adoption requirement). Note: `server.ts` currently imports `config`? Check — `server.ts` was extracted from `index.ts`; it imports auth/aws/responses/register/lifecycle. If `config` isn't imported, add it. `loadConfigFile()` reads `tdei.config.json` — in tests it falls back to allow-all with a stderr warning; acceptable (or pass `TDEI_CONFIG_PATH` to a temp file; not required).

Register the tool right after `tdei_auth_status`:

```ts
  server.registerTool(
    "tdei_health",
    {
      description:
        "Report connector health: auth state, AWS child, spec reachability, uvx, callback port, and config. Read-only, safe signed-out, never emits tokens.",
      inputSchema: z.object({}),
    },
    async (_args) => {
      log("info", "health check", { tool: "tdei_health" });
      const report = await checkHealth({ auth, aws: awsClient });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );
```

Type wrinkle: `awsClient` is `ServerDependencies["awsMcpClient"]` (pick without `isConnected`). The real `AwsMcpClient` HAS `isConnected()` but the pick-type hides it. Options the executor must choose in order: (a) widen the pick with `"isConnected"` — one-word change, consistent with the Part A `getTokenVersion` widening precedent; the two stub clients in `session-lifecycle.test.ts` then need `isConnected: () => false` added (same pattern as before). Do (a). Also widen `register-aws-tools.ts` `AwsToolClient`? It doesn't need `isConnected` — leave it.

In `src/http.ts`, extend the unauthorized body: add `retryable: true` for `TDEI_SSO_REQUIRED`/`TDEI_TOKEN_INVALID` (client can retry after login) and `retryable: false`... hmm: expired → client CAN fix by refreshing → `retryable: true`. Missing/invalid → retryable only after user action → `false`. Set: `TDEI_SSO_REQUIRED → false`, `TDEI_TOKEN_INVALID → false`, `TDEI_TOKEN_EXPIRED → true`. Edit the three `unauthorized(...)` calls to include `retryable` in `extra`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/health-errors.test.ts`
Expected: PASS. Then full suite + `tsc --noEmit` clean (stub updates for `isConnected` included).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/log.ts src/server.ts src/http.ts test/health-errors.test.ts test/session-lifecycle.test.ts test/http-stateless.test.ts && git commit -m "feat: tdei_health tool with injectable probes and JSON logging"
```

Include `http-stateless.test.ts` only if its stubs needed `isConnected` (the `httpAuth` object is auth-only; the stub AWS clients there are `StubAwsMcpClient` instances — real class, has `isConnected`. No change expected, but verify at commit time and drop from the `git add` if untouched).

---

### Task 3: README docs

**Files:**
- Modify: `README.md` (Troubleshooting rows + `tdei_health` example)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add Troubleshooting rows**

In the Troubleshooting table, append one row per code (keep the two-column `| Symptom | What to check |` shape):

| Symptom | What to check |
| --- | --- |
| `TDEI_SSO_REQUIRED` | Call `tdei_sso_login` and open the returned `loginUrl`. |
| `TDEI_TOKEN_EXPIRED` | Refresh via `POST /api/v1/refresh-token` or re-run SSO login. |
| `TDEI_TOKEN_INVALID` | Call `tdei_sso_login` again; do not reuse the old Bearer. |
| `TDEI_FORBIDDEN` | Check your TDEI account's project-group permissions; the error names the requirement. |
| `TDEI_NOT_FOUND` | Verify the resource id and environment (dev/stage/prod). |
| `TDEI_CONFLICT` | Re-read the resource and retry with current values. |
| `TDEI_UPSTREAM_5XX` | Retry; if it persists, check TDEI environment status. |
| `TDEI_CONFIG_INVALID` | Check `.env` values and `tdei.config.json` against the schema. |
| `TDEI_TOOL_DISABLED` | Enable the tool in `tdei.config.json`, then call `tdei_reload_config`. |
| `TDEI_CHILD_UNAVAILABLE` | Call `tdei_load_api_tools` to restart the AWS child. |

- [ ] **Step 2: Add tdei_health example**

After the tool table in §4 ("Verify and use the connection"), insert (indented, not fenced):

    Ask for a health report any time, signed out or authenticated:

    {"ok": true, "auth": {"state": "authenticated"}, "child": {"connected": true, "mode": "authenticated"}, "spec": {"reachable": true, "latencyMs": 210}, "uvx": {"found": true}, "callback": {"portFree": true}}

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: error-code troubleshooting and tdei_health example"
```

---

## Self-review

- Spec coverage: §3 errors module + deletion + `inferCode` table (Task 1) · §4 wiring incl. runner `stepRef` + http `retryable` (Tasks 1-2) · §5 health tool + probes + `ok:false` semantics (Task 2) · §6 logger + 256KB cap (Tasks 1-2) · §7 tests incl. deletion grep + README example (Tasks 1-3) · §8 acceptance (health signed-out/authenticated, coded errors, green suite).
- Placeholder scan: every step has exact files, code blocks, run commands, expected outputs. Fallbacks named (real `registerAwsTools` import over `as never`; drop untouched files from `git add`).
- Type consistency: `formatError → {isError: true, content: [{type:"text", text:string}]}`; `truncateText → {text, truncated}`; `log(level, msg, fields?)`; `hashToken → string`; `checkHealth({auth, aws}, probes?) → Promise<HealthReport>`; `HealthProbes {fetchImpl?, runUvx?, canBind?}` — used identically in tests and implementation. `AwsToolCall` (Part A) reused for the closure type.
- Risk flagged inline: stub excess-property rules (variable-first pattern), `server.ts` missing `config` import (add it), `loadConfigFile` stderr warning in tests (accepted).
