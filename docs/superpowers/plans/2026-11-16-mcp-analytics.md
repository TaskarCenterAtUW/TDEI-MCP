# TDEI-MCP Analytics Plan (OTEL)

Date: 2026-11-13 (revised after codebase review)
Status: Plan (not implemented)
Scope: `core` + `workspace` profiles × `dev/stage/prod` × HTTP (gateway + loopback); stdio out of scope

## 0. Review summary: what changed and why

The first draft assumed a stateful, session-based MCP server. The code is not. Verified in the repo:

| # | Finding (evidence) | Effect on the plan |
|---|---|---|
| 1 | HTTP is **stateless**: `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` and a fresh `McpServer` per request, closed in `finally` (`src/http.ts:477-492`). There is no `Mcp-Session-Id`, no session close, no standalone SSE stream. | Asks 4 (connection lifetime), 5 (active sessions) and 8 (`notifications/message` per session) cannot be measured as written on HTTP. Redesigned in §6. |
| 2 | **Lazy auth**: `initialize`, `tools/list` and notifications carry no bearer (`src/http.ts:347-352`). Only `tools/call` has one. | Email is known only on `tools/call`. "Init success by user" is impossible; init is measured per client, not per user. |
| 3 | `clientInfo` exists only in the `initialize` body. A later `tools/call` request is a separate stateless POST and does not repeat it. | Client attribution on `tools/call` must come from `User-Agent` plus an optional installer-set header (§4), not `clientInfo`. |
| 4 | Input validation by the SDK runs **before** our handler, and (spike, §9 step 0) it does not produce a JSON-RPC error: bad or missing args come back as a normal result with `isError:true` and text `Input validation error: Invalid arguments for tool X: <path>: <zod message>`. Extra/unknown args are silently stripped and the handler runs. | Hallucination is detected from the response text and from comparing raw request arg keys to the tool's schema keys, not from `-32602`. §6 row 7. |
| 5 | The container runs **several child processes** (`src/multi-serve.ts` spawns one per `mcps.json` entry) behind nginx. | One OTel SDK per child. Needs `service.instance.id`, per-child JSONL file names and a per-child `/metrics`. |
| 6 | Azure Container Apps has an **ephemeral filesystem**. A JSONL file under `./logs/analytics` is lost on restart or scale-in. | JSONL fallback is local-dev only. In Azure the fallback sink is stderr JSON (picked up by Log Analytics) or a mounted volume. |
| 7 | `tdei_health` does not exist; health is the HTTP route `GET /health` (`src/http.ts:608`). | Fix the verification step. |
| 8 | App Insights does not take plain OTLP/HTTP with an `OTEL_EXPORTER_OTLP_ENDPOINT` copied from the portal. | §7 rewritten: OTLP out of the app, translated by an OTel Collector or the Container Apps managed OpenTelemetry agent. Verify against current Azure docs before building. |
| 9 | The draft hand-rolled a sink layer (ring buffer, backoff, health check) that duplicates the OTel `BatchSpanProcessor` queue and OTLP exporter retries. | Replaced by one small `FallbackSpanExporter` (§3.1). `collector.ts` ring and `job_id` join dropped (YAGNI). |
| 10 | `NodeSDK` pulls auto-instrumentation and is heavy for a package shipped on npm, where most users only run `init`. | Compose the SDK from `sdk-trace-base`, `sdk-metrics`, `sdk-logs`; load it with dynamic `import()` only when analytics is enabled. |

## 1. Goal

Add OTEL-based telemetry and analytics to MCP tools covering:

1. Users + tools called + invocation frequency + payload token footprint
2. Users + clients used (Claude Desktop/CLI, Codex CLI/Desktop, OpenCode, etc.)
3. End-to-end latency of a single JSON-RPC operation
4. Lifetime of a client's connection (see §6 for the per-transport meaning)
5. Concurrent connected clients
6. Init success rates + JSON-RPC protocol error codes (-32601, -32602, etc.)
7. Parameter Hallucination Rate (invented or malformed args)
8. User+client-scoped logs

Decisions confirmed by user:
- OTEL from day 1 is required.
- Azure collector is not set up yet → OTEL-primary with automatic fallback.
- PII = email only. No tokens, keys or bearers in analytics.
- Transfer tools (upload/validate/download) excluded from overall tool-call latency aggregates.
- Ship on every MCP server/environment.

