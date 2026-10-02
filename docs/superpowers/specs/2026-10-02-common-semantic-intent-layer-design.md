# Common Semantic Intent Layer Design

Date: 2026-10-02
Status: approved direction; ready for implementation planning
Supersedes: `2026-10-02-semantic-intent-layer-design.md`

## 1. Outcome

TDEI-MCP will ship one transport-independent semantic intent module and two deployment adapters:

```text
AI client / LLM
      |
      | selects a well-described MCP tool
      v
semantic intent module (shared, deterministic, stateless)
      |
      +-- TdeiOperations port ---- AWS OpenAPI MCP adapter (local stdio)
      |                         `-- direct TDEI HTTP adapter (hosted HTTP/S)
      +-- PlaceResolver port ----- forward geocoder
      `-- DatasetAsset port ------ local file / hosted asset reference
```

The same semantic tools and behavior are exposed over:

- local stdio: installed with npm/npx; keeps the existing AWS OpenAPI MCP child for raw API access;
- hosted Streamable HTTP/S: deployed as a container/service; calls TDEI REST directly and does not require `uvx` or the AWS MCP child at runtime.

The hosted server does not own login sessions. The client sends `Authorization: Bearer <access_token>` on every MCP request. The token is request-scoped, passed to the adapter, never persisted, refreshed, or shared by the server.

## 2. Semantic recognition boundary

No server-side classifier or LLM is required. The client LLM recognizes intent by selecting from a small set of MCP tools with explicit descriptions and schemas. The common module performs deterministic fulfillment after selection.

This keeps the contract observable and testable:

- tool descriptions explain when a tool applies, including natural-language examples;
- Zod schemas capture entities the LLM can extract, such as place, dataset type, project group, service, and metadata;
- domain code implements fallback order, validation, ambiguity, and missing-input behavior;
- adapters translate domain operations to AWS MCP calls or HTTP requests.

Raw OpenAPI tools remain useful for advanced access, but normal user requests should select the curated `tdei_*` tools.

## 3. Common module

Create a deep module under `src/intents/`:

```text
src/intents/
  types.ts                 public inputs, outputs, and result states
  operations.ts            narrow TdeiOperations interface
  assets.ts                DatasetAsset interface
  place-resolver.ts        PlaceResolver interface
  dataset-discovery.ts     name -> city -> bbox search policy
  upload-metadata.ts       metadata schema and missing-field questions
  semantic-intent-module.ts
  descriptions.ts          static LLM-facing tool descriptions
  register-tools.ts        thin MCP registration only
```

Adapters live outside the module:

```text
src/adapters/
  aws-tdei-operations.ts
  http-tdei-operations.ts
  aws-result-decoder.ts
  local-file-assets.ts
  hosted-assets.ts
  geocoder.ts
```

The module may depend on the following ports, but never on an MCP transport, `McpServer`, AWS response envelopes, `fetch`, process environment, or authentication manager:

```ts
interface RequestContext {
  accessToken?: string;
  requestId?: string;
}

interface TdeiOperations {
  searchDatasets(input: DatasetSearch, context: RequestContext): Promise<Dataset[]>;
  listProjectGroups(input: ProjectGroupSearch, context: RequestContext): Promise<ProjectGroup[]>;
  listServices(input: ServiceSearch, context: RequestContext): Promise<Service[]>;
  validateDataset(input: ValidationSubmission, context: RequestContext): Promise<AcceptedJob>;
  uploadDataset(input: UploadSubmission, context: RequestContext): Promise<AcceptedJob>;
  getJob(input: JobLookup, context: RequestContext): Promise<Job>;
}

interface PlaceResolver {
  forwardGeocode(place: string): Promise<PlaceCandidate[]>;
}

interface DatasetAssetPort {
  inspect(asset: DatasetAsset, context: RequestContext): Promise<InspectedAsset>;
  open(asset: DatasetAsset, context: RequestContext): Promise<UploadBody>;
}
```

