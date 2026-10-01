# CI + Lazy Config (Issue #4 Part C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace import-time config throws with a lazy `loadConfig()` + memoized `getConfig()`, fail fast with typed `TDEI_CONFIG_INVALID`, enable strict TS flags, and add CI.

**Architecture:** `src/config.ts` validators become pure per-var functions; `loadConfig()` reads env fresh per call for testability while `getConfig()` memoizes for runtime; entries catch the aggregated error and exit 1. Strict flags and CI ride along as they touch the same verification loop.

**Tech Stack:** TypeScript ES2022 NodeNext ESM, `node:test` + `tsx`, GitHub Actions (Node 22).

**Spec:** `docs/superpowers/specs/2026-10-01-ci-lazy-config-design.md`

## Global Constraints

- Node.js >=22 (package.json engines).
- TypeScript strict, ESM (`module: NodeNext`, `moduleResolution: NodeNext`), `rootDir ./src`, `outDir dist`.
- Env names, defaults, and validation rules unchanged — only the loading mechanics change.
- Entries exit 1 with `{"code":"TDEI_CONFIG_INVALID","errors":[...]}` on stderr before serving anything.
- Keep green: full suite via `node --import tsx --test test/*.test.ts` (npm unavailable here) and `./node_modules/.bin/tsc --noEmit`.
- Single-file runs: `node --import tsx --test test/<file>.test.ts`.

---

## File map (what changes and why)

- Modify: `src/config.ts` — pure validators, `loadConfig()`, `getConfig()`, `TdeiConfigError`; remove module-level `config` const.
- Modify (mechanical `config` → `getConfig()`): `src/auth/auth-manager.ts`, `src/aws/aws-mcp-client.ts`, `src/server.ts`, `src/http.ts`.
- Modify: `src/index.ts` (entry fail-fast), `src/http.ts serveHttp` (startup fail-fast).
- Test: `test/config-lazy.test.ts`, update `test/http-stateless.test.ts` import.
- Modify: `tsconfig.json` (strict flags), `package.json` (lint script).
- Create: `.github/workflows/ci.yml`.
- Modify: `README.md` (TDEI_CONFIG_INVALID row).

---

### Task 1: Lazy config + consumer migration + entry fail-fast

**Files:**
- Modify: `src/config.ts` (full rewrite of loading mechanics, same rules)
- Modify: `src/auth/auth-manager.ts`, `src/aws/aws-mcp-client.ts`, `src/server.ts`, `src/http.ts`, `src/index.ts`
- Test: `test/config-lazy.test.ts`; modify `test/http-stateless.test.ts:6` import

**Interfaces:**
- Consumes: `process.env` (fresh per `loadConfig()` call).
- Produces: `ConfigError {var: string, rule: string, example: string}`, `loadConfig(): {ok: true, config: ResolvedConfig} | {ok: false, errors: ConfigError[]}`, `getConfig(): ResolvedConfig` (memoized, throws `TdeiConfigError` on failure), `TdeiConfigError extends Error {errors: ConfigError[]}`, `ResolvedConfig` (same shape as today's `config` object: apiUrl, specUrl, ssoClientId, ssoCallbackUrl, transport, httpHost, httpPort, httpBasePath, corsOrigins, tlsCert, tlsKey, awsMcpPackage).

- [ ] **Step 1: Write the failing test**

```ts
// test/config-lazy.test.ts
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
```

Note on memoization: `getConfig()` memoizes the first SUCCESSFUL load per process. The third test calls `getConfig()` with bad env — if an earlier test (or module import) already memoized a good config, the throw never happens. Order dependence! Handle it: `getConfig()` must memoize per... simplest correct approach honoring the spec ("memoizes the first successful load"): export an internal `resetConfigForTests()` — no, spec doesn't mention it. Alternative reading: memoize keyed by nothing, but tests run in one process. The existing test files import `config`-consumers at top (which no longer load at import — that's the point). But `http-stateless.test.ts` and others call `getConfig()` indirectly via `validateSsoCallbackUrl`? No — that stays pure. Who calls `getConfig()` at module scope? Nobody after migration (all call sites are inside functions). So the FIRST `getConfig()` call in the process wins. In `config-lazy.test.ts` process, no other test file runs (single-file run) — but the full-suite run shares the process? No: `node --test` runs each FILE in a separate process. Within `config-lazy.test.ts`, test order is file order: test 3's bad-env `getConfig()` — did tests 1-2 call `getConfig()`? They call `loadConfig()` only (fresh each time, no memo). So test 3 is the first `getConfig()` call → throws correctly. But defensively: if a future test calls `getConfig()` first with good env, test 3 breaks. Add a comment in the file: "getConfig() memoizes per process; this file must call loadConfig() (unmemoized) in earlier tests and getConfig() only here." Also add a fourth test AFTER test 3 asserting memoization returns the SAME object... it would throw (memoized failure? No — failures are NOT memoized, only successes; test 3 threw, nothing memoized). Fourth test:

