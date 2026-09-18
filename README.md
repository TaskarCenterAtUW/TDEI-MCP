# TDEI-MCP

Connect an MCP-compatible AI client to the TDEI API. This local server authenticates with your TDEI account, launches the AWS Labs OpenAPI MCP server, and exposes the API tools generated from the TDEI OpenAPI specification through one MCP connection.

The default configuration uses the **TDEI development environment**. You need an account with access to that environment; downloading the repository does not create an account or grant API permissions.

## Requirements

- **Node.js 22** and npm. Check with `node --version` and `npm --version`.
- **uv**, which provides `uvx`. Follow the [uv installation instructions](https://docs.astral.sh/uv/getting-started/installation/), then check with `uvx --version`.
- An MCP client that can launch a local **stdio** server, such as Codex. API tools are loaded before the initial MCP connection; tool-list change notifications support later recovery loads.
- TDEI username and password for the selected API environment.
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

## 2. Configure credentials and build

Open `.env` in a text editor and replace the username and password placeholders:

```dotenv
TDEI_USERNAME=your-email@example.com
TDEI_PASSWORD="your-password"
```

Keep the other values from `.env.example` for the development environment. Quote values containing spaces or `#`. Keep `.env` private; it is excluded by `.gitignore`.

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

Expect `[tdei-mcp] Starting MCP server` on stderr. The process waits for MCP messages on stdin. When a client sends its initialization request, the connector attempts authentication and tool discovery before completing startup. This is a stdio server, so there is no browser page or HTTP port. Manual startup alone does not verify authentication or tool calls; an MCP client must send the initialization request. Press Ctrl+C to stop. For normal use, let your MCP client launch the process.

## 4. Verify and use the connection

The connector always exposes four built-in tools after startup, including when automatic API loading fails:

| Tool | Purpose |
| --- | --- |
| `tdei_auth_status` | Report whether credentials are configured and whether a usable token is present. Does not perform login. |
| `tdei_test_authentication` | Authenticate or obtain a usable session token. |
| `tdei_load_api_tools` | Recover from an automatic loading failure or reload after logout. |
| `tdei_logout` | Clear local session tokens and close the AWS child process. |

Before completing MCP initialization, the connector attempts authentication and API tool discovery. On success, generated tools such as `listServices` are included in the first tool list, then you can call them directly. Allow time for the first `uvx` download; the startup timeout in the example is 120 seconds.

For a first check, ask your AI client:

> Use tdei_auth_status to check my connection, then use listServices to list the available TDEI services.

Successful setup means credentials are configured, authentication succeeds, generated tools appear, and a permitted API call returns a response. Tool names and inputs come from the configured OpenAPI specification, so the client's tool descriptions are the reference for individual operations. Calls use your account's API permissions.

If loading fails, correct the underlying issue and call `tdei_load_api_tools`. If you changed `.env`, restart the connector first because configuration is read at process startup. Repeated or concurrent load requests do not register duplicate tools.

Tokens are kept in process memory. When a token needs renewal, the connector attempts a refresh and falls back to login if refresh fails. It restarts the AWS child when the token changes.

`tdei_logout` clears tokens but retains configured credentials and registered tool definitions. Calling a protected API tool again can authenticate again; use `tdei_load_api_tools` to explicitly reload the API session. To disconnect completely, disable the MCP entry or stop the connector through your client.

## Configuration reference

Values can be supplied through `.env` using Node's `--env-file` flag, or through your MCP client's environment settings. Existing process environment variables take precedence over values in the environment file.

| Variable | Required | Default / purpose |
| --- | --- | --- |
| `TDEI_USERNAME` | For authentication | TDEI account username; no default. |
| `TDEI_PASSWORD` | For authentication | TDEI account password; no default. |
| `TDEI_API_URL` | No | `https://api-dev.tdei.us` |
| `TDEI_SPEC_URL` | No | `https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json` |
| `TDEI_AWS_MCP_PACKAGE` | No | `awslabs.openapi-mcp-server@1.1.2` |

Both URL settings must be absolute HTTPS URLs. When selecting another environment, use a matching API URL, OpenAPI specification, and account. Keep the AWS package pinned to an exact version that you have tested with this connector.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `.env` or `dist/index.js` cannot be found | Verify the project path and `cwd`; create `.env` and run `npm run build`. For clients without `cwd`, use absolute argument paths. |
| `TDEI_AUTH_REQUIRED` or `configured: false` | Replace both credential placeholders and ensure the process loads `.env`. Restart after changes. |
| Authentication reports invalid credentials | Check the username, password, and API environment. Quoting may be needed for a password containing `#` or spaces. |
| `uvx` cannot be launched / `ENOENT` | Install uv and make sure `uvx` is on the MCP client's `PATH`, then restart the client. A desktop app may have a different `PATH` from your terminal. |
| Only the four built-in tools appear | Inspect the client's server stderr logs, and call `tdei_load_api_tools`. Check credentials, network access, and the specification URL. Refresh or reconnect a client that does not update its tool list. |
| First load times out | Check network access and allow time for `uvx` downloads. Retry `tdei_load_api_tools`; increase your client's tool timeout if necessary. |
| An API call returns a permission error | Check that your TDEI account has access to the requested operation and resources in the selected environment. |
| URL validation fails | Ensure `TDEI_API_URL` and `TDEI_SPEC_URL` are valid absolute URLs beginning with `https://`. |

Connector diagnostics are written to stderr, which MCP clients usually capture in server logs. Keep stdout reserved for MCP messages.

## Checks for contributors

Run the deterministic lifecycle tests and TypeScript build without TDEI credentials:

```bash
npm test
npm run build
```

The lifecycle tests use fake authentication and API sessions. They check automatic loading, tool calls, logout, recovery, and availability of the outer server when automatic loading fails.

To verify a real TDEI connection, configure valid credentials in `.env` and ensure `uvx` is available, then run:

```bash
npm run test:live
```

This makes real authentication and `listServices` requests. It verifies automatic loading, calls `listServices`, logs out, verifies that the AWS child closed, reloads through `tdei_load_api_tools`, and calls `listServices` again. Success prints `Live session lifecycle smoke test passed.`

For source development with credentials loaded explicitly:

```bash
node --env-file=.env --import tsx src/index.ts
```

The source entry point uses the same stdio protocol and still needs an MCP client for initialization and tool calls.