The interfaces use typed domain values. Decoding the AWS MCP content envelope belongs in `aws-result-decoder.ts`; building ordinary HTTP URLs, query strings, bearer headers, and read errors belongs in `http-tdei-operations.ts`. Multipart validation/upload is shared by both transports in `direct-multipart-tdei-mutations.ts`: stdio supplies its current local SSO token and local file assets, while HTTP supplies the bearer from the current request and bounded inline assets.

## 4. Stateless result protocol

Each semantic tool returns one of four explicit states:

```ts
type IntentResult<T> =
  | { status: "complete"; data: T; evidence?: Evidence[] }
  | { status: "needs_input"; missing: MissingInput[]; accepted: Record<string, unknown> }
  | { status: "ambiguous"; candidates: Candidate[]; accepted: Record<string, unknown> }
  | { status: "unsupported"; reason: string; requiredCapability?: string };
```

`accepted` contains only non-secret input that the caller may resend. It is not a server-side resume token. The LLM/client owns the conversation and resubmits previous answers with the next call.

Rules:

- no pending-intent map, cookies, MCP session state, database row, or in-memory conversation state;
- no access or refresh token in tool output, logs, `accepted`, caches, or thrown messages;
- authentication failures are fatal errors, never converted into empty or partial results;
- `needs_input` is a normal result, not an exception;
- mutations require an explicit final tool call containing every required value;
- ambiguous place or target selection is never silently resolved.

Tool descriptions tell the client LLM to ask the user the returned questions and repeat the call with the accumulated non-secret fields.

## 5. Initial semantic tool catalogue

Keep the catalogue small and task-oriented:

| Tool | Natural-language examples | TDEI operations |
|---|---|---|
| `tdei_find_datasets` | “Find Seattle datasets”; “latest OSW dataset for Seattle” | `listDatasetFiles` |
| `tdei_list_my_project_groups` | “What project groups am I part of?” | new membership capability required; see §6.2 |
| `tdei_list_services` | “List services”; “OSW services in this project group” | `listServices` |
| `tdei_validate_dataset` | “Validate this dataset” | `validateOswFile`, `validateGtfsFlexFile`, `validateGtfsPathwaysFile` |
| `tdei_upload_dataset` | “Upload this dataset” | `uploadOswFile`, `uploadGtfsFlexFile`, `uploadGtfsPathwaysFile` |
| `tdei_get_job_status` | “Did that validation/upload finish?” | job lookup operation |

Download and publish can be added later using the same ports. The raw tools remain available in stdio for operations not yet represented semantically.

## 6. Intent behavior

### 6.1 Find datasets, including “latest dataset for Seattle”

Input includes `place`, optional `bbox`, `dataType`, `status`, `projectGroupId`, and `limit`. “Latest” means `sort_field=uploaded_timestamp`, `sort_order=desc`, `page_no=1`; default `limit=10`, while an explicit singular/latest request returns the first verified candidate plus alternatives.

The fallback is staged, not concurrent:

1. Search `listDatasetFiles` with `name=<place>`.
2. Only when no name result exists, search with `city=<place>`.
3. Only when neither textual search returns a result, forward-geocode the place.
4. If the geocoder returns one high-confidence place, search with its `[west,south,east,north]` bbox.
5. If the geocoder returns plausible alternatives, return `ambiguous` with their labels and bboxes. The client asks the user to choose.
6. Return match evidence: `name`, `city`, `bbox`, the normalized place label, and the effective sort.

This is forward geocoding (place name to coordinates), not reverse geocoding.

Default `status=All` means the latest dataset visible to the authenticated caller. A caller that wants public released data passes `status=Publish`.

### 6.2 “What project groups am I part of?”

The published OpenAPI `listProjectGroups` operation lists all groups and exposes only ID, name search, and pagination. It has no membership-only parameter. `listDatasetFiles?include_my_groups=true` proves that dataset filtering by membership exists, but deriving groups from those records would omit groups with no datasets.