```ts
test("getConfig memoizes successful loads", () => {
  withEnv({ TDEI_HTTP_PORT: undefined }, () => {
    const first = getConfig();
    const second = getConfig();
    assert.equal(first, second);
  });
});
```

This works regardless of order (first success wins; earlier tests never succeeded). Good — include it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/config-lazy.test.ts`
Expected: FAIL with `Cannot find module '../src/config.js'` exporting `loadConfig` (SyntaxError: does not provide an export named 'loadConfig' — `config`, `validateSsoCallbackUrl`, `resolveTransport` exist; `loadConfig` does not).

- [ ] **Step 3: Write minimal implementation**

Rewrite `src/config.ts` loading mechanics (keep ALL defaults, env names, and rules byte-identical):

```ts
export type Transport = "stdio" | "http"; // unchanged

export interface ConfigError {
  var: string;
  rule: string;
  example: string;
}

export interface ResolvedConfig {
  apiUrl: string;
  specUrl: string;
  ssoClientId: string;
  ssoCallbackUrl: string;
  transport: Transport;
  httpHost: string;
  httpPort: number;
  httpBasePath: string;
  corsOrigins: string[];
  tlsCert: string | undefined;
  tlsKey: string | undefined;
  awsMcpPackage: string;
}

export class TdeiConfigError extends Error {
  constructor(public readonly errors: ConfigError[]) {
    super(`TDEI_CONFIG_INVALID: ${errors.map((e) => `${e.var} (${e.rule})`).join("; ")}`);
    this.name = "TdeiConfigError";
  }
}
```

Each current validator becomes a pure function returning `{value} | {error}`. Concretely, keep `readHttpsUrl(name, fallback)` logic but split: `readHttpsUrl(name, fallback, example): { value: string } | { error: ConfigError }` — it currently throws `${name} must use HTTPS` / `must be a valid absolute URL`. Map: invalid URL → `{var: name, rule: "must be a valid absolute URL", example}`; non-https → `{var: name, rule: "must use HTTPS", example}`. Examples: `TDEI_API_URL → "https://api-dev.tdei.us"`, `TDEI_SPEC_URL → "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json"`. Keep `validateSsoCallbackUrl(value, transport)` PURE and throwing (tests import it; http-stateless.test.ts:6 depends on it) — but `loadConfig` catches its throw and converts: stdio rule → `{var: "TDEI_SSO_CALLBACK_URL", rule: "must use http://127.0.0.1:<port>/callback", example: "http://127.0.0.1:8765/callback"}`; http-mode rule → `{var, rule: "must use https:// in http mode (http://127.0.0.1:<port>/callback allowed for local dev)", example: "https://mcp.example.com/callback"}`. Distinguish by matching `/127\.0\.0\.1/` in the thrown message (fragile but in-repo; alternative: split validateSsoCallbackUrl into a non-throwing inner — prefer the inner split: `checkSsoCallbackUrl(value, transport): ConfigError | undefined`, `validateSsoCallbackUrl` keeps throwing by delegating to it. Do that.)

`resolveTransport`, `readHttpPort`, `readBasePath` similarly: pure check + throwing wrapper kept for compat? Only `validateSsoCallbackUrl` has external test callers; `resolveTransport`/`readHttpPort`/`readBasePath` are module-private — convert them directly to error-returning internals. Transport error: `{var: "TDEI_TRANSPORT", rule: 'must be "stdio" or "http"', example: "stdio"}`. Port error: `{var: "TDEI_HTTP_PORT", rule: "must be an integer 1-65535", example: "3000"}`.

`loadConfig()`:

```ts
export function loadConfig(): { ok: true; config: ResolvedConfig } | { ok: false; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  // ... evaluate each var, pushing errors, keeping readings for successes
  // ssoCallbackUrl needs transport first: evaluate transport first; on
  // transport error, skip callback check (avoid cascading) — or check
  // against default stdio? Decision: skip callback when transport itself
  // is invalid (one error, not two).
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { ... } };
}
```

`getConfig()`:

```ts
let memoized: ResolvedConfig | undefined;
export function getConfig(): ResolvedConfig {
  if (memoized) return memoized;
  const result = loadConfig();
  if (!result.ok) throw new TdeiConfigError(result.errors);
  memoized = result.config;
  return memoized;
}
```

Keep exporting `Transport`, `validateSsoCallbackUrl`, `resolveTransport` (pure now — return Transport or... it was throwing; make it return `{value} | {error}`? External callers: grep shows only config.ts internal use + maybe tests. Check with grep; if only internal, make it private-ish (still exported for tests is fine, but keep the throwing signature? No — throwing reintroduces the problem. Make `resolveTransport(): Transport` default-invalid→stdio? NO — silent fallback masks errors. Decision: `resolveTransport` becomes internal returning `Transport | ConfigError`; not exported. Update this paragraph's claim if grep finds external callers — executor must grep first.)

Consumer migration (mechanical): replace `import { config } from "../config.js"` with `import { getConfig } from "../config.js"` and each `config.X` use with `getConfig().X`? That reloads... `getConfig()` memoizes — cheap. But per-call overhead + repeated calls in hot paths. Cleaner: capture once per scope. In `auth-manager.ts`, methods use `config.apiUrl` etc. — replace with `getConfig()` at each use site (memoized, negligible). In `aws-mcp-client.ts` `startChild` — same. In `server.ts` `checkHealth` + tool closures — the closures run per-call; `getConfig()` memoized so fine. In `http.ts` — `buildLoginUrl/buildLogoutUrl` per request + `serveHttp` startup; fine.

Entry fail-fast. `src/index.ts` entry block: BEFORE the transport branch, force config load:

```ts
  let startupConfig;
  try {
    startupConfig = (await import("./config.js")).getConfig();
  } catch (error) {
    if (error instanceof (await import("./config.js")).TdeiConfigError) {
      console.error(JSON.stringify({ code: "TDEI_CONFIG_INVALID", errors: error.errors }));
    } else {
      console.error(JSON.stringify({ code: "TDEI_CONFIG_INVALID", errors: [{ var: "unknown", rule: String(error), example: "" }] }));
    }
    process.exit(1);
  }
