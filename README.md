# TDEI-MCP

Connect an MCP-compatible AI client to the TDEI API using natural-language-oriented tools. Local stdio mode loads raw API tools from the TDEI OpenAPI specification and executes them directly in TypeScript. Hosted Streamable HTTP mode is a Node server that keeps a shared SSO session: clients connect with no hardcoded token, sign in via the `tdei_sso_login` MCP tool, and call TDEI with the session access token. Strict per-request Bearer auth remains available as an opt-in.

The transport-neutral OpenAPI module can also build a separate MCP server for another specification. See [Reusing the OpenAPI MCP core](docs/openapi-mcp-core.md).

The default configuration uses the **TDEI development environment**. You need an account with access to that environment; downloading the repository does not create an account or grant API permissions.

## Quickstart (npx)

```bash
npx -y tdei-mcp init
```

This checks Node.js ≥22, asks for your TDEI environment (dev / stage / prod / custom URL — one per
setup), verifies the MCP server, and writes the `tdei` entry into your MCP
client config (Codex / Claude Desktop / VSCode / Custom-manual). The default
SSO callback uses registered port 8765; if it is busy, setup stops with recovery
instructions instead of silently choosing an unregistered callback. Re-run any
time; only the `tdei` entry is touched and an existing client config is backed
up before replacement. To move an existing setup to another environment:

```bash
npx -y tdei-mcp switch base-url
```

Then restart your MCP client (tokens live in server memory). Manual setup is
documented under Advanced below.

### Connecting to a hosted (remote) server

If someone runs the HTTP server for you (e.g. `http://192.168.50.11:3000`),
point your client at it instead of launching a local server — no tokens are
stored in the config; you sign in later via `tdei_sso_login`:

```bash
npx -y tdei-mcp init --remote http://192.168.50.11:3000/mcp --client codex
```

`--client` accepts `codex`, `claude` (Claude Desktop), or `vscode`. For OpenCode, Claude Code CLI, or a one-liner
on the client machine, the server also serves install scripts — see
`GET /mcp/setup` (sh for macOS/Ubuntu, `.ps1` for Windows PowerShell).

## Requirements

- **Node.js 22** and npm. Check with `node --version` and `npm --version`.
- An MCP client that can launch a local **stdio** server, such as Codex. Generated API tool definitions are loaded during MCP initialization so clients see them in the initial catalogue; invoking them still requires SSO.
- Access to TDEI through its browser-based SSO login.
- Internet access to install dependencies, download the OpenAPI specification, and contact TDEI.

## Advanced: manual setup from a checkout (developers only)

If you installed via `npx -y tdei-mcp init`, skip this section — `init` already
wrote your client config with the environment inline and there is no `.env` to
manage. The steps below are only for running from source.

## 1. Download and install

On this repository's GitHub page, choose **Code → Download ZIP**, extract it, and open a terminal in the extracted project folder. Alternatively, copy the repository's clone URL from **Code**, clone it with Git, and enter the cloned folder.

Run these commands from the folder containing `package.json`:

```bash
npm ci
```

`npm ci` installs the dependency versions recorded in `package-lock.json`.
The recommended init flow below writes the required environment into the MCP
client config, so it does not need a `.env` file. For the manual fallback only,
copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell),
edit it once, and keep it private. The callback URL must exactly match the URI
registered for the `tdei-mcp` client, and its port must be free locally.

## 2. Build (checkout only — `init` users skip this)

```bash
npm run build
```

This creates `dist/index.js`, the entry point your MCP client will launch. Rebuild after changing files in `src/` or downloading an updated version of the source. The `.env` values below are only needed for the manual fallback — `init` writes them inline in the client config.

## 3. Connect your MCP client

The recommended checkout setup uses the same verified init flow as the npm package:

```bash
node dist/index.js init --client codex --env dev
```

Use `--env stage`, `--env prod`, or `--url https://your-tdei-host` as needed.
The command detects the checkout, verifies `dist/index.js` through MCP
`initialize` and `tools/list`, writes a default ignored `tdei.config.json` when
missing, backs up an existing Codex config to `config.toml.tdei.bak`, and then
writes an absolute Node + `dist/index.js` stdio entry. Restart Codex afterward.

