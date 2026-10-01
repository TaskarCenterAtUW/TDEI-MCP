# Issue #4 Part C Design — CI + lazy config

Date: 2026-10-01. Source: TaskarCenterAtUW/TDEI-MCP#4 (Part C).
Status: approved for implementation. Parts A (token-rollover reload) and B
(health + structured errors) have their own specs
(`2026-10-01-token-rollover-design.md`,
`2026-10-01-health-errors-design.md`). This file covers Part C only, and
with it Issue #4 is fully specified.

## 1. Problem

`src/config.ts` throws at module load (`readHttpsUrl`, `resolveTransport`,
callback validator, port parser), so one bad env var breaks tests and
tooling before any typed error can surface. There is no
`.github/workflows` CI, no lint, and `tsconfig.json` lacks strictness flags.

## 2. Agreed decisions (user-confirmed)

- **Failure mode:** entries exit non-zero with `TDEI_CONFIG_INVALID` JSON
  (var + rule + example) on stderr. Rejected: degraded start (masks
  misconfiguration).
- **Lint:** `npm run lint` = `tsc --noEmit`, zero new deps. Rejected: eslint
  (heavier than this codebase needs).
- **Approach:** lazy `loadConfig()` + `getConfig()` singleton (fixes test
  env injection for real). Rejected: entry-level dynamic-import wrapping
  (cosmetic); Zod rewrite of working validators (YAGNI).

## 3. Changes

- `src/config.ts`:
  - Validators become pure per-var functions returning
    `{value} | {error: {var, rule, example}}`.
  - `loadConfig(): {ok: true, config} | {ok: false, errors: ConfigError[]}`
    reads env fresh on each call (no caching — tests inject env freely).
  - `getConfig()` memoizes the first successful load for runtime use; on
    failure throws a single `TdeiConfigError` carrying the errors array.
  - The module-level `config` const export is removed. All consumers switch
    to `getConfig()`: `src/auth/auth-manager.ts`, `src/aws/aws-mcp-client.ts`,
    `src/server.ts` (incl. `checkHealth`), `src/http.ts`, `src/init/*`.
  - Unchanged: `Transport`, `validateSsoCallbackUrl`, every env name,
    default, and validation rule.
- Entries (`src/index.ts`, `src/http.ts serveHttp()`): wrap startup config
  load in try/catch; on failure print
  `{"code": "TDEI_CONFIG_INVALID", "errors": [...]}` to stderr and exit 1
  before serving anything. `http.ts` host/port/overrides keep today's
  values, read from the loaded config.
- `tsconfig.json`: add `noUnusedLocals: true`,
  `exactOptionalPropertyTypes: true`; fix fallout (expected small: unused
  imports, `| undefined` hambre).
- CI + lint: new `.github/workflows/ci.yml` (Node 22, `npm ci`,
  `npm test`, `npm run build`, `tsc --noEmit`). `package.json` gains
  `"lint": "tsc --noEmit"`. `npm run test:live` stays manual dispatch.
- Tests: new `test/config-lazy.test.ts` — bad `TDEI_API_URL=http://...`
  yields `ok: false` naming var + rule (no throw, no module-reload hack);
  valid env yields `ok: true`; `getConfig()` memoizes; entry-failure JSON
  shape asserted from the thrower (entries are untestable glue — no
  process-exit assertions).
- Docs: README Troubleshooting row for `TDEI_CONFIG_INVALID` with an
  indented example JSON block.

## 4. Acceptance criteria (from issue, Part C)

- Bad env (e.g. `TDEI_API_URL=http://...`) yields `TDEI_CONFIG_INVALID`
  naming the var and rule instead of an uncaught import throw; existing
  valid setups start unchanged.
- `npm test`, `npm run build`, and new CI all green on Node 22.
- No change to STDIO/HTTP transport selection or `tdei.config.json`
  schema.

## 5. Out of scope

- Parts A and B (separate specs, implemented).
- Refresh-token vaulting, multi-tenant hosting, auto-TLS (v2).
- Full logger migration, eslint.

## 6. References

- `src/config.ts` (import-time throws to remove)
- `src/index.ts`, `src/http.ts` (entry fail-fast points)
- `tsconfig.json:1-14`, `package.json` scripts