```

Hmm — static import of config.js at index.ts top? index.ts currently does NOT import config (it imports server.js which imports... server.ts imports config.js after migration). Static import is fine — the throw only happens on getConfig() call, not import. So simply `import { getConfig, TdeiConfigError } from "./config.js"` at top and try/catch around `getConfig()`. Same in `http.ts serveHttp`: wrap the whole body start:

```ts
  let httpConfig;
  try {
    httpConfig = getConfig();
  } catch (error) {
    console.error(JSON.stringify({ code: "TDEI_CONFIG_INVALID", errors: error instanceof TdeiConfigError ? error.errors : [...] }));
    process.exit(1);
  }
```

and use `httpConfig` for host/port/path/cors instead of `config.*`. Note `serveHttp` currently reads `config.httpBasePath` for routing, `config.corsOrigins` in checkCors (module function — pass config through: change `checkCors(request, response)` to accept origins, or call getConfig() inside — memoized, simplest: `getConfig().corsOrigins` inside checkCors/handleMcpRequest; but in tests with valid env it's memoized fine).

Update `test/http-stateless.test.ts:6` — it imports `validateSsoCallbackUrl` from `../src/config.js`; that export stays. No change needed. (Plan's file-map claim of an import update was wrong; verify at implementation: if the import still resolves, leave the file untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/config-lazy.test.ts`
Expected: PASS (4 tests). Then full suite + `tsc --noEmit`. Expect fallout: any test importing the removed `config` const (grep `import { config }` in test/ — http-stateless imports `validateSsoCallbackUrl` only; check others). Fix by switching to `getConfig()`/`loadConfig()`.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/auth/auth-manager.ts src/aws/aws-mcp-client.ts src/server.ts src/http.ts src/index.ts test/config-lazy.test.ts test/http-stateless.test.ts && git commit -m "feat: lazy config loading with typed TDEI_CONFIG_INVALID fail-fast"
```

Drop untouched files from the add at commit time.

---

### Task 2: Strict flags + CI + lint + docs

**Files:**
- Modify: `tsconfig.json`, `package.json`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Test: none new (verification is `tsc` + full suite + `gh` workflow validation)

**Interfaces:** none.

- [ ] **Step 1: Enable strict flags and fix fallout**

In `tsconfig.json` add `"noUnusedLocals": true, "exactOptionalPropertyTypes": true` (keep existing `strict`, target, module settings).

Run: `./node_modules/.bin/tsc --noEmit`
Expected: FAIL with a list of unused-locals / exact-optional errors. Fix each minimally:
- Unused imports/params: remove the import; prefix intentionally-unused params with `_` (TS ignores `_`-prefixed args for noUnusedParameters — but the flag here is noUnusedLocals; unused function ARGS are covered by noUnusedParameters which is NOT enabled, so only locals/imports matter).
- `exactOptionalPropertyTypes`: assignments of `X | undefined` to optional `prop?: X` fail — fix with explicit `| undefined` on the property type or conditional spread (the codebase already uses `...(x ? {x} : {})` in server.ts checkHealth — follow that pattern).

Repeat until `tsc --noEmit` is clean. Then full suite (runtime unaffected, but run to be sure).

- [ ] **Step 2: Add lint script + CI workflow**

`package.json` scripts: add `"lint": "tsc --noEmit"`.

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
      - run: npm run lint
```

