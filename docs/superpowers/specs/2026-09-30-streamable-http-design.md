# Issue #3 Design — Streamable HTTP transport, stateless, same SSO protocol

Date: 2026-09-30. Source: TaskarCenterAtUW/TDEI-MCP#3. Status: approved for implementation.

## 1. Goal

`TDEI_TRANSPORT=http` (or `--transport=http`) serves MCP over Streamable HTTP
exclusively — when HTTP runs, STDIO does not, and vice versa. Auth reuses the
same SSO protocol but stateless: every HTTP request carries
`Authorization: Bearer <access_token>`. No server sessions. Callback URL is
configurable to a registered `https` URL in HTTP mode.

Agreed decisions for v1 (from issue, user-confirmed):

- **Exclusive transport:** one process serves one transport only.
- **Callback:** configurable URL in HTTP mode.
- **Auth:** stateless Bearer per request.
- **Implementation approach:** per-request ephemeral full stack (approach A).
  Rejected: short-lived child cache (retains Bearers, breaks "no token
  retained"); stateful session server (server-side sessions are v2).
- **HTTP foundation:** Node built-in `http`, zero new dependencies — fastest to
  implement and deploy. SDK v2 `WebStandardStreamableHTTPServerTransport`
  converts to/from Web `Request`/`Response`.
- **Process isolation:** `src/http.ts` is a separate, self-contained module. It
  must not mingle with or infect the STDIO path: no shared mutable auth/AWS
  state, no side effects on import, STDIO behavior byte-identical when the flag
  is absent. `src/index.ts` contains only the exclusive startup branch.

## 2. Transport selection

- Env `TDEI_TRANSPORT=stdio|http` (default `stdio`); CLI `--transport=` overrides
  env. Convenience flags `--port`/`--host` override `TDEI_HTTP_PORT`/
  `TDEI_HTTP_HOST`.
- `src/index.ts` branches at startup: stdio → existing `serveStdio()` unchanged;
  http → dynamic `import("./http.js")` + `serveHttp()`, never both. The branch
  is the only HTTP knowledge allowed in `index.ts`. Static import of `http.ts`
  is forbidden so STDIO startup never loads HTTP code (and vice versa at the
  process level: only one server function ever runs).
- New env: `TDEI_HTTP_HOST` (default `127.0.0.1`), `TDEI_HTTP_PORT` (default
  `3000`), `TDEI_HTTP_BASE_PATH` (default `/mcp`), `TDEI_CORS_ORIGINS` (empty =
  same-origin only), `TDEI_TLS_CERT`/`TDEI_TLS_KEY` (absent = plain HTTP;
  document reverse-proxy TLS termination for public `https`).
- Log `[tdei-mcp] Serving MCP (http) on <host>:<port><path>` to stderr. Keep
  stdout reserved.

## 3. Stateless auth (same protocol, no sessions)

1. Middleware extracts `Authorization: Bearer <access_token>`. Missing → `401`
   with `{code: "TDEI_SSO_REQUIRED", loginUrl}` so the client can call
   `tdei_sso_login`.
2. Per-request ephemeral `AuthManager` via new `injectAccessToken(token)`
   factory — never mutates the STDIO singleton, stores nothing across requests.
   Validate with existing expiry logic (2-min safety window,
   `src/auth/auth-manager.ts:11-13`) plus a lightweight direct TDEI fetch probe.
   Bad Bearer fails fast without spawning a child.
3. Expired or invalid Bearer → `401` with `refresh_hint`. Client refreshes
   itself via the existing `POST /api/v1/refresh-token` or re-runs SSO login.
   Server never holds `refresh_token` in stateless v1, so it cannot refresh on
   the client's behalf — document this.
4. Valid Bearer → ephemeral `AwsMcpClient(tokenProvider)` for that request only,
   forwarded to `callTool`/`listTools`, then `close()` immediately (in
   `finally`) after the response to avoid child leaks.
5. `Mcp-Session-Id` is echoed for SSE stream routing only, never used for auth.
6. `tdei_sso_login`, `tdei_auth_status`, `tdei_logout` remain as tools but act as
   stateless adapters: login returns `loginUrl` built with the configured
   callback (no local loopback listener in HTTP mode); status validates the
   request Bearer; logout returns `logoutUrl` and instructs the client to drop
   the token (server has nothing to clear).
7. Acceptance proof is end-to-end: a valid Bearer serves `tools/list` and a
   `listServices` call; a second request with a different Bearer cannot see the
   first token's state.

## 4. Configurable callback (HTTP mode only)

- Relax the `src/config.ts:45` validator when `TDEI_TRANSPORT=http`: allow any
  `https://` URL plus `http://127.0.0.1/` for local dev, provided it matches
  the backend-registered `redirect_uri` for the `client_id`. STDIO keeps the
  strict loopback check.
- Document that the chosen callback must be pre-registered for the `tdei-mcp`
  client or SSO returns 400.

## 5. Scope (files)

- `src/config.ts`: transport, HTTP host/port/path, CORS, TLS env plus
  bifurcated callback validator.
- `src/auth/auth-manager.ts`: `injectAccessToken()` + `validateToken()` without
  singleton side effects. Singleton export untouched for STDIO.
- `src/aws/aws-mcp-client.ts`: optional constructor `tokenProvider` (defaults
  to singleton path); guarantee `close()` on stateless path.
- New `src/http.ts`: self-contained HTTP entry — Node `http` server,
  `WebStandardStreamableHTTPServerTransport` wiring (`sessionIdGenerator:
  undefined`) for `POST {basePath}` and `GET {basePath}` SSE, Bearer
  middleware, per-request `createServer({authManager: ephemeral, awsMcpClient:
  ephemeral})`, CORS, 401 envelope, graceful shutdown. Imports from
  `index.js` (`createServer`) and `auth/aws` modules only; no globals, no
  module-level listeners, no mutation of STDIO singletons.
- `src/index.ts`: exclusive transport branch only (dynamic import).
- Tests: new `test/http-stateless.test.ts` — no-token 401, bad Bearer 401, good
  Bearer lists and calls, two sequential requests with different Bearers
  isolated, expired Bearer 401 without refresh attempt, callback validator
  accepts `https` in http mode and rejects it in stdio mode. Mocked fetch +
  stubbed AWS child; no live TDEI.
- Docs: README HTTP section with run command and curl example (indented, not
  fenced, to survive paste):

  node --env-file=.env dist/index.js --transport=http --port 3000

  curl -i -X POST http://127.0.0.1:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer <token>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

  `.env.example` documents the new variables.

## 6. Error handling, CORS, shutdown

- 401 envelope: `{code: "TDEI_SSO_REQUIRED" | "TDEI_TOKEN_INVALID" |
  "TDEI_TOKEN_EXPIRED", message, loginUrl?, refresh_hint?}` naming
  `tdei_sso_login` remediation; no token retained on the server.
- CORS: reflect origin only if listed in `TDEI_CORS_ORIGINS`, else same-origin
  only.
- Path/method misses → 404/405 JSON-RPC errors. Child spawn failures → 502 with
  `tdei_load_api_tools` hint.
- Graceful shutdown on SIGINT/SIGTERM: stop accepting, drain in-flight, close
  children, exit.

## 7. Acceptance criteria

- STDIO behavior unchanged when flag is absent.
- HTTP mode serves no STDIO; STDIO mode opens no port. `http.ts` importable
  without side effects on the STDIO path.
- `tools/list` and `listServices` succeed with a valid Bearer; a second request
  with a different Bearer cannot see the first token's state.
- Missing, bad, or expired Bearer returns 401 naming `tdei_sso_login`
  remediation; no token retained on the server.
- Remote browser SSO completes with the configured `https` callback.
- `npm test` and `npm run build` green.

## 8. Out of scope

- No NPX UX changes (Issue #1), no filtering or workflows (Issue #2).
- No server-side sessions, refresh-token vaulting, globs, or multi-tenant
  hosting — all v2.
- No auto-provisioned TLS — plain HTTP locally, reverse-proxy TLS in
  production.
- No child pooling/caching — per-request spawn cost is the accepted v1
  trade-off.

## 9. References

- `src/index.ts:263-271` (STDIO entry; branch point)
- `src/config.ts:1-54`, `.env.example:1-6`
- `src/auth/auth-manager.ts:57-176,240-261`
- `src/aws/aws-mcp-client.ts:48-124`
- `src/aws/register-aws-tools.ts:29-115`
- `package.json:25-29` (`@modelcontextprotocol/server@^2.0.0`;
  `WebStandardStreamableHTTPServerTransport`, stateless via
  `sessionIdGenerator: undefined`)