To keep separate source-checkout settings for each environment, create ignored
local files that set only the API origin; the spec URL and SSO callback use built-in defaults:

```bash
printf 'TDEI_API_URL=https://api-dev.tdei.us\n' > .env.dev
printf 'TDEI_API_URL=https://api-stage.tdei.us\n' > .env.staging
printf 'TDEI_API_URL=https://api.tdei.us\n' > .env.prod
```

Then select the file Codex should use:

```bash
node dist/index.js init --client codex --env-file .env.dev
```

The generated entry stores the absolute file path and launches Node with
`--env-file` before `dist/index.js`. To change environments, rerun `init` with
`.env.staging` or `.env.prod`, then restart Codex. The `.env.*` files are
excluded by `.gitignore`; do not commit them.

The manual configuration below is a fallback. Configure your client to start
the connector with Node.js and explicitly load `.env`. The application does not
load `.env` on its own; `npm start` and `npm run dev` use only the environment
already supplied to their process.

### Codex

Add this entry to `~/.codex/config.toml`, replacing both absolute paths with paths on your machine:

```toml
[mcp_servers.tdei]
command = "/absolute/path/to/node"
args = ["--env-file=.env", "dist/index.js"]
cwd = "/absolute/path/to/TDEI-MCP"
startup_timeout_sec = 120
tool_timeout_sec = 120
```

Find the Node.js executable with `command -v node` on macOS/Linux or `(Get-Command node).Source` in PowerShell. Set `cwd` to the folder you actually extracted or cloned; ZIP downloads may include a branch name in the folder name. On Windows, use forward slashes in TOML paths, for example `C:/projects/TDEI-MCP`.

Codex also supports a project-scoped `.codex/config.toml` for trusted projects. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/) for configuration details.

Restart your Codex session after saving the configuration. In the Codex terminal interface, use `/mcp` to check the connection.

#### Codex Desktop drops the tdei tools

Codex Desktop can rewrite `~/.codex/config.toml` on startup or settings changes and remove custom MCP servers, including `tdei`. This connector cannot prevent that rewrite.

If `/mcp` no longer lists `tdei`, or a chat says tdei-mcp tools are unavailable:

1. Re-run the **same** init command you used originally, for example:

   ```bash
   tdei-mcp init --client codex --env dev
   node dist/index.js init --client codex --env-file .env.dev
   ```

   Use `--env-file .env.staging` or `.env.prod` when that is how this checkout was configured.

2. Fully quit and reopen Codex, then start a **new** chat so it reloads the MCP catalogue.
3. Call `tdei_sso_login` again. Access tokens live in server memory and do not survive a Desktop rewrite or restart.

#### Claude Desktop drops the tdei tools

Claude Desktop can rewrite `claude_desktop_config.json` on startup, settings changes, or connector sync and remove custom MCP servers, including `tdei`. This connector cannot prevent that rewrite.

If the tdei tools disappear:

1. Re-run the **same** init command you used originally, for example:

   ```bash
   tdei-mcp init --client claude --env dev
   node dist/index.js init --client claude --env-file .env.dev
   ```

2. Fully quit and reopen Claude Desktop, then start a **new** chat.
3. Call `tdei_sso_login` again. Tokens are in-memory.

#### VS Code drops the tdei tools

If the tdei tools disappear from VS Code, the workspace entry in `.vscode/mcp.json` may be missing. Restore it with the same init command (`--client vscode`), reload the window, and run `tdei_sso_login` again.

### Other local MCP clients

Use your client's stdio server settings with these values:

| Setting | Value |
| --- | --- |
| Command | Absolute path to the Node.js executable |
| Arguments | `--env-file=/absolute/path/to/project/.env` and `/absolute/path/to/project/dist/index.js`, as two separate arguments |
| Transport | stdio |

The client process needs only Node.js and network access to the configured specification and API URLs.

### STDIO vs manual start

**STDIO** is started automatically by your MCP client (Codex, Claude Desktop, VS Code, etc.) after `init` writes the client config. Do not run `node dist/index.js` yourself for stdio — with a terminal attached it exits and tells you to use HTTP or `init`.

For a non-blocking stdio handshake check, run `npm run check:stdio`. **Manual start** is only for Streamable HTTP (see below).

### HTTP mode (Streamable HTTP, session SSO)

