# Common Semantic Intent Layer Implementation Plan

Date: 2026-10-02
Spec: `docs/superpowers/specs/2026-10-02-common-semantic-intent-layer-design.md`
Supersedes: `2026-10-02-semantic-intent-layer.md`

## Goal

Implement one stateless semantic intent module used by both local stdio and hosted Streamable HTTP/S. Keep the AWS OpenAPI MCP adapter for local raw-tool compatibility; make hosted semantic tools call TDEI REST directly with the bearer from each request.

## Delivery strategy

Ship vertical slices. The first useful release supports read intents, then file validation/upload. Do not move semantic policy into either transport while implementing an adapter.

Global acceptance rules:

- the client/LLM owns login, token refresh, conversation state, clarification state, and polling;
- the HTTP server receives and forwards an access token on every request, retaining none;
- common code imports no AWS MCP, HTTP transport, auth manager, or process singleton;
- both transports register the same semantic tool names, descriptions, input schemas, and result envelopes;
- raw AWS tools remain available in stdio;
- no mutation occurs from incomplete or ambiguous input;
- `npm test`, `npm run build`, and `npm run lint` pass after every slice.

## Slice 1: Define the stable domain boundary

Files:

- create `src/intents/types.ts`
- create `src/intents/operations.ts`
- create `src/intents/assets.ts`
- create `src/intents/place-resolver.ts`
- create `src/intents/semantic-intent-module.ts`
- create `test/intent-contracts.test.ts`

Steps:

- [ ] Define domain types for datasets, groups, services, jobs, searches, assets, metadata, evidence, and request context.
- [ ] Define `IntentResult<T>` with `complete`, `needs_input`, `ambiguous`, and `unsupported` states.
- [ ] Define the narrow `TdeiOperations`, `PlaceResolver`, and `DatasetAssetPort` interfaces from the design.
- [ ] Add an injectable clock/limits policy only if behavior needs it; do not read environment variables in the module.
- [ ] Construct `SemanticIntentModule` from those ports. It must hold configuration and adapters only, never request context or accepted user fields.
- [ ] Add compile/runtime tests that result envelopes contain no token field and are JSON serializable.

Checkpoint: fake ports can construct the module without MCP, AWS, HTTP, auth, or filesystem imports.

## Slice 2: Implement dataset discovery

Files:

- create `src/intents/dataset-discovery.ts`
- create `src/intents/descriptions.ts`
- create `test/dataset-discovery.test.ts`

Steps:

- [ ] Implement `findDatasets` with staged `name -> city -> forward geocode -> bbox` fallback.
- [ ] Always send explicit `sort_field=uploaded_timestamp`, `sort_order=desc`, `page_no=1`, and bounded `page_size` for “latest”.
- [ ] Add match evidence and effective query values to results.
- [ ] Return geocoder candidates as `ambiguous`; do not call TDEI bbox search until a single place is resolved.
- [ ] Treat 401/403 as fatal and stop the fallback chain.
- [ ] Add a static tool description with examples: “latest dataset for Seattle”, “find OSW data near Tacoma”, and “datasets in this bbox”.

Tests:

- [ ] name hit calls only name search;
- [ ] name miss then city hit never calls geocoder;
- [ ] two text misses then one place candidate calls bbox search;
- [ ] multiple place candidates return `ambiguous` and do not call bbox search;
- [ ] no results return `complete` with an empty list;
- [ ] auth errors stop immediately;
- [ ] singular/latest selects the first sorted result and preserves alternatives/evidence.

Checkpoint: “get me the latest dataset for Seattle” works against fake ports with no transport involved.

## Slice 3: Implement project-group and service intents

Files:

- modify `src/intents/semantic-intent-module.ts`
- modify `src/intents/descriptions.ts`
- create `test/catalog-intents.test.ts`

Steps:

- [ ] Implement `listServices` with `searchText`, `projectGroupId`, `serviceType`, and bounded pagination.
- [ ] Implement `listMyProjectGroups` as `unsupported` while the public API lacks a complete membership operation.
- [ ] Include the required backend capability in that result: `GET /api/v1/me/project-groups` or `include_my_groups=true` on project groups.
- [ ] Keep the explicitly different “groups represented by my accessible datasets” inference out of the membership tool unless exposed as an opt-in `incomplete` mode.
- [ ] Add descriptions that distinguish “all project groups” from “groups I belong to”.

Tests:

- [ ] services map every filter exactly and return applied filters;
- [ ] membership never calls `listProjectGroups` and mislabels all groups as the user's;
- [ ] membership never infers completeness from `include_my_groups` datasets.

Checkpoint: “get me the list of services” works; “what projects am I part of?” gives an honest, machine-readable capability gap.

## Slice 4: Add file and metadata preparation

Files:

- create `src/intents/upload-metadata.ts`
- create `src/adapters/local-file-assets.ts`
- create `src/adapters/hosted-assets.ts`
- vendor `schemas/tdei-upload-metadata.schema.json`
- create `test/upload-metadata.test.ts`
- create `test/dataset-assets.test.ts`

Steps:

- [ ] Vendor the canonical metadata schema and record its upstream repository/ref in a header or adjacent README.
- [ ] Derive/define the required-field questionnaire from the schema: target group/service, asset, data type, and the six required `dataset_detail` values.
- [ ] Return all missing fields in one `needs_input` response so the LLM can ask efficiently.
- [ ] Validate enum/date/version values and reject unknown metadata properties consistently with the schema.
- [ ] Implement `LocalFileAssets` with explicit path resolution, ZIP/file-size checks, and streaming reads.
- [ ] Implement `HostedAssets` with bounded inline base64 first; reject `local_path` in HTTP mode.
- [ ] Add an `object_ref` interface behind the port without selecting a storage provider yet.
- [ ] Read upload limits from the TDEI system-capabilities operation where available and impose a lower local request limit when required.
- [ ] Never log file bytes, base64 input, bearer tokens, or full metadata if it may contain sensitive custom values.

Checkpoint: both asset adapters produce the same `InspectedAsset`/`UploadBody` contract; neither stores pending conversational state.

## Slice 5: Implement validate and upload intents

Files:

- modify `src/intents/semantic-intent-module.ts`
- create `src/intents/dataset-mutations.ts`
- create `test/dataset-mutations.test.ts`

Operation maps:

```text
validate: osw -> validateOswFile
          flex -> validateGtfsFlexFile
          pathways -> validateGtfsPathwaysFile

upload:   osw -> uploadOswFile
          flex -> uploadGtfsFlexFile
          pathways -> uploadGtfsPathwaysFile
```

Steps:

- [ ] Implement `validateDataset`: missing asset/data type returns `needs_input`; complete input submits one multipart `dataset` field and returns the accepted job.
- [ ] Implement `uploadDataset`: inspect first, validate the metadata schema, resolve target requirements, and return every missing field without submitting.
- [ ] On a complete call, create the metadata JSON part plus dataset and optional changeset parts, then call the selected upload operation.
- [ ] Require the final call to contain all accepted answers. Do not accept an opaque server resume/session ID.
- [ ] Do not automatically publish after upload or validation.
- [ ] Implement `getJobStatus` as a single lookup; leave repeated polling to the client.

Tests:

- [ ] incomplete validation/upload makes zero mutation calls;
- [ ] suggestions are returned but never silently committed;
- [ ] each data type selects the correct validation and upload operation;
- [ ] multipart part names are exactly `dataset`, `metadata`, and optional `changeset`;
- [ ] accepted jobs include job ID/location;
- [ ] 401/403 and non-idempotent timeout handling remain errors, not retries.

Checkpoint: “validate this dataset” and “upload this dataset” form a stateless clarification loop and submit only when complete.

## Slice 6: Register common MCP tools

Files:

- create `src/intents/register-tools.ts`
- create `test/semantic-tools.test.ts`

Steps:

- [ ] Register all six initial tools from one function that receives an `McpServer`, semantic module, and request-context provider.
- [ ] Use static Zod schemas and descriptions so tool discovery does not require authentication or upstream discovery.
- [ ] Keep wrappers thin: validate MCP input, create request context, call the module, format the result.
- [ ] Use per-server deduplication (`WeakMap<McpServer, Set<string>>`) only if registration can repeat.
- [ ] Normalize errors through the existing response/error helpers without exposing tokens.
- [ ] Add an in-memory MCP test that snapshots tool names and verifies descriptions contain representative user phrases.

Checkpoint: any composition root can expose the semantic catalogue without knowing how each intent works.

## Slice 7: Implement and wire the stdio AWS adapter

Files:

- create `src/adapters/aws-result-decoder.ts`
- create `src/adapters/aws-tdei-operations.ts`
- modify `src/aws/aws-tools-lifecycle.ts`
- modify `src/server.ts`
- create `test/aws-tdei-operations.test.ts`
- update existing lifecycle/session tests

Steps:

- [ ] Map each `TdeiOperations` method to the exact AWS child operation ID and argument names.
- [ ] Centralize MCP content-envelope decoding in `aws-result-decoder.ts`; keep it out of intent code.
- [ ] Expose a version-gated call function and effective denied-operation check from `AwsToolsLifecycle` without registering semantic tools inside it.
- [ ] Compose the semantic module in the stdio server factory and register it independently from raw discovery.
- [ ] Keep raw AWS tools and local SSO helpers unchanged in stdio mode.
- [ ] Ensure an endpoint-filter denial produces a clear semantic dependency error rather than an empty result.

Checkpoint: existing local behavior is preserved and semantic tools call the same AWS child through a typed adapter.

## Slice 8: Implement the direct HTTP adapter

Files:

- create `src/adapters/http-tdei-operations.ts`
- create `src/adapters/tdei-http-error.ts`
- create `test/http-tdei-operations.test.ts`

Steps:

- [ ] Implement only the operations required by the semantic catalogue; avoid a generic untyped REST executor in the domain seam.
- [ ] Build query strings using the exact OpenAPI names and encode bbox arrays consistently with the API.
- [ ] Forward `Authorization: Bearer <request token>` for every authenticated TDEI call.
- [ ] Build multipart `FormData` without manually setting its boundary.
- [ ] Normalize 400, 401, 403, 404, 413, 429, and 5xx responses into typed adapter errors.
- [ ] Apply bounded timeouts; retry safe reads only, never upload/validate by default.
- [ ] Add fixture/contract tests for URL, headers, body parts, response normalization, and token isolation.