Therefore the semantic tool must not pretend that inference is complete. Until the public API adds one of these capabilities, it returns `unsupported`:

- preferred: `GET /api/v1/me/project-groups`;
- acceptable: `GET /api/v1/project-groups?include_my_groups=true`.

An explicitly named “groups with datasets I can access” query may use `listDatasetFiles?include_my_groups=true`, deduplicate group IDs, and label the result `incomplete_by_design`. That is a different intent from membership.

### 6.3 List services

`tdei_list_services` accepts optional `searchText`, `projectGroupId`, `serviceType` (`all`, `osw`, `flex`, `pathways`), and pagination. It maps directly to `listServices` and returns the applied filters.

When an upload needs a service and the user has not supplied one:

- if a project group is known, list compatible services in that group;
- one match may be returned as a suggested value, but the upload does not execute until the value is resubmitted;
- multiple matches produce `needs_input` with choices.

### 6.4 Validate a dataset

All three validation endpoints require one ZIP dataset as multipart field `dataset` and return an asynchronous job.

The semantic tool accepts `dataType` and `asset`. If either is missing, it returns `needs_input`. It inspects the asset enough to report file type/size and reject obviously invalid input before calling TDEI. Once complete, it selects the operation from the data type, submits it, and returns the job ID and status location.

Validation does not require upload metadata, project group, or service.

### 6.5 Upload a dataset

Upload is a stateless gather-then-submit interaction. Inputs are:

- `dataType`;
- dataset `asset`;
- `projectGroupId`;
- `serviceId`;
- optional `derivedFromDatasetId` and changeset asset;
- metadata object matching the canonical TDEI metadata schema.

The current metadata schema requires the top-level `dataset_detail` object. Within it, required fields are:

- `name`;
- `version`;
- `collected_by`;
- `collection_date`;
- `data_source` (`3rdParty`, `TDEITools`, or `InHouse`);
- `schema_version`.

`data_provenance.full_dataset_name` is required only when `data_provenance` is supplied. Other schema sections are optional.

The tool first inspects the dataset and validates provided metadata. Missing values produce `needs_input` questions with field names, descriptions, allowed values, and any safe suggestion. No upload occurs while required fields or target IDs are missing. A complete call builds multipart fields `dataset`, `metadata`, and optional `changeset`, then returns the accepted job.

The source JSON Schema remains authoritative and should be vendored with its source commit or fetched during a deliberate schema-update task—not fetched dynamically on every request.

### 6.6 Job status

Validation and upload return 202-style job acceptance. `tdei_get_job_status` accepts the returned job ID (and any project-group field actually required by the published operation), performs one lookup, and returns a normalized status. Polling cadence remains client-side.

## 7. File transfer in each deployment

MCP tool arguments are JSON; a hosted server cannot read a path on the client machine. `DatasetAsset` makes this difference explicit:

```ts
type DatasetAsset =
  | { kind: "local_path"; path: string }
  | { kind: "inline_base64"; name: string; mediaType: string; data: string }
  | { kind: "object_ref"; id: string; name: string };
```

- stdio enables `local_path` and streams the file from the user's machine;
- HTTP/S disables `local_path`;
- HTTP/S initially supports bounded `inline_base64` for small files;
- production large-file support uses a short-lived object reference supplied by an external upload endpoint/object store. The MCP server stores no pending semantic session; object lifecycle is infrastructure-owned and the final tool call contains the object reference.

The HTTP request/body limit and TDEI's `/api/v1/system/capabilities` upload limits must be checked before reading the full payload. Remote arbitrary URLs are not an MVP asset type because they introduce SSRF and credential-forwarding risks.

## 8. Transport integration

### 8.1 stdio

The stdio composition root creates:

- existing local `AuthManager`;
- existing `AwsMcpClient`;
- `AwsTdeiOperations`, which maps typed port methods to AWS child tool names;
- `LocalFileAssets`;
- configured `PlaceResolver`;
- one `SemanticIntentModule` registered on the stdio `McpServer`.

