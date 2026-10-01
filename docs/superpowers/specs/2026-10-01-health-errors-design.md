# Issue #4 Part B Design — tdei_health + structured errors

Date: 2026-10-01. Source: TaskarCenterAtUW/TDEI-MCP#4 (Part B).
Status: approved for implementation. Part A (token-rollover reload) has its
own spec (`2026-10-01-token-rollover-design.md`); Part C (CI + lazy config)
will be a separate spec. This file covers Part B only.

## 1. Goal

Give operators a health signal and give agents structured, actionable errors:
a read-only `tdei_health` tool, a single error vocabulary (`TdeiMcpError` +
`formatError()`), JSON logging support, and a 256KB output cap — with no
behavior change to transports, auth, or the config schema.

## 2. Agreed decisions (user-confirmed)

- **Dead client:** delete `src/api/tdei-client.ts` (nothing imports
  `tdeiRequest`; workflow steps must go through the version-gated lifecycle
  child, not direct fetch). Its 400/401/403/404/409/5xx message table is
  folded into `inferCode()` in the new errors module.
- **Error shape:** JSON body inside the existing `text` content field
  (`{isError: true, content: [{type: "text", text: "{code,message,hint,
  retryable[,stepRef]}"}]}`). No `structuredContent` migration, no protocol
  breakage.
- **Health depth:** lightweight probes only (timed fetch, `uvx --version`
  spawn, brief port bind, `isConnected()`). No child spawn, no spec-JSON
  validation, safe signed-out.
- **Logging:** new `src/mcp/log.ts`, adopted in new code only. Existing
  `console.error` sites untouched; full migration is future work.

## 3. `src/mcp/errors.ts` (new)

- `TdeiMcpError {code: TdeiErrorCode, message: string, hint: string,
  retryable: boolean, stepRef?: {workflow: string, stepId: string,
  stepIndex: number, tool: string}}`.
- Codes (minimum): `TDEI_SSO_REQUIRED`, `TDEI_TOKEN_EXPIRED`,
  `TDEI_TOKEN_INVALID`, `TDEI_FORBIDDEN`, `TDEI_NOT_FOUND`,
  `TDEI_CONFLICT`, `TDEI_UPSTREAM_5XX`, `TDEI_CONFIG_INVALID`,
  `TDEI_TOOL_DISABLED`, `TDEI_CHILD_UNAVAILABLE`.
- `formatError(err: unknown): {isError: true, content: [...]}` — classifies
  via `inferCode()`, serializes the JSON body into the text field.
- `inferCode()`: maps backend/child error text or HTTP status to a code,
  absorbing `tdei-client.ts`'s status table. `403` surfaces the backend's
  required project-group or permission string in `message` where the body
  carries one.
- `errorResult()` (`src/mcp/responses.ts`) stays for unmigrated paths.

## 4. Wiring

- `src/aws/register-aws-tools.ts` tool-closure catch: `errorResult(error)` →
  `formatError(error)`. Raw child errors become coded JSON; the 256KB
  truncation (§6) applies here.
- `src/workflows/runner.ts` step-failure path: the abort error carries
  `code + stepRef` via the `TdeiMcpError` shape. The existing transcript
  payload (`failedStepId, stepIndex, tool, input, error, priorOutputs`) is
  preserved; only the error surface gains codes.
- `src/http.ts` 401 envelope: HTTP status codes unchanged
  (transport-level), but the JSON body gains `retryable` alongside the
  existing `code / message / loginUrl / refresh_hint`.

## 5. `tdei_health` tool (`src/server.ts`, next to `tdei_auth_status`)

- Read-only, no input, works signed-out, never emits tokens.
- Returns JSON text with: `auth {state, expiresAt}` (from
  `auth.getStatus()`), `child {connected, mode}` (`isConnected()` plus mode
  where exposed), `spec {url, reachable, latencyMs}` (timed GET, 5s
  timeout; `reachable: false + hint` on failure), `uvx {found, version}`
  (`uvx --version` spawn, 10s timeout; `found: false + hint` otherwise),
  `callback {url, portFree}` (parse configured URL; briefly test-bind
  loopback ports then release; `https` callbacks report `portFree: "n/a"`
  with a hint since no local bind applies), `config {transport, mode}`
  (transport + endpoint-filter mode).
- Any failing subsystem yields top-level `ok: false` with per-subsystem
  `hint`. In HTTP mode the tool sees the request-Bearer validity through
  the ephemeral auth already passed to `createServer` — no special-casing.

## 6. Logger + output cap

- New `src/mcp/log.ts`: `log(level, msg, fields?: {tool?, sessionHash?,
  ...})`. `LOG_LEVEL=pretty|json` (default `pretty`, byte-identical to
  today's `console.error` format). JSON mode emits one object per line:
  `{ts, level, msg, tool?, sessionHash?}`. Tokens are hashed (SHA-256,
  first 12 hex chars), never logged. Adopted in new code (health, errors,
  Part A rollover log) only. Stdout stays reserved for MCP.
- 256KB cap: `text` outputs over 262144 bytes (UTF-8) are truncated in
  `formatError()` and the `register-aws-tools.ts` pass-through, appended
  with `{truncated: true, hint: "Output exceeded 256KB; refine filters or
  call a narrower operation."}`.

## 7. Tests + docs

- New `test/health-errors.test.ts`: `formatError` code mapping (including
  403 backend-message surfacing and `TdeiApiError`-shaped inputs),
  truncation boundary (under/over 256KB), `tdei_health` signed-out via
  `InMemoryTransport` (stub `uvx` spawn + spec fetch: no network, no
  subprocess; assert shape, `ok` field, and absence of token material in
  output), JSON logger line shape with token-hash assertion.
- `tdei-client.ts` deletion verified by `tsc` (no importers) plus a grep in
  the test.
- README: Troubleshooting row per new error code + `tdei_health` example
  output as an indented block (not fenced):

  {"ok": true, "auth": {"state": "authenticated"}, "child": {"connected": true, "mode": "authenticated"}, "spec": {"reachable": true, "latencyMs": 210}, "uvx": {"found": true}, "callback": {"portFree": true}}

## 8. Acceptance criteria (from issue, Part B)

- `tdei_health` works signed-out and authenticated, reports each subsystem,
  marks failing subsystems `ok: false` with a hint, never prints tokens.
- Every migrated tool error is JSON with `code, message, hint, retryable`;
  `403` surfaces the required project-group or permission from the backend
  body where present.
- `npm test` and `npm run build` green. No change to STDIO/HTTP transport
  selection or `tdei.config.json` schema.

## 9. Out of scope

- Part A (separate spec) and Part C (separate spec).
- Full logger migration, `structuredContent` errors, deep health probes.
- No NPX UX, filtering, workflow, or transport changes (Issues 1-3).
- No spec-version diffing or output-schema validation beyond the 256KB cap.

## 10. References

- `src/api/tdei-client.ts:4-117` (dead `TdeiApiError` + status table to fold in)
- `src/aws/register-aws-tools.ts:124-140` (closure catch to rewire)
- `src/workflows/runner.ts:97-122` (step-failure path)
- `src/server.ts` (`tdei_auth_status` pattern, `createServer` injection)
- `src/http.ts` (401 envelope to extend with `retryable`)
- `src/mcp/responses.ts` (`errorResult`, stays for unmigrated paths)