One process serves one transport. HTTP mode serves no STDIO; STDIO mode opens no port.

Run:

    node --env-file=.env dist/index.js --transport=http --port 3000

By default the server keeps a shared SSO session and no Bearer is required:
connect your MCP client, call the `tdei_sso_login` tool, open its `loginUrl`
in a browser, and complete SSO (the server also serves `GET /auth/callback`
so browser redirects land even without a local relay). Signed-out calls to
API tools return `TDEI_SSO_REQUIRED` naming `tdei_sso_login` remediation.
In HTTP mode `TDEI_SSO_CALLBACK_URL` may be a registered `https://` URL (plus
`http://127.0.0.1/` for local dev); it must be pre-registered for the
`tdei-mcp` client or SSO returns 400. Plain HTTP locally; terminate TLS at a
reverse proxy for public `https`.

Strict per-request Bearer mode is still available via
`--require-bearer-auth` (or `TDEI_REQUIRE_BEARER_AUTH=1`): every request must carry
`Authorization: Bearer <access_token>` from the same TDEI SSO protocol (login
page, token exchange, refresh endpoints unchanged). That mode holds no
sessions and no refresh tokens — it validates the Bearer per request and
cannot refresh on the client's behalf. Missing, bad, or expired Bearers
return 401 naming `tdei_sso_login` remediation.

Example (Bearer mode):

    curl -i -X POST http://127.0.0.1:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer <token>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

#### Client setup scripts (remote HTTP)

A running HTTP server advertises one-line installers for client machines so
no token is ever written to disk. `GET /mcp/setup` prints the catalogue:

macOS / Ubuntu (needs `sh` + `node`):

    curl -fsSL http://127.0.0.1:3000/mcp/setup/codex | sh          # Codex (~/.codex/config.toml)
    curl -fsSL http://127.0.0.1:3000/mcp/setup/opencode | sh       # OpenCode (~/.config/opencode/opencode.json)
    curl -fsSL http://127.0.0.1:3000/mcp/setup/claude-cli | sh     # Claude Code CLI (~/.claude.json)
    curl -fsSL http://127.0.0.1:3000/mcp/setup/claude-desktop | sh # Claude Desktop (claude_desktop_config.json)
    curl -fsSL http://127.0.0.1:3000/mcp/setup/vscode | sh         # VS Code (User/mcp.json)
    curl -fsSL http://127.0.0.1:3000/mcp/setup/cursor | sh         # Cursor (~/.cursor/mcp.json)

Windows (PowerShell 5.1+ with `node` on PATH — same targets, `.ps1` suffix):

    Set-ExecutionPolicy Bypass -Scope Process -Force; irm http://127.0.0.1:3000/mcp/setup/codex.ps1 | iex

Update / reinstall (MCP broken, e.g. after the server moved — safe to
re-run, replaces only the `tdei` entry, then restart the app and start a new
chat):

    curl -fsSL http://127.0.0.1:3000/mcp/setup/update/codex | sh   # swap in your client; .ps1 on Windows

Uninstall (removes only the `tdei` entry, keeps every other entry):

    curl -fsSL http://127.0.0.1:3000/mcp/setup/uninstall/codex | sh

Fix-it flow for a colleague: 1) run the update command, 2) fully restart the
app (Desktop: Cmd+Q / File > Exit — closing the window is not enough),
3) start a NEW chat and log in again via `tdei_sso_login`. Still broken?
Uninstall, restart, reinstall.

After running a script, start the MCP client and ask it to log in to TDEI
(calls `tdei_sso_login`). When the server address is not loopback, the script
also starts a local SSO callback relay on `127.0.0.1:8765` that forwards to
the server's `/auth/callback`.

### Docker deployment

Build the image (multi-stage; ships compiled `dist/` plus Node 22 and nginx):
```bash
docker build -t tdei-mcp:http .
```
Run it with your SSO configuration. The container runs the gateway (nginx +
all `mcps.json` children) on port `3000`:
```bash
docker run --rm -p 3000:3000 --env-file .env tdei-mcp:http
```
Override the public port with `-e` (explicit env beats the image default;
keep it clear of the `mcps.json` child ports, default `3001+`):
```bash
docker run --rm -p 4000:4000 -e PORT=4000 -e TDEI_SSO_CALLBACK_URL=https://mcp.example.com/callback --env-file .env tdei-mcp:http
```