Decisions added 2026-11-14:
- **Stdio is out of scope.** Stdio installs are to be deprecated, so analytics is HTTP-only. No stdio instrumentation, no stdio session gauge, no stdout/stderr exporter concerns, no laptop-side disclosure issue. Deprecating stdio itself is a separate change (installers, `init`, README) and is not part of this plan.
- **Azure path = Container Apps managed OpenTelemetry agent** (§7).
- **HTTP "activity window"** replaces connection lifetime and concurrent sessions (§6 rows 4, 5).
- **Retention/access:** per-user emails in App Insights are readable by admins only; 90-day retention.

## 2. Codebase baseline (post-`892baa3`)

Hands-free transfer: `download`/`upload`/`validate` return a one-line curl with the **caller's own bearer embedded**, which the assistant runs on the CLIENT machine.

Implications:
- Never record tool *results* or *args values*. Record lengths and arg key names only. This makes redaction structural (nothing to scrub) instead of regex-based.
- MCP sees only the instruction payload, not dataset bytes. Report `mcp.payload.resp_bytes` only; never claim transfer bytes.
- `toolLatency` (MCP) differs from workflow latency (tool + shell curl + `tdei_list_jobs` polling). Only the first is measured here.

Hook points (verified):
- **HTTP choke point**: `handleMcpRequest()` in `src/http.ts`. One request = one JSON-RPC message, so one span per request is exact. Start the span before auth so 401/403/503 are counted.
- **Tool handlers**: `tool()` in `src/intents/register-tools.ts` (~line 340) and the handler in `src/openapi/register-openapi-tools.ts` (~line 152). Used for tool-level attrs (tool name, result bytes, `isError`) and as children of the request span.
- **Stdio**: not instrumented (being deprecated).
- **Identity**: `extractAuthIdentity()` (`src/auth/auth-manager.ts:118`), only **after** `validateToken()` succeeds (`src/http.ts` ~line 396). An unvalidated JWT can carry a forged email.
- **Env/profile**: `serverProfile` and `serverEnvironment` already resolved in `serveHttp()`.

## 3. Architecture

```
src/analytics/
  otel.ts       # initAnalytics(): TracerProvider + MeterProvider + LoggerProvider, resource attrs; no-op when disabled
  exporter.ts   # FallbackSpanExporter: OTLP first, JSONL (or stderr) on failure
  middleware.ts # startRpcSpan()/endRpcSpan() (HTTP only); withToolAnalytics(name, handler)
  identity.ts   # emailFromValidatedToken(), normalizeClient(ua, clientInfo, header)
  schema.ts     # attribute/metric names, TRANSFER_TOOLS, error classes (single source of truth)
```

Rules:
- Analytics never fails a request. Every emit is inside try/catch; init errors disable analytics, not the server.
- Zero cost when disabled: no OTel import, no wrapper allocations (dynamic `import()` behind `TDEI_ANALYTICS_ENABLED`).
- No edits to tool business logic.
- Cross-cutting module, allowed outside the per-backend folders in `AGENTS.md`. No backend-specific operation names here except the `TRANSFER_TOOLS` list, which lives in `schema.ts` and is covered by a test that fails if a new upload/download tool is added without being classified.

### 3.1 Export and fallback

Env (standard OTel vars plus three of ours):

```env
TDEI_ANALYTICS_ENABLED=1                 # HTTP only; default on when an endpoint is set, else off
TDEI_ANALYTICS_FALLBACK=auto             # auto|file|stderr|none
TDEI_ANALYTICS_DIR=./logs/analytics      # file fallback; filename includes pid/instance id
OTEL_SERVICE_NAME=tdei-mcp
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev
OTEL_EXPORTER_OTLP_ENDPOINT=             # unset today
OTEL_EXPORTER_OTLP_HEADERS=
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=1.0
```

Behavior:
1. Endpoint unset → spans go only to the fallback sink. Log one stderr line: `[analytics] otlp endpoint unset, using <sink>`.
2. Endpoint set → `BatchSpanProcessor(FallbackSpanExporter(OTLPTraceExporter))`. On export failure the wrapper writes the batch to the fallback sink as OTLP-JSON (`JsonTraceSerializer` from `@opentelemetry/otlp-transformer`) so it can be replayed to a collector later. Batching, queue limits and retry stay with the SDK; no custom backoff.
3. `auto` fallback = `file` when `TDEI_ANALYTICS_DIR` is writable and the process is not on Container Apps, else `stderr`. (Container Apps sets `CONTAINER_APP_NAME`.)
4. Metrics: OTLP only (`PeriodicExportingMetricReader`). Not replayed from the fallback; spans are the system of record and metrics can be rebuilt from them.

