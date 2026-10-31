# OTEL Instrumentation Design (Usage, Performance, Correlation)

Date: 2026-10-31
Status: draft spec; no implementation
Supersedes: none
Related: `2026-10-02-common-semantic-intent-layer-design.md`, `2026-09-30-streamable-http-design.md`

## 1. Outcome

TDEI-MCP gains vendor-neutral OpenTelemetry instrumentation for usage, performance, and request correlation across all transports (stdio, Streamable HTTP, multi-serve children behind nginx gateway) without changing tool behavior.

Signals: traces + metrics + correlated logs, all pushed via OTLP. No Prometheus scrape endpoint (stdio has no listener; HTTP children are ephemeral per request).

Backends supported (per deploy, env-selected):

- generic OTLP HTTP/protobuf collector (Alloy / OTEL Collector / Grafana / Honeycomb / Datadog OTLP),
- Azure Monitor (Application Insights) via connection string.

## 2. Non-goals

- No Rails / multi-tenant DB work; this repo is Node 22 + TypeScript MCP.
- No DaisyUI / Hotwire / Turbo work; no UI changes except `/health` telemetry status field and plaintext status page wording.
- No Prometheus `/metrics` listener in v1.
- No nginx native OTEL module; nginx access logs unchanged (correlate via `Mcp-Session-Id` passthrough only).
- No second LLM, no conversational memory, no tool-behavior change.

## 3. Source facts (verified 2026-10-31)

- `package.json:65-70`: no `@opentelemetry/*`, no `prom-client`.
- `src/mcp/log.ts:9-16`: `console.error` pretty/JSON only; no trace/span IDs.
- `src/intents/types.ts:4-7`: `RequestContext.requestId?` defined, zero usages (`grep requestId`).
- `src/http.ts:197-319,391,380`: per-request ephemeral `McpServer`/transport, no `traceparent` handling, `/health` + `/` only.
- `src/server.ts:163-429`, `src/http-semantic-server.ts:68-334`, `src/adapters/http-tdei-operations.ts:453-590`: no spans/meters, no header propagation.
- Tests: `node --import tsx --test test/**/*.test.ts` (Node native runner).
- Deploy: `Dockerfile` single image (node multi-serve children + nginx), `scripts/docker-entrypoint.sh`, `mcps.json` (dev/staging/prod/workspace children), ACA-friendly.

## 4. Configuration (env only, standard OTEL + one flag)

Disabled by default for local dev. Init only when `TDEI_OTEL_ENABLED=1`.

| Var | Rule |
|---|---|
| `TDEI_OTEL_ENABLED` | `1/true` to init SDK; otherwise Noop. Never throws. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base collector URL, e.g. `https://collector:4318`. Per-signal overrides `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` win. |
| `OTEL_EXPORTER_OTLP_HEADERS` / per-signal | `k=v,k=v` (e.g. `api-key=...`). Never logged. |
| `OTEL_SERVICE_NAME` | Override; default `tdei-mcp-<gatewaySlug\|stdio\|http>` derived from `TDEI_GATEWAY_SLUG`. Per-child names required in multi-serve. |
| `OTEL_RESOURCE_ATTRIBUTES` | Passed through (e.g. `deployment.environment=prod`). SDK merges `service.version=BUILD.serverVersion`, `service.name`, `host.name`, process runtime. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Default `parentbased_always_on` dev, `parentbased_traceidratio` + `0.1` prod when unset (code default by `TDEI_API_URL`: `api.tdei.us` → 0.1, else 1.0). |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | If set (and enabled), use Azure Monitor exporter instead of generic OTLP for all signals. Generic headers ignored in this mode. |
| `OTEL_LOG_LEVEL`, `OTEL_SDK_DISABLED` | Respected as no-op/debug escape hatches. |

`multi-serve.ts:startChild()` must forward the above env verbatim to each child; per-child `OTEL_SERVICE_NAME` is derived in-child from `TDEI_GATEWAY_SLUG`, not overridden by parent.

`.env.example`, `tdei.config.schema.json`, `README` document the table. No secrets in `/health` output.

## 5. SDK lifecycle

New `src/otel/` (pure, transport-agnostic):

- `config.ts` — `resolveOtelConfig(env): {enabled, exporter: "otlp"|"azure"|"none", serviceName, sampling}`. Pure function, fully unit-tested.
- `sdk.ts` — `initOtelOnce(): Promise<OtelHandle>`, `shutdownOtel()`. `NodeSDK` with `BatchSpanProcessor` (queue 2048, schedule 5s, timeout 3s), `PeriodicExportingMetricReader` (60s), `BatchLogRecordProcessor`. Fail-open: exporter errors/timeouts are swallowed and counted (`otel.export.errors`), never reject tool promises.
- `attrs.ts` — allowlist builder + `hashSession()` reuse from `mcp/log.ts`.
- `wrap.ts` — `withToolSpan()`, `withUpstreamSpan()`, `getCorrelationIds()`.

