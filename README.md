# TDEI-MCP

Local **stdio** MCP server for the TDEI API. It signs you in through TDEI browser SSO, starts the AWS Labs OpenAPI MCP server, and exposes the TDEI API operations as MCP tools to Codex, Claude Desktop, VS Code, or any stdio MCP client. Your MCP client launches and stops the server; you never run it by hand.

**You need:** [Node.js ≥ 22](https://nodejs.org/), a TDEI account, and a free local port (default 8765) for the SSO callback. [uv](https://docs.astral.sh/uv/getting-started/installation/) (provides `uvx`) is also required; if it is missing, `init` offers to install it with the official installer (`--install-uv` to accept, `--no-install-uv` to skip). After a fresh uv install, open a new terminal and restart your MCP client so it can find `uvx`.

## Option 1 — Install from npm

```bash
npx -y tdei-mcp init
```

`init` asks for your TDEI base URL (for example `https://api.tdei.us`; only the host is used; `--env stage|prod` or `--url <https-url>` skips the prompt) and your client (`codex`, `claude`, `vscode`, or `custom`), then writes the `tdei` MCP entry into that client's config and creates a default `~/.tdei-mcp/tdei.config.json`.

Setup uses absolute Node and installed-server paths and verifies MCP initialization
and `tools/list` before changing client settings. It captures the setup PATH so
Codex can find `uvx`, honors `CODEX_HOME`, backs up existing settings to
`config.toml.tdei.bak`, writes atomically, and reads back the result.
When run through npx, setup copies its runtime to
`$CODEX_HOME/tdei-runtime/<version>` (default `~/.codex/tdei-runtime/<version>`)
so npm cache cleanup does not break the connection.

The default callback port stays at 8765. A busy port fails with recovery
instructions instead of selecting an unregistered SSO callback. Pass `--port`
only for a callback URI registered by your SSO administrator. Environment
switching preserves command, arguments, working directory, and Codex server
settings. Unknown CLI arguments print usage and exit rather than starting stdio.
The legacy `tdei-mcp-init` binary remains supported.

Configuration verification does not mean an existing chat refreshed its tools
or that SSO succeeded. Restart or reconnect your MCP client, then ask it:

> Call tdei_sso_login and give me the loginUrl. After browser login, check tdei_auth_status and call listServices.

Switch environment later: `npx -y tdei-mcp switch base-url`, then restart the client.

## Option 2 — Run from the git repository

```bash
git clone https://github.com/TaskarCenterAtUW/TDEI-MCP.git
cd TDEI-MCP
npm ci
npm run build
node dist/index.js init
```

`init` detects the checkout and writes an entry that runs your local build (`node /abs/path/dist/index.js`), plus `tdei.config.json` in the repo root (git-ignored). Restart your MCP client and run the same verify prompt as above. Re-run `npm run build` after pulling changes.

## Other clients

`init --client custom` (either option) prints the command, args, and environment to paste into any stdio MCP client. The client process must have `uvx` on its `PATH`.

## Built-in tools

| Tool | Purpose |
| --- | --- |
| `tdei_sso_login` | Start browser SSO; returns the login URL. |
| `tdei_auth_status` | Signed out / pending / authenticated. |
| `tdei_test_authentication` | Check for a usable session token. |
| `tdei_load_api_tools` | Retry loading API tools after SSO. |
| `tdei_logout` | Clear tokens; returns the browser logout URL. |
| `tdei_reload_config` | Re-read `tdei.config.json` and register new tools. |

All other tools are generated from the TDEI OpenAPI spec (for example `listServices`). Raw auth operations are hidden; use the `tdei_*` tools. Tokens live in memory only and are refreshed automatically; if refresh fails, sign in again.

## Endpoint filtering and workflows (`tdei.config.json`)

Location: `$TDEI_CONFIG_PATH` (set by `init`), else `./tdei.config.json`. Schema for editor completion: `tdei.config.schema.json`; example: `tdei.config.example.json`.

- **`endpoints.mode`**: `all` (default), `allow` (only the operationIds in `allow`), or `deny` (everything except `deny`). Only one of `allow`/`deny` may be non-empty. Match is the exact operationId (`listServices`, `cloneDataset`, …); hyphens and underscores are interchangeable (`job-download` = `job_download`, the name the tool is exposed under). A filtered tool is simply not present in the tool list. `tdei_*` tools and connector auth are never filtered.
- **`workflows`**: each becomes a tool `workflow_<name>` that runs REST operations one after another. Each step's `ask` keys become required inputs; `{{user.<key>}}` and `{{steps.<id>.output.<path>}}` pass values along. A failing step aborts the chain and returns the failed step, its input, the error, and the outputs so far.
- **Workflows are validated against the effective tool list** when loaded: every step's `tool` must exist, must not be filtered out, and every `{{…}}` reference must resolve. File operations listed below use local handlers and work in workflows. Unknown multipart operations remain unsupported. A workflow that fails is skipped and the reason is logged to stderr and returned by `tdei_reload_config`.
- **Invalid config falls back to allow-all** (all endpoints, no workflows) with a warning on stderr naming the file and JSON path. This includes both `allow` and `deny` set, unknown operationIds, and duplicate workflow names or step ids.
- Edits apply on restart, or via `tdei_reload_config` for additions. Removing or changing an existing workflow or filter needs a restart.

## Environment variables

Set by `init` in your client entry; override there if needed.

| Variable | Default |
| --- | --- |
| `TDEI_API_URL` | `https://api.tdei.us` (`init` asks; use `switch base-url` to change) |
| `TDEI_SPEC_URL` | `https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json` |
| `TDEI_SSO_CLIENT_ID` | `tdei-mcp` |
| `TDEI_SSO_CALLBACK_URL` | `http://127.0.0.1:<port>/callback` (loopback only) |
| `TDEI_CONFIG_PATH` | see above |
| `TDEI_AWS_MCP_PACKAGE` | `awslabs.openapi-mcp-server@1.1.2` (keep pinned) |
| `TDEI_DOWNLOAD_DIR` | `./downloads`, resolved relative to the connector working directory |

API and specification URLs must be `https://`.

### File downloads

`getOswFile`, `getGtfsFlexFile`, `getGtfsPathwaysFile`, `job_download`, and
`oswDatasetViewerFeedbacksDownload` use the connector's current SSO token and
stream files directly to `TDEI_DOWNLOAD_DIR`. OSW supports `format="osw"` and
`format="osm"`, with `file_version="latest"` as the default. Feedback supports
`format="csv"` (default) and `format="geojson"`, preserving query filters.
Job downloads detect ZIP signatures and otherwise use the response filename's
extension or content type, falling back to `.bin` for unknown binary output.
The tools return JSON with `path` (absolute local path), `filename`,
`contentType`, `bytes`, the dataset/job/project-group identifier, and `format`
when applicable. The path belongs to the machine running the MCP connector.

Each download gets a unique filename. Failed streams remove partial files.
The connector preserves binary bytes rather than decoding the ZIP as UTF-8.
Set `TDEI_DOWNLOAD_DIR` in your MCP server environment and reconnect the server
after changing it or rebuilding the connector. Downloaded files remain on disk
until you remove them.

### File uploads

File arguments are **absolute local paths on the MCP connector host**. Supply
`dataset` for the ZIP, `metadata` for the metadata JSON, and optional `changeset`
for dataset uploads. Operations with a single file use the `file` argument.
The connector opens files as streaming blobs and sends multipart/form-data
with filenames and content types, without decoding binary data or buffering
the entire file in memory. Fetch generates the multipart boundary.

Supported operations: `uploadOswFile`, `uploadGtfsFlexFile`,
`uploadGtfsPathwaysFile`, `validateOswFile`, `validateGtfsFlexFile`,
`validateGtfsPathwaysFile`, `sanitizeOswFile`, `editMetadata`, `cloneDataset`,
`oswOnDemandFormat`, `oswConfidenceCalculate`, `oswQualityCalculate`, and
`qualityMetricTag`. Confidence and intersection-quality files are optional.
Conversion sends `source_format` and `target_format` as multipart text fields.
Dataset uploads preserve the optional `derived_from_dataset_id` query value.

Upload tools return JSON containing HTTP `status`, API response `result`, and
the job-status `location` header (or null). In workflows, use
`{{steps.<step-id>.output.structuredContent.result}}` for a job ID returned as a
string, or `{{steps.<step-id>.output.structuredContent.path}}` for a downloaded
file path that a later upload step consumes.
HTTP errors fail the operation; the connector does not retry uploads.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `uvx` not found / `ENOENT` | Install uv; make sure the MCP client's `PATH` includes it (desktop apps may differ from your terminal); restart the client. |
| Callback port in use | Stop the process on that port, or re-run `init` to pick a free one. |
| Only the `tdei_*` tools appear | Discovery failed: check client logs (stderr), network, `TDEI_SPEC_URL`, then call `tdei_load_api_tools`. |
| First load is slow or times out | `uvx` is downloading dependencies; retry and raise the client's tool timeout (`init` sets 120s for Codex). |
| Permission error on an API call | Your TDEI account lacks access in the selected environment. |
| Config ignored | Read the `[tdei-config]` warning in the server log. |

## Development

CI runs on every push (typecheck, lint, build) and on pull requests to `main` (typecheck, lint, build, tests).


```bash
npm test          # deterministic tests, no TDEI session needed
npm run typecheck # tsc for src and tests
npm run lint      # eslint
npm run build
npm run test:live # real SSO; needs a .env (see .env.example) and uvx
```

## License

Proprietary — all rights reserved (see `LICENSE`).