Dependencies (all pinned, added in build mode): `@opentelemetry/api`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-metrics`, `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/otlp-transformer`. Not `sdk-node`, not auto-instrumentations. Keep them in `dependencies` but loaded lazily; check the npm package size impact in the PR.

### 3.2 Resource attributes (set once per process)

`service.name=tdei-mcp`, `service.version=<BUILD.version>`, `service.instance.id=<gateway slug or mcps.json name>-<pid>`, `deployment.environment`, `mcp.server.profile` (core|workspace), `mcp.server.environment` (dev|stage|prod), `mcp.gateway.slug`.

### 3.3 Spans

One server span per JSON-RPC request: name `<method>` or `tools/call <tool>`. Align attribute names with the current OTel MCP/GenAI semantic conventions where they exist (verify against the spec at build time), otherwise use `mcp.*`.

| Attribute | Notes |
|---|---|
| `rpc.system=mcp`, `rpc.method` | `initialize`, `tools/list`, `tools/call`, `notifications/*` |
| `mcp.tool.name` | `tools/call` only; for `-32601` the *attempted* name, truncated to 80 chars |
| `mcp.tool.kind` | `semantic` \| `raw` \| `transfer` |
| `mcp.client.name`, `mcp.client.version` | from `initialize.clientInfo`, else UA parse (§4) |
| `enduser.id` | email, set only after token validation; absent on handshake |
| `mcp.payload.req_bytes`, `mcp.payload.resp_bytes`, `mcp.tokens.req_est`, `mcp.tokens.resp_est` | `ceil(bytes/4)`; req/resp separate |
| `mcp.args.keys` | sorted arg **names** only, never values |
| `mcp.result.is_error` | tool returned `isError` |
| `error.type`, `rpc.jsonrpc.error_code` | -32700/-32600/-32601/-32602/-32603 or `http_401` etc. |
| `mcp.hallucination.class` | `unknown_tool` \| `unknown_arg` \| `missing_required` \| `type_mismatch` (§6 row 7) |
| `http.response.status_code` | HTTP only |

### 3.4 Metrics (low-cardinality dimensions only)

Dimensions: `tool`, `client`, `profile`, `environment`, `outcome`, `error_code`. **Email is not a metric dimension** (cardinality and cost); per-user questions are answered from spans/logs.

- `mcp.server.operation.duration` (histogram, all methods; `mcp.tool.kind != transfer` for the headline tool-latency view)
- `mcp.transfer.instruction.duration` (histogram, transfer tools only)
- `mcp.tool.calls` (counter)
- `mcp.tool.payload.bytes` (histogram, `direction=req|resp`)
- `mcp.protocol.errors` (counter by `error_code`)
- `mcp.initialize` (counter, `outcome=ok|error`, by `client`)
- `mcp.server.requests.inflight` (up-down counter)

Rates (hallucination rate, init success ratio) are **computed in the backend** from counters, not emitted as pre-computed ratio metrics (ratios cannot be re-aggregated).

### 3.5 Logs

OTel Logs signal, one record per tool call and per protocol error, same attrs as the span plus `trace_id`. Replaces the draft's MCP `notifications/message` approach (see §6 row 8). Bodies contain only redacted/aggregated fields.

### 3.6 Local endpoints

- `GET /health` gets `analytics: { enabled, exporter: "otlp"|"fallback", fallbackSink, lastExportOk, droppedSpans }`.
- `/metrics` (Prometheus) is **optional**: only if a consumer exists. Use `@opentelemetry/exporter-prometheus` on a separate port, not a hand-written text endpoint, and note each child process needs its own port behind nginx. Default: not built.

## 4. Identity, client and PII

- `emailFromValidatedToken()` returns `{ email }` only. Called only after `ephemeralAuth.validateToken()` (HTTP) or from the already-authenticated session (loopback single-user). Drop username, sub, roles, groups.
- If no email claim: record `enduser.id` absent; do not fall back to `sub`.
- Never recorded: Authorization header, tokens, `curlCommand`, `metadata` values, `code`/`state`, `refresh_token`, api keys, any arg or result value.
- Safety net test: serialize every emitted span/log in tests and assert no match for `eyJ[A-Za-z0-9_-]{10,}`, `Bearer `, `refresh_token`, `api[-_]key`.
- Client normalization (`normalizeClient`): precedence is `initialize.clientInfo.name` → `X-TDEI-Client` header → `User-Agent`. Map to `claude-desktop, claude-code, codex-cli, codex-desktop, opencode, cursor, vscode, other`. Unknown values bucket to `other` (cap cardinality), raw string kept only as a span attr truncated to 64 chars.
- Optional, small change in `src/http-setup-script.ts`/installers: where the client config supports headers, have the installer add `X-TDEI-Client: <slug>` so `tools/call` can be attributed exactly. Only if the client config schema allows it; otherwise UA only. This reuses `normalizeSetupClientTarget()`/`clientMcpName()`.
- Telemetry is collected server-side on our own deployments only. The README and status page state what is collected (email, tool names, client, sizes, timings; no args or results). Access to per-user data in App Insights is admin-only, retention 90 days (set on the Log Analytics workspace).

## 5. Latency rules

- Headline `mcp.tool.latency` view filters out `mcp.tool.kind=transfer`; transfer tools feed `mcp.transfer.instruction.duration`.
- Transfer set = `tdei_upload_dataset`, `tdei_validate_dataset`, `tdei_download_dataset`, anything for which `BinaryTdeiDownloads.isDownloadTool()` is true, **and** workspace upload-style operations that return a curl (for example workspace-from-file and AOI upload; confirm in `src/tdei-workspace/tool-instructions.ts`). The classification test in §8 guards this list.
- Latency = request received → response written. `endRpcSpan()` runs after `sendWebResponse()` so it includes serialization. SSE responses end at stream close.
- Workflow latency (tool + shell curl + job polling) is out of scope; it can be derived later from spans by `job_id` if wanted.

## 6. The 8 asks → implementation

| # | Ask | Implementation | Caveat |
|---|-----|----------------|--------|
| 1 | users + tools + frequency + footprint | `withToolAnalytics()` in both `registerTool` sites sets tool/args-keys/bytes/is_error on the active request span; `mcp.tool.calls` counter | Per-user from spans (email attr), not metrics |
| 2 | users + clients | `normalizeClient()` per §4; `mcp.client.*` + `enduser.id` on `tools/call` spans | Exact only if `X-TDEI-Client` is set or UA is distinctive |
| 3 | JSON-RPC latency | One span per request from `handleMcpRequest()` start to after `sendWebResponse()` | |
| 4 | connection lifetime | No connection exists on stateless HTTP. Report a derived "client activity window" in the backend: first→last request per `(email, client)` with a 30-min idle split | Dashboard labels it "activity window", not "connection lifetime" (owner-approved) |
| 5 | concurrent clients | `mcp.server.requests.inflight` (live) plus "distinct `(email, client)` seen in last 5 min" computed in the backend. Never an in-process counter, because replicas and child processes would each show a partial number | Approved substitute |
| 6 | init + protocol errors | Request span for `initialize` with `outcome`; `mcp.protocol.errors` by code. Every POST returns HTTP 200 with `text/event-stream` (even unary calls), so JSON-RPC errors are read by tee-ing the response stream and parsing the first `data:` event (one request = one message). Exceptions: bad JSON returns HTTP 400 `application/json` with `-32700`; notifications return 202 with no body. Auth failures (401/403/503) are counted as `http_*`. Codes seen in the spike: unknown method `-32601`; **unknown tool is `-32602` ("Tool X not found")**, not `-32601` | Init is per client, not per user (no bearer on handshake). Record the attempted tool name for unknown tool (respect `isDenied()`) |
| 7 | hallucination rate | Classified in the request span, from the tee'd response plus the raw request: (a) `unknown_tool`: JSON-RPC `-32602` with "not found"; (b) `type_mismatch` / `missing_required`: result `isError` with text starting `Input validation error: Invalid arguments for tool`; parse the zod message after the path: `received undefined` → `missing_required`, other `expected X, received Y` → `type_mismatch`; (c) `unknown_arg`: raw `params.arguments` keys not in the tool's schema keys (stripped silently by the SDK, so only the request shows it). Store key names only, never values. Rate = flagged `tools/call` ÷ all `tools/call`, computed in the backend | Message text is parsed, so pin the SDK version and add a test that fails if the wording changes. `needs_input` replies from our own modules (optional-by-design fields, see `register-tools.ts`) are counted separately as `missing_input`, not as hallucination. A handler exception is also `isError` but has no validation prefix, so it is `tool_error`, not hallucination |
| 8 | user + client logs | OTel Logs signal with `enduser.id`, `mcp.client.name`, `trace_id` | HTTP is stateless: there is no channel to push `notifications/message`, so it is not offered |

## 7. Azure setup (TODO, verify against current Azure docs before building)

The app speaks standard OTLP. **Chosen path: Container Apps managed OpenTelemetry agent.** Enable it on each Container Apps environment, send traces and logs to Application Insights, and metrics to an OTLP-compatible destination. The platform injects `OTEL_EXPORTER_OTLP_ENDPOINT` into each app; the app needs no Azure SDK. Open items to confirm in current Azure docs before building: which signals App Insights accepts from the agent (metrics support has been limited), the exact env vars injected, and whether the injected endpoint is reachable from the nginx-spawned child processes. If metrics cannot reach App Insights, derive the dashboard metrics from spans in KQL (already the plan's system of record). An OTel Collector is the escape hatch, not the plan.

Per environment (dev/stage/prod) and per server (core, workspace):
1. One App Insights (workspace-backed) per environment; separate `deployment.environment` so one workspace can also work. Set workspace retention to 90 days and restrict workspace access to admins (per-user emails live in span attributes).
2. Set the env vars via Container App secrets/refs (`secretref:` as already done for `TDEI_OAUTH_SECRET`, README ~line 703), not plain env.
3. Restart, call `GET /health` and one tool, confirm `analytics.exporter=otlp` and traces in Transaction Search filtered by `mcp.server.environment`.
4. KQL queries/workbook for: tool frequency by user, latency p50/p95/p99 excluding transfer, error code mix, hallucination rate by tool, client mix, activity windows.
5. Helper `scripts/check-otel.mjs` (Node, not bash, to match the repo's scripts): probes the endpoint, reports which var is missing. Optional.
6. Add the vars to the deploy workflow and `Dockerfile` comments, same change as the code.

## 8. Tests (build mode)

New: `test/analytics-*.test.ts`, using an in-memory span exporter.

- Disabled by default: no OTel import, no overhead, behavior of existing tests unchanged.
- Never fails a request: exporter throws → tool call still succeeds.
- Fallback: OTLP endpoint refuses → spans appear in the fallback sink as OTLP-JSON.
- PII: email only, set only after validated token; forged unsigned JWT → no `enduser.id`; leak scan regex from §4 over all emitted telemetry for a transfer tool call (the curl embeds a bearer).
- Transfer classification: every tool name matching upload/download/validate patterns in both profiles is in `TRANSFER_TOOLS` or explicitly exempted; transfer excluded from tool-latency histogram.
- Client normalizer table test.
- Protocol errors: `-32601` unknown tool, `-32602` bad args (`unknown_arg`, `type_mismatch`), `-32700` bad JSON, 401 counted as `http_401`.
- Profile isolation unchanged: analytics adds no `tdei_*` tools and no backend-specific names in `tdei-shared/` (existing tests in `test/server-instructions.test.ts` still pass).
- Run `npx tsc --noEmit`, `pnpm test`, `pnpm check:tool-fields` per `AGENTS.md`. No browser/Playwright.

## 9. Build steps

0. **Spike: DONE (2026-11-14).** Ran the installed `@modelcontextprotocol/server` 2.4.0 with `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`. Results: unary POSTs return 200 `text/event-stream`; bad type and missing required (also missing `arguments`) → `isError` result with `Input validation error: Invalid arguments for tool <name>: <path>: <zod message>`; unknown arg → stripped, handler runs; unknown tool → `-32602`; unknown method → `-32601`; bad JSON → 400 `-32700`; handler throw → `isError` with the error message; notification → 202. Batch requests are accepted and return one SSE event per message, so the tee must parse every `data:` event and the span should record one operation per message (or a batch flag). Re-run the same script against `handleMcpRequest()` once the span code exists, to confirm the tee works through `sendWebResponse()`.
1. Add deps and `src/analytics/{schema,otel,exporter,identity,middleware}.ts` with disabled-by-default init.
2. Wire HTTP: `handleMcpRequest()` span start/end, set email after `validateToken`, finish after `sendWebResponse()`. Wire both `registerTool` sites.
3. `/health` analytics block; optional Prometheus; `scripts/check-otel.mjs`; `TDEI_ANALYTICS_*` documented in `README.md` (env table near line 542 and a new Analytics section including what is and is not collected).
4. Optional installer header `X-TDEI-Client` (tests in `test/installers.test.ts`, `test/http-setup-script.test.ts`; note both files currently have uncommitted changes, so sequence after those land).
5. Tests (§8), then verify: endpoint unset (fallback) → set (OTLP) → kill endpoint (fallback, tools still succeed).
6. Azure rollout (§7) dev → stage → prod; dashboards last.

## 10. Resolved decisions (2026-11-14) and remaining unknowns

Resolved: stdio out of scope (deprecating), managed OTel agent, activity window accepted, admin-only access with 90-day retention.

Remaining, to settle during the spike and Azure rollout:
1. (Resolved: batches are accepted; see §9 step 0.)
2. What the managed agent forwards to App Insights per signal (§7).
3. Whether installers can send `X-TDEI-Client` (§4).
