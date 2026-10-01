# TDEI-MCP

Connect an MCP-compatible AI client to the TDEI API. This local server authenticates with your TDEI account, launches the AWS Labs OpenAPI MCP server, and exposes the API tools generated from the TDEI OpenAPI specification through one MCP connection.

The default configuration uses the **TDEI development environment**. You need an account with access to that environment; downloading the repository does not create an account or grant API permissions.

## Quickstart (npx)

```bash
npx -y tdei-mcp init
```

This checks Node.js ≥22 and `uvx`, asks for your TDEI environment
(dev / stage / prod / custom URL — one per setup), picks a free local port for
the SSO callback, and writes the `tdei` entry into your MCP client config
(Codex / Claude Desktop / VSCode / Custom-manual). Re-run any time; only the
`tdei` entry is touched. To move an existing setup to another environment:

```bash
npx -y tdei-mcp switch base-url
```

Then restart your MCP client (tokens live in server memory). Manual setup is
documented under Advanced below.

## Requirements

- **Node.js 22** and npm. Check with `node --version` and `npm --version`.
- **uv**, which provides `uvx`. Follow the [uv installation instructions](https://docs.astral.sh/uv/getting-started/installation/), then check with `uvx --version`.
- An MCP client that can launch a local **stdio** server, such as Codex. Generated API tool definitions are loaded during MCP initialization so clients see them in the initial catalogue; invoking them still requires SSO.
- Access to TDEI through its browser-based SSO login.
- Internet access to install dependencies, download the AWS child package and OpenAPI specification, and contact TDEI.

The AWS child package is pinned to `awslabs.openapi-mcp-server@1.1.2`, the version tested with this connector. `uvx` manages that Python tool separately from the npm dependencies; its first launch may take longer while dependencies download.

## Advanced: manual setup from a checkout (developers only)

If you installed via `npx -y tdei-mcp init`, skip this section — `init` already
wrote your client config with the environment inline and there is no `.env` to
manage. The steps below are only for running from source.

## 1. Download and install

On this repository's GitHub page, choose **Code → Download ZIP**, extract it, and open a terminal in the extracted project folder. Alternatively, copy the repository's clone URL from **Code**, clone it with Git, and enter the cloned folder.

Run these commands from the folder containing `package.json`:

```bash
npm ci
cp .env.example .env
```

In Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

`npm ci` installs the dependency versions recorded in `package-lock.json`. Create `.env` only on initial setup; copying the example again overwrites your existing configuration. Keep `.env` private; it is excluded by `.gitignore`. The callback URL must exactly match the URI registered for the `tdei-mcp` client, and its port must be free locally.

## 2. Build (checkout only — `init` users skip this)

```bash
npm run build
```

This creates `dist/index.js`, the entry point your MCP client will launch. Rebuild after changing files in `src/` or downloading an updated version of the source. The `.env` values below are only needed for checkout runs — `init` users already have them inline in the client config.

## 3. Connect your MCP client

Configure your client to start the connector with Node.js and explicitly load `.env`. The application does not load `.env` on its own; `npm start` and `npm run dev` use only the environment already supplied to their process.

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

### Other local MCP clients

Use your client's stdio server settings with these values:

| Setting | Value |
| --- | --- |
| Command | Absolute path to the Node.js executable |
| Arguments | `--env-file=/absolute/path/to/project/.env` and `/absolute/path/to/project/dist/index.js`, as two separate arguments |
| Transport | stdio |

The client process must be able to find `uvx` on its `PATH`. Restart the client after installing uv or changing its environment.

### Manual startup check

From the project folder, you can check that the compiled server starts:

```bash
node --env-file=.env dist/index.js
```

Expect `[tdei-mcp] Starting MCP server` on stderr. The process waits for MCP messages on stdin and starts signed out. This is a stdio server, so there is no browser page or HTTP port. Manual startup alone does not verify authentication or tool calls; an MCP client must send the initialization request. Press Ctrl+C to stop. For normal use, let your MCP client launch the process.

### HTTP mode (Streamable HTTP, stateless)

One process serves one transport. HTTP mode serves no STDIO; STDIO mode opens no port.

Run:

    node --env-file=.env dist/index.js --transport=http --port 3000

Every request must carry `Authorization: Bearer <access_token>` from the same TDEI SSO protocol (login page, token exchange, refresh endpoints unchanged). The server holds no sessions and no refresh tokens: it validates the Bearer per request (local expiry check plus a lightweight TDEI probe) and cannot refresh on the client's behalf — refresh via `POST /api/v1/refresh-token` or re-run SSO login yourself.

Example:

    curl -i -X POST http://127.0.0.1:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer <token>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

Missing, bad, or expired Bearers return 401 naming `tdei_sso_login` remediation. In HTTP mode `TDEI_SSO_CALLBACK_URL` may be a registered `https://` URL (plus `http://127.0.0.1/` for local dev); it must be pre-registered for the `tdei-mcp` client or SSO returns 400. Plain HTTP locally; terminate TLS at a reverse proxy for public `https`. Each request spawns the AWS child fresh (v1 trade-off); the child is closed after the response.

### Docker deployment

Build the image (multi-stage; ships compiled `dist/` plus Node 22, Python 3, and `uvx` for the AWS child — no source or dev dependencies):

    docker build -t tdei-mcp:http .

Run it with your SSO configuration. The container defaults to `TDEI_TRANSPORT=http`, host `0.0.0.0`, port `3000`:

    docker run --rm -p 3000:3000 --env-file .env tdei-mcp:http

Override individual values with `-e` (explicit env beats the image defaults; CLI flags win over everything):

    docker run --rm -p 8080:8080 -e TDEI_HTTP_PORT=8080 -e TDEI_SSO_CALLBACK_URL=https://mcp.example.com/callback --env-file .env tdei-mcp:http

Smoke check from the host (expect `401 TDEI_SSO_REQUIRED` — proof the server is up and enforcing Bearer auth):

    curl -i -X POST http://127.0.0.1:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

## 4. Verify and use the connection

The connector exposes five built-in tools while signed out:

| Tool | Purpose |
| --- | --- |
| `tdei_auth_status` | Report whether the SSO session is signed out, pending, or authenticated. |
| `tdei_health` | Report connector health: auth state, AWS child, spec reachability, `uvx`, callback port, and config. Read-only, safe signed-out. |
| `tdei_sso_login` | Start browser SSO and return the login URL. |
| `tdei_test_authentication` | Check for a usable SSO session token. |
| `tdei_load_api_tools` | Retry API tool loading after SSO succeeds. |
| `tdei_logout` | Clear local tokens, close the AWS child, and return the browser SSO logout URL. |

The connector starts signed out but discovers generated tools such as `listServices` for the initial catalogue. Call `tdei_sso_login`, open its `loginUrl` in a browser, and complete SSO before invoking them. The first authenticated API call restarts the AWS child with the user's access token.

Raw authentication operations generated from the OpenAPI specification are intentionally hidden. Use the connector's `tdei_sso_login`, `tdei_auth_status`, and `tdei_logout` tools for session management.

For a first check, ask your AI client:

> Call tdei_sso_login and give me the loginUrl. After I finish browser login, check tdei_auth_status and call listServices.

Ask for a health report any time, signed out or authenticated:

    {"ok": true, "auth": {"state": "authenticated"}, "child": {"connected": true, "mode": "authenticated"}, "spec": {"reachable": true, "latencyMs": 210}, "uvx": {"found": true}, "callback": {"portFree": true}}

Successful setup means SSO succeeds, generated tools appear, and a permitted API call returns a response. Tool names and inputs come from the configured OpenAPI specification, so the client's tool descriptions are the reference for individual operations. Calls use your account's API permissions.

If loading fails, correct the underlying issue and call `tdei_load_api_tools`. If you changed `.env`, restart the connector first because configuration is read at process startup. Repeated or concurrent load requests do not register duplicate tools.

Tokens are kept in process memory. When a token needs renewal, the connector attempts a refresh. If refresh fails, a new browser SSO login is required. It restarts the AWS child when the token changes.

`tdei_logout` clears tokens and closes the AWS child while retaining registered tool definitions, then returns a `logoutUrl`. Open that URL in the same browser used for login to end the upstream SSO session. Call `tdei_sso_login` to authenticate again. To disconnect completely, disable the MCP entry or stop the connector through your client.

## Configuration reference

Values can be supplied through `.env` using Node's `--env-file` flag, or through your MCP client's environment settings. Existing process environment variables take precedence over values in the environment file.

| Variable | Required | Default / purpose |
| --- | --- | --- |
| `TDEI_SSO_CLIENT_ID` | No | `tdei-mcp` |
| `TDEI_SSO_CALLBACK_URL` | No | `http://127.0.0.1:8765/callback` |
| `TDEI_API_URL` | No | `https://api-dev.tdei.us` |
| `TDEI_SPEC_URL` | No | `https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json` |
| `TDEI_AWS_MCP_PACKAGE` | No | `awslabs.openapi-mcp-server@1.1.2` |
| `TDEI_TRANSPORT` | No | `stdio` (`stdio` or `http`; CLI `--transport=` overrides) |
| `TDEI_HTTP_HOST` | No | `127.0.0.1` (HTTP mode listen host; CLI `--host=` overrides) |
| `TDEI_HTTP_PORT` | No | `3000` (HTTP mode listen port; CLI `--port=` overrides) |
| `TDEI_HTTP_BASE_PATH` | No | `/mcp` |
| `TDEI_CORS_ORIGINS` | No | Empty (same-origin only; comma-separated allow-list) |
| `TDEI_TLS_CERT` / `TDEI_TLS_KEY` | No | Absent (plain HTTP; terminate TLS at a reverse proxy) |

The API and specification URLs must use HTTPS. The local SSO callback must exactly match the registered HTTP loopback URL. When selecting another environment, use a matching API URL, OpenAPI specification, and account. Keep the AWS package pinned to an exact version that you have tested with this connector.

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
| `uvx` cannot be launched / `ENOENT` | Install uv and make sure `uvx` is on the MCP client's `PATH`, then restart the client. A desktop app may have a different `PATH` from your terminal. |
| Only the five built-in tools appear | Initial schema discovery failed. Inspect the server logs, check `uvx`, network access, and the specification URL, then restart the MCP client. |
| First load times out | Check network access and allow time for `uvx` downloads. Retry `tdei_load_api_tools`; increase your client's tool timeout if necessary. |
| An API call returns a permission error | Check that your TDEI account has access to the requested operation and resources in the selected environment. |
| URL validation fails | Ensure `TDEI_API_URL` and `TDEI_SPEC_URL` are valid absolute URLs beginning with `https://`. |
| `TDEI_SSO_REQUIRED` | Call `tdei_sso_login` and open the returned `loginUrl`. |
| `TDEI_TOKEN_EXPIRED` | Refresh via `POST /api/v1/refresh-token` or re-run SSO login. |
| `TDEI_TOKEN_INVALID` | Call `tdei_sso_login` again; do not reuse the old Bearer. |
| `TDEI_FORBIDDEN` | Check your TDEI account's project-group permissions; the error names the requirement. |
| `TDEI_NOT_FOUND` | Verify the resource id and environment (dev/stage/prod). |
| `TDEI_CONFLICT` | Re-read the resource and retry with current values. |
| `TDEI_UPSTREAM_5XX` | Retry; if it persists, check TDEI environment status. |
| `TDEI_CONFIG_INVALID` | Check `.env` values and `tdei.config.json` against the schema. |
| `TDEI_TOOL_DISABLED` | Enable the tool in `tdei.config.json`, then call `tdei_reload_config`. |
| `TDEI_CHILD_UNAVAILABLE` | Call `tdei_load_api_tools` to restart the AWS child. |

Connector diagnostics are written to stderr, which MCP clients usually capture in server logs. Keep stdout reserved for MCP messages.

## Checks for contributors

Run the deterministic lifecycle tests and TypeScript build without a live TDEI session:

```bash
npm test
npm run build
```

The tests cover the loopback callback and token exchange, SSO-triggered tool loading, tool calls, logout, and signed-out availability.

To verify a real TDEI connection, configure the registered SSO client and callback in `.env` and ensure `uvx` is available, then run:

```bash
npm run test:live
```

This prints a browser login URL and waits up to five minutes for SSO. It then verifies authentication, loads and calls `listServices`, and logs out. Success prints `Live SSO session smoke test passed.`

For source development with SSO configuration loaded explicitly:

```bash
node --env-file=.env --import tsx src/index.ts
```

The source entry point uses the same stdio protocol and still needs an MCP client for initialization and tool calls.
