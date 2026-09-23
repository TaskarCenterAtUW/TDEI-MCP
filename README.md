# TDEI-MCP

Connect an MCP-compatible AI client to the TDEI API. This local server authenticates with your TDEI account, launches the AWS Labs OpenAPI MCP server, and exposes the API tools generated from the TDEI OpenAPI specification through one MCP connection.

The default configuration uses the **TDEI development environment**. You need an account with access to that environment; downloading the repository does not create an account or grant API permissions.

## Requirements

- **Node.js 22** and npm. Check with `node --version` and `npm --version`.
- **uv**, which provides `uvx`. Follow the [uv installation instructions](https://docs.astral.sh/uv/getting-started/installation/), then check with `uvx --version`.
- An MCP client that can launch a local **stdio** server, such as Codex. Generated API tool definitions are loaded during MCP initialization so clients see them in the initial catalogue; invoking them still requires SSO.
- Access to TDEI through its browser-based SSO login.
- Internet access to install dependencies, download the AWS child package and OpenAPI specification, and contact TDEI.

The AWS child package is pinned to `awslabs.openapi-mcp-server@1.1.2`, the version tested with this connector. `uvx` manages that Python tool separately from the npm dependencies; its first launch may take longer while dependencies download.

## 1. Download and install

On this repository's GitHub page, choose **Code → Download ZIP**, extract it, and open a terminal in the extracted project folder. Alternatively, copy the repository's clone URL from **Code**, clone it with Git, and enter the cloned folder.

Run these commands from the folder containing `package.json`:

```bash
npm ci
cp .env.example .env
```

In Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

`npm ci` installs the dependency versions recorded in `package-lock.json`. Create `.env` only on initial setup; copying the example again overwrites your existing configuration.

## 2. Configure SSO and build

Open `.env` in a text editor and confirm the SSO client and registered callback URL:

```dotenv
TDEI_SSO_CLIENT_ID=tdei-mcp
TDEI_SSO_CALLBACK_URL=http://127.0.0.1:8765/callback
```

Keep the other values from `.env.example` for the development environment. The callback URL must exactly match the URI registered for the `tdei-mcp` client. Port 8765 must be available locally. Keep `.env` private; it is excluded by `.gitignore`.

Build the connector:

```bash
npm run build
```

This creates `dist/index.js`, the entry point your MCP client will launch. Rebuild after changing files in `src/` or downloading an updated version of the source.

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

## 4. Verify and use the connection

The connector exposes five built-in tools while signed out:

| Tool | Purpose |
| --- | --- |
| `tdei_auth_status` | Report whether the SSO session is signed out, pending, or authenticated. |
| `tdei_sso_login` | Start browser SSO and return the login URL. |
| `tdei_test_authentication` | Check for a usable SSO session token. |
| `tdei_load_api_tools` | Retry API tool loading after SSO succeeds. |
| `tdei_logout` | Clear local tokens, close the AWS child, and return the browser SSO logout URL. |

The connector starts signed out but discovers generated tools such as `listServices` for the initial catalogue. Call `tdei_sso_login`, open its `loginUrl` in a browser, and complete SSO before invoking them. The first authenticated API call restarts the AWS child with the user's access token.

Raw authentication operations generated from the OpenAPI specification are intentionally hidden. Use the connector's `tdei_sso_login`, `tdei_auth_status`, and `tdei_logout` tools for session management.

For a first check, ask your AI client:

> Call tdei_sso_login and give me the loginUrl. After I finish browser login, check tdei_auth_status and call listServices.

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

The API and specification URLs must use HTTPS. The local SSO callback must exactly match the registered HTTP loopback URL. When selecting another environment, use a matching API URL, OpenAPI specification, and account. Keep the AWS package pinned to an exact version that you have tested with this connector.

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