Init order: `src/index.ts` and `src/multi-serve.ts` call `initOtelOnce()` before `serveHttp()/serveStdio()/serveMulti()`; `SIGINT/SIGTERM` flush via `shutdownOtel()`. Diag logger to stderr only (never stdout; stdio transport forbids stdout noise).

## 6. Instrumentation points and span model

Root span per ingress MCP request in `src/http.ts:handleMcpRequest` (`mcp.request`, `http.route=/mcp`, `mcp.transport=http|stdio`, `mcp.session.id_hash`). Extract incoming `traceparent`/`tracestate`; generate `requestId` (UUIDv7) and populate `RequestContext.requestId` end-to-end (closes the dead field in `types.ts`).

Child spans:

- one per tool handler (`mcp.tool.name`, `mcp.tool.success`, `error.type` on failure) covering all `registerTool` sites in `server.ts`, `http-semantic-server.ts`, `register-tools.ts` (semantic + generated OpenAPI tools);
- one per upstream TDEI call in `HttpTdeiOperations.requestText/getRecords`, `OpenApiMcpClient`, `DirectMultipartTdeiMutations`, binary downloads (`tdei.api.operation`, sanitized `http.route` template e.g. `api/v1/datasets`, `http.status_code`, `upstream.retry` if any). Inject outgoing `traceparent`.
- auth validation (`auth.validate_token`, `auth.mode: bearer|session`) with failure reason as low-card enum only.

No span ever contains: `Authorization`, bearer, `code`/`state`, dataset bodies, inline base64, PII emails, full URLs with query secrets. High-card IDs (`projectGroupId`, `datasetId`, `jobId`) are hashed (first 12 hex) or bucketed; `tool_name` as attribute is allowed (bounded catalogue ~40 tools).

Metrics (OTLP push, 60s):

- `mcp.tool.calls` (counter, by `tool.name`, `success`),
- `mcp.tool.duration` (histogram ms, same attrs),
- `mcp.tool.errors` (counter, by `tool.name`, `error.type`),
- `tdei.upstream.duration` (histogram, by `operation`, `status_code_class`),
- `auth.failures` (counter, by `reason: expired|invalid|missing`),
- `otel.export.errors` (counter, internal health).

Logs: `mcp/log.ts` JSON mode gains `trace_id`, `span_id`, `service.name` when SDK active; pretty mode unchanged. Existing `LOG_LEVEL=json` preserved.

## 7. Deployment

Direct push from each Node child to the configured OTLP/HTTPS endpoint or Azure ingestion. No sidecar in v1 (sidecar remains a compatible future option: point endpoint at `http://localhost:4318`).

- ACA: set per-env `OTEL_EXPORTER_OTLP_ENDPOINT` (or `APPLICATIONINSIGHTS_CONNECTION_STRING`) + `TDEI_OTEL_ENABLED=1` + `OTEL_TRACES_SAMPLER_ARG`. Children egress direct; nginx untouched.
- `/health` gains `telemetry: {enabled: bool, exporter: "otlp"|"azure"|"none", service: string, sampled: bool}` — no URLs/keys.
- Overhead budget: p99 added latency `<10ms` per tool call when collector healthy; on collector outage tools succeed with drops counted.
- Docker image: only new npm deps; entrypoint/nginx unchanged.

## 8. Tests and acceptance (TDD, Node runner)

Required before implementation merges (spec only here):

- `test/otel-config.test.ts` — disabled-by-default; Azure-vs-generic precedence; per-child service name; sampler defaults (prod 0.1 / non-prod 1.0); invalid endpoint → Noop, not throw.
- `test/otel-redaction.test.ts` — bearer/`code`/`state`/email/body never in attrs/logs; session hash stability; truncation.
- `test/otel-wrap.test.ts` — tool span lifecycle incl. error status; upstream `traceparent` injected; exporter-down fail-open + overhead assertion.
- `test/otel-correlation.test.ts` — incoming `traceparent` continues trace; JSON log carries same `trace_id`; `RequestContext.requestId` reaches adapter (covers `http-stateless`-style harness).
- `test/otel-health.test.ts` — `/health` telemetry block present, secret-free in both modes.
- `scripts/otel-collector-smoke.ts` (new) — boots local `otelcol` mock, runs one stdio + one HTTP tool call, asserts traces+metrics+logs arrive with distinct `service.name` per slug.

Acceptance: `pnpm test`, `test:coverage` thresholds unchanged, `lint`, plus smoke against local collector. Dashboards/alerts out of scope for v1 (follow-up: Grafana/Azure JSON + `tool.error_rate`, `upstream.p99` alerts).

## 9. Rollout

1. Merge behind flag (off). CI: unit + local-collector smoke.
2. Enable dev 100% → verify backend receipt + sampling.
3. Staging 25%, prod 10% + keep-all-errors; confirm `<10ms` p99 and zero tool regressions.
4. Document in `README` + `.env.example`; note stdio requires OTLP push (no scrape) and `console.log` prohibition.

## 10. Open decisions (deferred, do not block spec)

- Tail-sampling rules beyond keep-errors (future collector config).
- nginx OTEL module vs `Mcp-Session-Id` log correlation (v2).
- Dashboard JSON + ACA alert rules (follow-up spec).
