# Hosting the AWS OpenAPI MCP server: open-source options

Research snapshot: 2026-10-02

## Executive conclusion

For TDEI, a generic stdio-to-HTTP bridge solves only the transport conversion. It does **not** by itself solve the harder requirement: each remote user must invoke the TDEI API with the correct user identity and no credential leakage across users.

The best near-term choice is to keep the HTTP adapter already in this repository and replace its "one AWS child per HTTP request" behavior with a bounded, idle-evicted pool keyed by validated user identity/token version. The code already performs TDEI token validation, builds the same curated tool surface as local stdio mode, and gives every request a fresh outer MCP server. Those TDEI-specific behaviors would have to be rebuilt around any generic bridge.

The best adoption candidate for a deliberate replacement is [agentgateway](https://github.com/agentgateway/agentgateway), not a stdio bridge. It can expose an OpenAPI document directly as MCP, supports Streamable HTTP, stdio and HTTP upstreams, validates JWT/OAuth, can pass a validated JWT or exchange it for a backend token, and has standalone and Kubernetes deployments. A proof of concept could remove both the AWS child and most of `src/http.ts`. It must first prove parity on the live TDEI specification, tool names/descriptions, draft-04 schema quirks, uploads, and TDEI's token/audience model.

For a quick single-tenant demo, [Supergateway](https://github.com/supercorp-ai/supergateway) is the simplest wrapper. It is not a production multi-user identity solution. [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) has the same limitation. [mcp-stdio](https://github.com/shigechika/mcp-stdio) has much better session and user isolation, but it cannot directly turn each caller's TDEI access token into the `AUTH_TOKEN` of the AWS child. [IBM ContextForge](https://github.com/IBM/mcp-context-forge) is a capable enterprise gateway, but is substantially more platform than TDEI currently needs and still uses a separate translate/bridge process for stdio children.

## The TDEI-specific constraint

AWS Labs' OpenAPI MCP server still advertises [stdio as its only transport](https://github.com/awslabs/mcp/blob/main/src/openapi-mcp-server/README.md), and its request for native Streamable HTTP support [remains an open issue](https://github.com/awslabs/mcp/issues/2350). It accepts its upstream API credential at process startup through `--auth-token` or `AUTH_TOKEN`. Therefore a shared AWS child is also a shared TDEI identity.

That yields three safe process models:

1. A fresh AWS process for every MCP request, which is what this repository currently does.
2. One AWS process per validated TDEI user/token, with bounded reuse and eviction.
3. No AWS process: convert OpenAPI operations to MCP tools in the HTTP gateway itself and attach the user's upstream credential per call.

A single long-lived AWS process for all hosted users is unsafe because its bearer is fixed at startup. A generic bridge that starts one configured child has the same problem.

There is also an authorization-boundary issue to resolve before a public launch. MCP's official security guidance defines accepting a client token for another resource and forwarding it unchanged as the [token-passthrough anti-pattern](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx). The current HTTP mode accepts a TDEI API bearer, validates it, and forwards it to the TDEI API through AWS. This is pragmatic identity propagation, but it is MCP-spec compliant only if the token's intended resource/audience and the MCP resource are designed accordingly. The standards-aligned hosted design is:

- authenticate the MCP client to the MCP resource with an audience-bound token;
- bind the authenticated MCP principal to a separately obtained TDEI credential; and
- use OAuth token exchange or a server-owned TDEI SSO flow instead of treating the TDEI API token as the MCP server token.

Agentgateway supports backend OAuth token exchange. ContextForge supports per-caller OAuth tokens and token exchange. If TDEI's authorization server cannot issue/exchange distinct tokens, the existing validated propagation can remain an explicit interim design, but it should be recorded as a security exception rather than hidden inside a transport decision.

## Comparison

| Project | License | stdio -> Streamable HTTP | Inbound auth / multi-user isolation | Per-user TDEI bearer into AWS child | Deployment / scale | TDEI verdict |
|---|---|---:|---|---|---|---|
| Existing TDEI-MCP | No repository license declared | Yes | Validates each TDEI bearer; one child per request | Yes | Docker exists; high cold-start cost | **Keep and harden now** |
| [Supergateway](https://github.com/supercorp-ai/supergateway) | [MIT](https://raw.githubusercontent.com/supercorp-ai/supergateway/main/LICENSE) | Yes, stateful or stateless | No documented inbound OAuth/JWT validator or identity-to-child credential mapping | Static command/config only | Official Docker/uvx images; session timeout; recent v4.0.0 | Demo/single tenant only |
| [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) | [MIT](https://raw.githubusercontent.com/sparfenyuk/mcp-proxy/main/LICENSE) | Yes | No documented inbound bearer validation or per-user child credential binding | Static command/environment only | PyPI, GHCR/Docker Hub, named servers | Demo or private network only |
| [mcp-stdio](https://github.com/shigechika/mcp-stdio) | [MIT](https://raw.githubusercontent.com/shigechika/mcp-stdio/main/LICENSE) | Yes (`serve`) | Static bearer or embedded OAuth; one child per session; OAuth sessions bound to user | No direct original-token-to-`AUTH_TOKEN` mapping | Session caps, idle TTL, durable token store | Good bridge, but needs TDEI auth adapter |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) (`mcpgateway`) | [Apache-2.0](https://raw.githubusercontent.com/IBM/mcp-context-forge/main/LICENSE) | Via separate `mcpgateway.translate` bridge | JWT, OIDC/SSO, teams, RBAC, per-server OAuth, token exchange | Possible only with deliberate upstream credential mapping/bridge design | Docker, Compose, Helm/Kubernetes, Redis/HA; operationally large | Adopt only if enterprise gateway features are required |
| [agentgateway](https://github.com/agentgateway/agentgateway) | [Apache-2.0](https://github.com/agentgateway/agentgateway/blob/main/LICENSE) | Yes; also direct OpenAPI -> MCP | MCP OAuth/JWT, CEL authorization, API keys, rate limits; backend token passthrough/exchange | Direct OpenAPI path avoids AWS child | Standalone binary/container and Kubernetes/Helm | **Best replacement PoC** |

## Project findings

### 1. Supergateway

Supergateway v4.0.0 can publish a stdio process at `/mcp` using current Streamable HTTP, in stateless or stateful mode, with child session timeout and current/legacy MCP protocol compatibility. The [README documents the bridge, Docker images and uvx-equipped image](https://github.com/supercorp-ai/supergateway#stdio--streamable-http); the [v4.0.0 release](https://github.com/supercorp-ai/supergateway/releases/tag/v4.0.0) reports newer MCP protocol support, subprocess cleanup improvements and a six-hour soak test.

Its `--oauth2Bearer` and `--header` flags are header configuration, not a complete inbound multi-user authorization system. The [CLI source](https://github.com/supercorp-ai/supergateway/blob/main/src/index.ts) has no issuer/JWKS/audience validation or mapping of an authenticated caller to a distinct child environment. Wrapping the AWS server would therefore give either:

- one shared TDEI token in the command/environment; or
- a child lifecycle that is isolated by MCP session but not provisioned with that session user's TDEI credential.

This makes Supergateway excellent for validating remote-client compatibility with a service account, but not the production TDEI user model. It also leaves the TDEI-specific schema sanitation, tool filtering, workflows, errors and SSO behaviors outside the bridge.

### 2. `sparfenyuk/mcp-proxy`

`mcp-proxy` supports both directions between stdio and SSE/Streamable HTTP. Its [README and CLI reference](https://github.com/sparfenyuk/mcp-proxy/blob/main/README.md) document stateful/stateless HTTP server mode, multiple named stdio servers, CORS, PyPI installation, multi-architecture container images and Docker Compose.

The available server options do not document inbound JWT/OAuth validation, tenant identity, session ownership, dynamic request-header-to-child-secret mapping, or a bounded per-user process pool. Its OAuth client flags apply when the proxy connects *outward* to a remote HTTP MCP server. It is therefore in the same TDEI category as Supergateway: useful behind a trusted private boundary with a shared credential, but insufficient as the public identity boundary.

### 3. `shigechika/mcp-stdio`

`mcp-stdio serve` is the strongest purpose-built stdio publisher in this group. The [official README](https://github.com/shigechika/mcp-stdio#reverse-gateway-serve-mode) documents current Streamable HTTP, optional static bearer or embedded OAuth 2.1, one backend child per MCP session, user binding that prevents a leaked session ID crossing tenants, concurrent-session limits, per-owner caps, idle eviction, request-size limits, and token persistence.

Its multi-user mode delegates login to a trusted reverse proxy and can inject the authenticated principal into a child with `--user-env`. It does not document injecting the actual, validated upstream access token into a unique environment variable for the AWS child. Supplying only a user name is insufficient because AWS needs `AUTH_TOKEN`. A small TDEI credential broker/wrapper would still be required, which moves the most sensitive part back into custom code.

This is worth reconsidering if the TDEI authentication model changes to server-side token storage keyed by principal: `mcp-stdio` could then own transport/session/process mechanics while a narrow wrapper resolves a principal to a TDEI credential.

### 4. IBM ContextForge / MCP Gateway

ContextForge is a broad gateway, registry and management plane rather than a thin stdio wrapper. Its [README](https://github.com/IBM/mcp-context-forge) documents MCP/REST/gRPC federation, centralized governance, plugins and observability. Its [security documentation](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/security-features.md) covers JWT enforcement, per-server OAuth, OIDC providers, scoped credentials, teams/RBAC, header controls, audit and policy plugins. The project reached GA in 2026 and [v1.0.11](https://github.com/IBM/mcp-context-forge/releases/tag/v1.0.11) moved to MCP SDK 2.x with opt-in modern protocol negotiation.

ContextForge gateways themselves are network endpoints. For a stdio child, the official workflow is to run a separate [`mcpgateway.translate --stdio ... --expose-streamable-http`](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/using/mcpgateway-translate.md) process and register its HTTP URL in ContextForge. That means at least two additional runtime layers around AWS.

ContextForge is a sensible front door if TDEI needs team administration, catalog/registry, per-tool policy, audit, plugins, several upstream MCP servers, or multi-cluster operations. It is excessive if the only goal is one TDEI API exposed over stdio and HTTPS. It also does not eliminate the need to decide how a gateway identity becomes the upstream TDEI credential.

### 5. Agentgateway

Agentgateway is a Linux Foundation project that supports MCP federation, stdio/HTTP/SSE/Streamable HTTP, direct OpenAPI integration, OAuth/JWT, CEL tool authorization, rate limiting, TLS and OpenTelemetry. These claims and the Apache-2.0 license are in its [official repository](https://github.com/agentgateway/agentgateway). The [v1.4.0 release](https://github.com/agentgateway/agentgateway/releases/tag/v1.4.0) adds MCP 2026-07-28 support, enterprise-managed authorization and OAuth token exchange, and publishes standalone/Kubernetes images and Helm charts.

For TDEI, its important capability is an MCP target whose source is an OpenAPI schema rather than another MCP process. A maintainer-answered [configuration discussion](https://github.com/agentgateway/agentgateway/discussions/3032) shows separate MCP routes backed directly by OpenAPI schemas with tool authorization. Its [backend authentication documentation](https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/backend-authn/key/) supports a static backend key, passing through a JWT already validated by route policy, or placing a credential in another header/query/cookie. Version 1.4 also supports token exchange to obtain a distinct backend credential.

That architecture can be:

```text
AI client -> HTTPS Streamable MCP -> agentgateway -> TDEI REST API
                    JWT/OAuth          OpenAPI tools + per-call auth
```

It removes Python/uvx cold starts and process pooling. The migration risk is OpenAPI conversion parity. The current connector has a TDEI-specific workaround for draft-04 boolean `exclusiveMinimum`/`exclusiveMaximum`, hides connector-managed auth operations, applies endpoint filters, normalizes errors and truncates output. These need tests against agentgateway rather than assumptions.

Agentgateway's OpenAPI binary-body support is evolving. Its issue history shows [raw `application/octet-stream` support was added while multipart was explicitly a separate follow-up](https://github.com/agentgateway/agentgateway/issues/2304). Consequently it should not be selected until a real TDEI upload endpoint passes end to end.

### 6. A promising design reference that is not currently adoptable

[`elad-bar/mcp-streamable-http-bridge`](https://github.com/elad-bar/mcp-streamable-http-bridge) maps `x-<ENV>` headers to child environments, hashes resolved environments to reuse a process per tenant, and implements idle eviction and Prometheus metrics. This is close to the process model TDEI needs because AWS accepts `AUTH_TOKEN` via the environment.

However, the repository has only a handful of commits, no releases, and its README explicitly says to add a license; there is no license file. Publicly readable source is not automatically open-source software. It should be treated as a design reference, not a dependency, unless the owner adds an acceptable license and the security model receives review.

## What the existing repository already provides

The hosted path in [`src/http.ts`](../../src/http.ts) is a real Streamable HTTP server, not the obsolete two-endpoint HTTP+SSE transport. It:

- requires a bearer on every MCP request;
- validates that bearer with TDEI;
- creates an ephemeral auth adapter that cannot refresh or retain the token;
- builds the same outer `McpServer` and tool surface as stdio mode; and
- closes the MCP transport, outer server and AWS process after the response.

[`src/aws/aws-mcp-client.ts`](../../src/aws/aws-mcp-client.ts) starts AWS with the request's TDEI bearer, while [`src/aws/register-aws-tools.ts`](../../src/aws/register-aws-tools.ts) sanitizes schemas, hides conflicting auth tools, filters operations, preserves result shape and normalizes failures.

This is secure by process lifetime but expensive. A natural-language request commonly causes an initialize/list-tools exchange followed by several tool calls; every HTTP JSON-RPC request currently pays Python/uvx startup, spec loading and tool discovery again.

The code also needs normal production HTTP controls that no stdio wrapper removes:

- validate `Host` and `Origin` consistently, not just CORS allowlisting;
- impose request-body, concurrency and per-principal limits;
- set explicit child startup/call deadlines and kill escalation;
- avoid logging bearer values or raw token-derived pool keys;
- expose readiness separately from liveness;
- terminate TLS at a trusted proxy/load balancer and accept forwarding headers only from it;
- record protocol version compatibility, especially because the [2026-07-28 transport](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/draft/basic/transports/streamable-http.mdx) removed protocol-level sessions and GET/DELETE from the modern form while retaining legacy fallback; and
- design MCP-resource OAuth separately from TDEI-upstream OAuth.

## Recommended path

### Immediate: improve the code already here

Keep local stdio unchanged. For hosted HTTP:

1. Cache the sanitized tool catalog independently of user credentials. Tool discovery is based on the OpenAPI specification, not the caller.
2. Replace per-request AWS creation with a bounded `AwsChildPool` keyed by a non-reversible digest of a validated identity plus token version/expiry. Never key logs or metrics by raw tokens.
3. Give entries an idle TTL, absolute lifetime, per-user cap and global cap. Deduplicate concurrent creation for the same key. Evict/close on token expiry, logout, child failure and shutdown.
4. Serialize calls only when the AWS child requires it; allow different users' children to run concurrently.
5. Put a small rate/concurrency limiter before child acquisition so attackers cannot turn bearer validation into unbounded process creation.
6. Add the HTTP/OAuth security controls listed above.

This preserves the already-tested AWS tool generation and TDEI-specific behavior while removing most cold starts.

### Parallel proof of concept: agentgateway direct OpenAPI

Run a time-boxed parity test using the same TDEI spec and these acceptance cases:

- `tools/list` starts without per-user subprocesses and tool names/descriptions match the current connector closely enough for existing prompts;
- "What project groups do I belong to?" works with two simultaneous users and returns no cross-user data;
- "Get the latest dataset for Seattle" can perform the required sequence of tool calls;
- TDEI JWT issuer, audience, expiry and scopes are validated, or a distinct MCP token is exchanged for a TDEI token;
- endpoint allow/deny policy is expressible;
- draft-04 schema constructs do not drop or corrupt tools;
- large results, downloads, rate limits, cancellation and timeouts behave acceptably; and
- at least one real multipart upload works, or the upload limitation is explicit.

Adopt agentgateway only if that test passes. Otherwise the existing adapter remains the smaller and more controllable system.

### Add ContextForge only for a platform requirement

Do not add ContextForge merely to convert transport. Add it if TDEI later needs a shared organizational gateway with catalog, teams/RBAC, multi-upstream federation, policy plugins, centralized audit and multi-cluster operations. It can front either the hardened TDEI-MCP HTTP service or an agentgateway deployment.

## Uploads and downloads are a separate design problem

None of these gateways automatically makes an OpenAPI multipart operation agent-friendly. MCP tool arguments and Streamable HTTP frames are JSON; relaying large datasets as base64 bloats memory and request size. The current workflow runner explicitly rejects multipart operations, and AWS's documented feature list does not promise a hosted large-file channel.

For TDEI datasets, prefer explicit domain tools:

- `create_upload` returns a short-lived, single-purpose object-storage upload URL and expected metadata/checksum;
- the client or an approved file-transfer component uploads bytes directly;
- `complete_upload` validates checksum/size and starts ingestion;
- `get_download` returns a short-lived download URL or MCP resource link rather than embedding a large binary response; and
- processing uses job IDs plus poll/status tools.

If target clients cannot execute the out-of-band upload, provide a dedicated bounded multipart endpoint/tool with strict size, MIME, checksum, malware scanning and storage quotas. Test this independently of the gateway choice.

## Decision

Use the current repository as the production candidate for now, with per-user/token child pooling and a standards-aware OAuth redesign. Use Supergateway only for a quick static-token demonstration. Run an agentgateway direct-OpenAPI PoC before investing much more in custom process management. Do not introduce ContextForge until governance/multi-upstream requirements justify its operating cost.

Context Harbor's project MCP tools were not available in the research worker session, so this note is based on checked-in source plus the primary project/specification sources linked above. No project requirements were inferred beyond the stated local-stdio, hosted-HTTPS, multi-user TDEI and future agent upload/download goals.