SSO helpers and raw AWS-generated tools remain local-only concerns. Semantic registration must not live inside `AwsToolsLifecycle`; otherwise it cannot be shared with hosted HTTP.

### 8.2 Streamable HTTP/S

The HTTP handler requires a bearer on every request, validates it, constructs a request-scoped `HttpTdeiOperations`, and creates an ephemeral MCP server/transport. `HttpTdeiOperations` forwards the same bearer to each TDEI call. The server and adapter are closed after the response.

Hosted mode does not expose local SSO/session/logout tools. Authentication instructions are returned by the HTTP boundary when the bearer is absent or invalid.

Tool registration uses static schemas and descriptions. Deduplication, if needed, is per server instance via `WeakMap<McpServer, Set<string>>`, never a process-global `Set` that would suppress tools on later request-scoped servers.

## 9. Errors and safety

- 401/403: propagate as authentication/authorization failures; never continue fallback.
- 400 validation errors: normalize with field-level detail where available.
- 404/no results: a normal `complete` result with no candidates, unless a fallback remains.
- geocoder unavailable: return a clear partial-resolution error after name/city miss.
- place ambiguity: return `ambiguous`; never pick the first candidate.
- mutation ambiguity or missing input: return `needs_input`; never execute.
- upstream 5xx/timeouts: bounded retry policy belongs in adapters; mutations are not retried unless idempotency is proven.
- redact bearer tokens and inline file contents from logs and errors.
- enforce file size, MIME/extension, ZIP sanity, and decompression limits.

## 10. Tests and acceptance

The semantic module is tested once against fakes. Adapter contract suites then prove AWS and HTTP parity.

Required cases:

- name hit prevents city/geocoder calls;
- city is attempted only after a name miss;
- bbox search is attempted only after both textual misses;
- ambiguous geocoder candidates are returned without a dataset call;
- latest uses explicit uploaded-time descending sort;
- membership returns `unsupported` until a complete API capability exists;
- service filters map correctly;
- validation without an asset returns `needs_input`; complete validation returns a job;
- upload enumerates every missing required target/metadata field;
- complete upload maps to the correct data-type operation and multipart fields;
- two simultaneous HTTP requests never share tokens or accepted fields;
- auth failures stop fallback;
- stdio rejects hosted-only assets and HTTP rejects `local_path`;
- tool names, schemas, and semantic results are identical across transports.

An OpenAPI drift test pins the operation IDs, parameters, multipart fields, and upload metadata requirements used by the adapters.

## 11. Packaging

One repository and package, two install paths:

```text
Local:   npx tdei-mcp --transport=stdio
Hosted:  docker run ... tdei-mcp --transport=http
Client:  https://mcp.example.org/mcp + Authorization bearer on every request
```

The Docker image contains only the Node application for hosted mode; it does not install `uv`, `uvx`, or the AWS MCP server. HTTPS terminates at the deployment ingress/reverse proxy.

## 12. Source facts used by this design

- [TDEI external OpenAPI](https://github.com/TaskarCenterAtUW/TDEI-ExternalAPIs/blob/dev/tdei-api-gateway.json)
- [Canonical upload metadata schema](https://github.com/TaskarCenterAtUW/TDEI-osw-datasvc-ts/blob/dev/schema/metadata.schema.json)
- The OpenAPI defines dataset `name`, `city`, `bbox`, `include_my_groups`, uploaded-time sorting, service filters, multipart validation, and multipart upload.
- The OpenAPI does not define a complete current-user project-group membership operation.

## 13. Deliberate non-goals for the first slice

- server-side conversational memory or login-session storage;
- a second LLM inside the MCP server;
- guessing project-group membership from datasets;
- arbitrary remote-URL file fetching;
- automatic publish after upload or validation;
- replacing every raw OpenAPI operation with a handwritten semantic tool at once.