Smoke check from the host (expect `401 TDEI_SSO_REQUIRED` — proof the server is up and enforcing Bearer auth):
```bash
curl -i -X POST http://127.0.0.1:3000/tdei-core-dev/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Multiple MCP servers + gateway (mcps.json)

One `mcps.json` declares N servers; each gets its own port and `/<slug>/mcp`
base path. The repo ships a dev default — copy the example to customize:

```bash
cp mcps.example.json mcps.json   # then edit names/apiUrls
```

Node children only (no gateway) — one child process per server, ports
auto-increment from `basePort`:

```bash
npm run build
npm run start:multi -- --file mcps.json   # dev: npm run dev:multi
# tdei-core-dev -> http://127.0.0.1:3001/tdei-core-dev/mcp, staging -> :3002, ...
```

Full gateway — node children plus an nginx path-based reverse proxy:

```bash
npm run deploy:node    # host-local: nginx + children, no Docker (needs nginx installed)
npm run deploy:docker  # single image: build + run container (needs Docker)
npm run deploy:docker:down  # stop and remove the container
```

Both serve the same thing on `http://127.0.0.1:3000/` (`$PORT` overrides,
keeping it clear of the `mcps.json` child ports, default `3001+`):
a landing page with live per-server status cards and an install-command
builder, `POST :3000/<slug>/mcp` (MCP JSON-RPC), `GET :3000/<slug>/health`,
and installers at `:3000/<slug>/mcp/setup/...`. The nginx routes are
regenerated from the effective `mcps.json` on every boot, so editing it and
restarting is enough.

The Docker image is self-contained (`Dockerfile`), so the existing
`Deploy dev` workflow ships the full gateway to Azure Container Apps with no
workflow change — the Container App's ingress target port just has to match
`$PORT` (default `3000`).

Verify every configured server over real MCP transport (handshake,
`tools/list`, signed-out-safe auth calls):

```bash
node --import tsx scripts/multi-transport-check.ts --file mcps.json
```

Note: inside Docker the browser SSO auto-callback cannot reach the
in-container listener; complete login with the `tdei_sso_complete` tool and
the pasted callback URL instead.

## 4. Verify and use the connection

Both transports expose the common semantic tools:

| Tool | Purpose |
| --- | --- |
| `tdei_resolve_intent` | Deterministically map plain-language requests and aliases to a semantic tool and underlying TDEI operation; returns structured clarification instead of guessing. |
| `tdei_find_datasets` | Find datasets by name, city, explicit bbox, or configured place-to-bbox fallback; supports deterministic latest sorting. |
| `tdei_list_services` | List services by text, project group, or service type. |
| `tdei_list_my_project_groups` | Lists project groups via authenticated `GET /api/v1/project-groups` (`listProjectGroups`). On stdio this uses direct TDEI HTTP with the SSO bearer. |
| `tdei_validate_dataset` | Ask for missing inputs, then validate OSW/Flex/Pathways data through adapters that support multipart. |
| `tdei_upload_dataset` | Collect all required target and metadata fields before performing one upload. |

Hosted validation/upload accepts `inline_base64` assets up to 10MB. Client-local paths are intentionally unavailable to a remote server. Local stdio validation/upload accepts absolute `local_path` assets and streams them directly to the TDEI multipart endpoints with the current local SSO token.

The optional `TDEI_GEOCODER_URL` enables forward-geocoding only after dataset name and city searches both miss. Use a Nominatim-compatible endpoint and an identifying `TDEI_GEOCODER_USER_AGENT`; operators using the public OpenStreetMap instance must follow its rate and caching policy.

Local stdio mode also exposes these connector-management tools while signed out:

| Tool | Purpose |
| --- | --- |
| `tdei_auth_status` | Report whether the SSO session is signed out, pending, or authenticated. |
| `tdei_health` | Report connector health: auth state, OpenAPI provider, spec reachability, callback port, and config. Read-only, safe signed-out. |
| `tdei_sso_login` | Start browser SSO and return the login URL. |
| `tdei_test_authentication` | Check for a usable SSO session token. |
| `tdei_load_api_tools` | Retry API tool loading after SSO succeeds. |
| `tdei_logout` | Clear local tokens, reset the OpenAPI provider, and return the browser SSO logout URL. |