Validate YAML shape without pushing: `node -e "require('fs').readFileSync('.github/workflows/ci.yml','utf8')" ` plus eyeball indentation; `gh workflow view ci` only works post-push — instead verify with `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` if PyYAML exists, else skip (actions will validate on push).

- [ ] **Step 3: README row**

In Troubleshooting, after the `TDEI_CHILD_UNAVAILABLE` row add:

| `TDEI_CONFIG_INVALID` | Check the named variable against its rule; the error JSON includes a working example value. |

And an indented example block after the health example (Task location: §4 "Verify" area):

    Bad env fails fast before serving anything:

    {"code": "TDEI_CONFIG_INVALID", "errors": [{"var": "TDEI_API_URL", "rule": "must use HTTPS", "example": "https://api-dev.tdei.us"}]}

- [ ] **Step 4: Verify + commit**

Run: full suite + `tsc --noEmit` + `./node_modules/.bin/tsc` (build) — all clean.
```bash
git add tsconfig.json package.json .github/workflows/ci.yml README.md && git commit -m "feat: strict tsconfig flags, lint script, and CI workflow"
```

---

## Self-review

- Spec coverage: §3 loadConfig/getConfig/TdeiConfigError + consumer list + entry fail-fast + flags + CI + lint + tests + docs (Tasks 1-2, all covered).
- Placeholder scan: every step has exact files, code blocks, run commands, expected outputs. Two honest uncertainty points flagged inline (resolveTransport external callers → grep first; http-stateless import → verify, likely untouched).
- Type consistency: `ConfigError {var, rule, example}`, `loadConfig → {ok:true, config} | {ok:false, errors}`, `getConfig → ResolvedConfig` (throws `TdeiConfigError`), `ResolvedConfig` field-for-field matches today's `config` object. Names used identically across tasks.
- Risk noted: getConfig memoization vs test order — handled by loadConfig-only earlier tests + documented ordering comment + memoization test placed last.