Checkpoint: hosted semantic calls no longer spawn `uvx` or an AWS MCP child.

## Slice 9: Split composition roots by deployment mode

Files:

- refactor `src/server.ts`
- modify `src/http.ts`
- modify `src/index.ts`
- optionally create `src/stdio-server.ts` and `src/http-server.ts`
- update `test/http-stateless.test.ts`
- update `test/session-lifecycle.test.ts`

Steps:

- [ ] Extract a common semantic-server registration function.
- [ ] stdio composition: local auth + AWS adapter + local assets + semantic tools + raw tools.
- [ ] HTTP composition: request bearer + direct HTTP adapter + hosted assets + semantic tools; omit local SSO/logout and raw AWS lifecycle.
- [ ] Continue creating an ephemeral MCP server and stateless Streamable HTTP transport per HTTP request.
- [ ] Validate the bearer at the boundary without storing or refreshing it.
- [ ] Remove `createAwsClient` from hosted runtime options after tests no longer need it.
- [ ] Ensure `tools/list` and `tools/call` behave consistently with a bearer on every request.

Tests:

- [ ] hosted request A cannot affect request B's token, adapter, accepted fields, or server catalogue;
- [ ] HTTP mode works when `uvx` is absent;
- [ ] stdio mode still discovers raw tools;
- [ ] common semantic tool schemas are equal across both factories;
- [ ] no `Mcp-Session-Id` is issued or required.

Checkpoint: one codebase has two clean composition roots, and hosted mode has no AWS runtime dependency.

## Slice 10: Forward geocoder adapter

Files:

- create `src/adapters/geocoder.ts`
- extend `src/config.ts`
- update `.env.example`
- create `test/geocoder.test.ts`

Steps:

- [ ] Select a provider through configuration and implement a small `PlaceResolver` adapter.
- [ ] Normalize provider results to label, bbox, confidence, and provider ID.
- [ ] Add timeout, user-agent/attribution, rate-limit, and cache rules permitted by the provider.
- [ ] Cache place results only; never include bearer/user identity in cache keys or values.
- [ ] Treat multiple plausible candidates as ambiguity.
- [ ] Document that geocoding is used only after TDEI name and city searches miss.

Checkpoint: Seattle falls through to bbox only when textual dataset searches find nothing.

## Slice 11: Packaging and deployment

Files:

- add `Dockerfile`
- add `.dockerignore`
- modify `package.json`
- modify `README.md`
- update `tdei.config.example.json` and schema only for new non-secret settings
- add CI/container smoke test

Steps:

- [ ] Keep `npx tdei-mcp --transport=stdio` as the local install.
- [ ] Publish a Node-only image whose command is `tdei-mcp --transport=http`; do not install `uvx`.
- [ ] Document HTTPS termination, CORS, request/file limits, health/readiness, bearer forwarding, and zero server session ownership.
- [ ] Document the hosted client configuration with the `/mcp` URL and per-request bearer.
- [ ] Add smoke tests for image startup, `tools/list`, read intent, missing bearer, and bad bearer.

Checkpoint: users choose either an npm/npx local setup or a hosted MCP URL from the same release.

## Slice 12: OpenAPI drift and live acceptance

Files:

- create `test/openapi-intent-contract.test.ts`
- optionally add `scripts/update-tdei-contract.ts`
- update `README.md`

Steps:

- [ ] Assert required operation IDs and parameters exist in the pinned OpenAPI fixture.
- [ ] Assert validation/upload multipart field requirements for all three data types.
- [ ] Assert vendored metadata required fields match the upstream schema during deliberate update runs.
- [ ] Run live dev acceptance with separate test tokens for isolation.
- [ ] Verify representative prompts through an MCP-capable client:
  - “get me the latest dataset for Seattle”;
  - “list OSW services in project group X”;
  - “validate this dataset”;
  - “upload this dataset” followed by clarification and resubmission;
  - “what project groups am I part of?” returns the documented capability gap until the API is extended.
- [ ] Record redacted transcripts and observed operation calls.

Checkpoint: tests detect API drift before a semantic intent silently changes meaning.

## Recommended implementation order

1. Slices 1–3: shared read-only core and honest membership behavior.
2. Slice 6, then 7: expose and prove the module in current stdio.
3. Slice 8, then 9: remove the AWS child from hosted runtime.
4. Slice 10: enable place-to-bbox fallback.
5. Slices 4–5: add bounded file handling and mutations after the transport seam is stable.
6. Slices 11–12: package, deploy, and lock contracts.

This order delivers natural-language reads early and delays the higher-risk file/mutation surface until token isolation and transport parity are established.

## External dependency

Complete project-group membership requires a public TDEI API capability. Track that separately and leave `tdei_list_my_project_groups` in the explicit `unsupported` state until the API contract is available. Do not block the other semantic intents on this endpoint.