The connector starts signed out but discovers generated tools such as `listServices` for the initial catalogue. Call `tdei_sso_login`, open its `loginUrl` in a browser, and complete SSO before invoking them. Every API call obtains the current access token before calling TDEI.

Raw authentication operations generated from the OpenAPI specification are intentionally hidden. Use the connector's `tdei_sso_login`, `tdei_auth_status`, and `tdei_logout` tools for session management.

For a first check, ask your AI client:

> Call tdei_sso_login and give me the loginUrl. After I finish browser login, check tdei_auth_status and call listServices.

Ask for a health report any time, signed out or authenticated:

    {"ok": true, "auth": {"state": "authenticated"}, "openapi": {"loaded": true}, "spec": {"reachable": true, "latencyMs": 210}, "callback": {"portFree": true}}

Bad env fails fast before serving anything:

    {"code": "TDEI_CONFIG_INVALID", "errors": [{"var": "TDEI_API_URL", "rule": "must use HTTPS", "example": "https://api-dev.tdei.us"}]}

Successful setup means SSO succeeds, generated tools appear, and a permitted API call returns a response. Tool names and inputs come from the configured OpenAPI specification, so the client's tool descriptions are the reference for individual operations. Calls use your account's API permissions.

If loading fails, correct the underlying issue and call `tdei_load_api_tools`. If you changed `.env`, restart the connector first because configuration is read at process startup. Repeated or concurrent load requests do not register duplicate tools.

Tokens are kept in process memory. When a token needs renewal, the connector attempts a refresh. If refresh fails, a new browser SSO login is required.

`tdei_logout` clears tokens and resets the in-process OpenAPI provider while retaining registered tool definitions, then returns a `logoutUrl`. Open that URL in the same browser used for login to end the upstream SSO session. Call `tdei_sso_login` to authenticate again. To disconnect completely, disable the MCP entry or stop the connector through your client.

## Configuration reference

Values can be supplied through `.env` using Node's `--env-file` flag, or through your MCP client's environment settings. Existing process environment variables take precedence over values in the environment file.

| Variable | Required | Default / purpose |
| --- | --- | --- |
| `TDEI_API_URL` | No | `https://api-dev.tdei.us` (the only value a typical stdio setup needs) |
| `TDEI_SPEC_URL` | No | Derived from `TDEI_API_URL` (`dev` / `stage` / `main` OpenAPI JSON on GitHub) |
| `TDEI_SSO_CALLBACK_URL` | No | `http://127.0.0.1:8765/callback` (SSO `client_id` is always `tdei-mcp` in code — not an env var) |
| `TDEI_GEOCODER_URL` | No | Absent; Nominatim-compatible HTTPS `/search` endpoint for place-to-bbox fallback |
| `TDEI_GEOCODER_USER_AGENT` | No | Identifies this connector; set an operator contact when required by the provider |
| `TDEI_TRANSPORT` | No | `stdio` (`stdio` or `http`; CLI `--transport=` overrides) |
| `TDEI_HTTP_HOST` | No | `127.0.0.1` (HTTP mode listen host; CLI `--host=` overrides) |
| `TDEI_HTTP_PORT` | No | `3000` (HTTP mode listen port; CLI `--port=` overrides) |
| `TDEI_HTTP_BASE_PATH` | No | `/mcp` |
| `TDEI_PUBLIC_BASE_URL` | No | Auto-detected (`X-Forwarded-Proto` + `Host`; plain `http` for direct local requests). Set to the canonical public origin (e.g. `https://mcp.example.com`) when hosting behind a TLS-terminating proxy so installers and the status page advertise `https` URLs — MCP clients must be registered with the `https` URL, not the redirecting `http` one. |
| `TDEI_CORS_ORIGINS` | No | Empty (same-origin only; comma-separated allow-list) |
| `TDEI_TLS_CERT` / `TDEI_TLS_KEY` | No | Absent (plain HTTP; terminate TLS at a reverse proxy) |

The API URL must use HTTPS. The spec URL and SSO callback are optional because they have defaults. The local SSO callback must exactly match the registered HTTP loopback URL when you override it.

