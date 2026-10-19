# Reusing the OpenAPI MCP core

The `tdei-mcp/openapi` entry point converts an OpenAPI 3.x document into MCP
tools and serves the resulting server over local stdio or stateless Streamable
HTTP. It has no dependency on TDEI authentication or configuration.

## Separate server for another specification

Install `tdei-mcp` as a dependency and create a small entry point:

```ts
#!/usr/bin/env node
import {
  bearerHeadersForRequest,
  serveOpenApiHttp,
  serveOpenApiStdio,
  type OpenApiMcpServerOptions,
} from "tdei-mcp/openapi";

const options: OpenApiMcpServerOptions = {
  name: "customer-api-mcp",
  version: "1.0.0",
  specUrl: "https://customers.example.com/openapi.json",
  apiUrl: "https://customers.example.com",
  toolPrefix: "customer_",
  excludeOperations: new Set(["customer_internal_delete_all"]),
};

if (process.env.MCP_TRANSPORT === "http") {
  await serveOpenApiHttp(options, {
    host: process.env.MCP_HOST ?? "127.0.0.1",
    port: Number(process.env.MCP_PORT ?? 3100),
    basePath: "/mcp",
    headersForRequest: bearerHeadersForRequest,
  });
} else {
  const token = process.env.CUSTOMER_API_TOKEN;
  if (!token) throw new Error("CUSTOMER_API_TOKEN is required");
  await serveOpenApiStdio({
    ...options,
    headersProvider: async () => ({ Authorization: `Bearer ${token}` }),
  });
}
```

STDIO credentials normally come from environment variables or a local OAuth
session. HTTP credentials should be derived independently for every MCP request
with `headersForRequest`; the built-in `bearerHeadersForRequest` forwards the
incoming Bearer value without sharing it between requests.

## Configuration hooks

`OpenApiMcpServerOptions` supports:

- `toolPrefix` to avoid collisions when several specifications share a host.
- `includeOperations`, `excludeOperations`, and `hiddenOperations`, applied to
  final MCP tool names after normalization and prefixing.
- `headersProvider` for API keys, Bearers, or other upstream request headers.
- `allowLocalFileUploads`, disabled by default, for trusted local stdio servers
  that intentionally accept absolute paths for binary multipart fields.
- `executeOperation` for binary downloads, unusual serialization, retries, or
  operations that should bypass the generic executor.
- `configure` to register curated tools, resources, or prompts on the same
  `McpServer`.
- `mapResult` and `mapError` to enforce product-specific result and error
  contracts.
- `loadSpec` and `fetchImpl` for embedded documents and deterministic tests.

HTTP mode dereferences the specification once per listening server, then creates
an ephemeral MCP server per request so credentials and MCP state cannot leak
between users. Request bodies default to a 1 MiB limit; configure
`maxRequestBytes` when a host requires a different MCP envelope limit.
Custom `headersForRequest` implementations should throw
`OpenApiAuthenticationError` for expected credential failures; unexpected
errors are reported as server failures rather than being mislabeled as 401s.

## Hosting several specifications together

Prefer separate MCP endpoints for unrelated APIs. This keeps credentials,
permissions, failures, and tool catalogues isolated. If the APIs form one
coherent domain, call `registerOpenApiTools` for multiple providers on one
`McpServer` and give every provider a unique prefix.

## Known edge cases requiring an adapter

The generic executor intentionally covers the common OpenAPI subset. Supply an
`executeOperation` adapter or a curated tool when an API relies on:

- binary response bodies—the generic executor returns text; stream downloads to
  a file or object store instead;
- OpenAPI parameter styles other than ordinary form-style query arrays and
  scalar path/header/cookie parameters (`deepObject`, matrix, label, and custom
  `explode` behavior need explicit serialization);
- multiple alternative request media types selected dynamically—the executor
  chooses JSON, multipart, URL-encoded, text, then the first declared type;
- callbacks, webhooks, links, or operations without an `operationId` (they are
  not exposed as tools);
- normalized or prefixed operation-name collisions;
- automatic interpretation of `securitySchemes`; credentials are deliberately
  supplied by `headersProvider` or `headersForRequest` instead;
- very large or streaming JSON/text responses; product code should cap,
  paginate, truncate, or stream them;
- OpenAPI response schemas and MCP `structuredContent`; the generic executor
  currently returns text content containing JSON rather than deriving output
  schemas;
- remote HTTP uploads from client-local paths. Do not accept arbitrary server
  filesystem paths from remote callers; use an inline or object-storage asset
  contract instead;
- upstream-specific retry, rate-limit, idempotency, audit, or OAuth refresh
  policies.

Treat the configured specification URL and all external `$ref` targets as
trusted operator configuration: dereferencing can perform network reads.