## Endpoint filtering and workflows (tdei.config.json)

Config path: `TDEI_CONFIG_PATH` env else `./tdei.config.json` in `cwd` (same dir as `.env`).
Missing or invalid file → stderr warning + fallback to full access, no workflows.
Run once to scaffold: the server writes a default `{mode:"all"}` file on first use —
edit it, then restart or call `tdei_reload_config` (additive; removals need restart).

`endpoints.mode`: `all` | `allow` (non-empty allow, empty deny) | `deny` (inverse).
Match key is the exact operationId (`listServices`, `cloneDataset`, ...). `tdei_*`
and connector-managed auth ops are never filtered. See `tdei.config.example.json`;
editors get completion via `tdei.config.schema.json`.

Workflows are linear `workflow_*` tools: each step calls one REST operation in order,
`ask[]` becomes required input, `{{user.*}}` / `{{steps.<id>.output.<path>}}` thread
values, failure aborts with a transcript. First built-in example:
`workflow_download_osw_dataset_bundle` (listProjectGroups → listDatasetFiles →
getOswFile → listJobs → job-download). File-upload steps are rejected in v1.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `.env` or `dist/index.js` cannot be found | Verify the project path and `cwd`; create `.env` and run `npm run build`. For clients without `cwd`, use absolute argument paths. |
| SSO login is required | Call `tdei_sso_login` and open the returned `loginUrl`. |
| Callback port is already in use | Stop the process using port 8765, then retry login. |
| SSO redirect returns 400 | Confirm the client ID and callback URL exactly match the backend registration. |
| Only connector-management and semantic tools appear in stdio | Raw-tool discovery failed. Inspect the server logs, network access, and the specification URL, then restart the MCP client. |
| First load times out | Check network access to the specification URL. Retry `tdei_load_api_tools`; increase your client's tool timeout if necessary. |
| An API call returns a permission error | Check that your TDEI account has access to the requested operation and resources in the selected environment. |
| URL validation fails | Ensure `TDEI_API_URL` (and any `TDEI_SPEC_URL` override) is a valid absolute URL beginning with `https://`. |
| `TDEI_SSO_REQUIRED` | Call `tdei_sso_login` and open the returned `loginUrl`. |
| `TDEI_TOKEN_EXPIRED` | Refresh via `POST /api/v1/refresh-token` or re-run SSO login. |
| `TDEI_TOKEN_INVALID` | Call `tdei_sso_login` again; do not reuse the old Bearer. |
| `TDEI_FORBIDDEN` | Check your TDEI account's project-group permissions; the error names the requirement. |
| `TDEI_NOT_FOUND` | Verify the resource id and environment (dev/stage/prod). |
| `TDEI_CONFLICT` | Re-read the resource and retry with current values. |
| `TDEI_UPSTREAM_5XX` | Retry; if it persists, check TDEI environment status. |
| `TDEI_CONFIG_INVALID` | Check `.env` values and `tdei.config.json` against the schema. |
| `TDEI_TOOL_DISABLED` | Enable the tool in `tdei.config.json`, then call `tdei_reload_config`. |
| `TDEI_CHILD_UNAVAILABLE` | Legacy error code: call `tdei_load_api_tools` to reload the in-process OpenAPI provider. |
| `TDEI_CONFIG_INVALID` | Check the named variable against its rule; the error JSON includes a working example value. |

Connector diagnostics are written to stderr, which MCP clients usually capture in server logs. Keep stdout reserved for MCP messages.

## Checks for contributors

Run the deterministic lifecycle tests and TypeScript build without a live TDEI session:

```bash
npm test
npm run build
```

The tests cover the loopback callback and token exchange, SSO-triggered tool loading, tool calls, logout, and signed-out availability.

To verify a real TDEI connection, configure the registered SSO client and callback in `.env`, then run:

```bash
npm run test:live
```

This prints a browser login URL and waits up to five minutes for SSO. It then verifies authentication, loads and calls `listServices`, and logs out. Success prints `Live SSO session smoke test passed.`

For source development with SSO configuration loaded explicitly:

```bash
node --env-file=.env --import tsx src/index.ts
```

The source entry point uses the same stdio protocol and still needs an MCP client for initialization and tool calls.
