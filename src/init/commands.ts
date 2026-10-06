import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { DEFAULT_CONFIG_JSON } from "../config-file.js";
import { DEFAULT_SPEC_URL, assertCallbackUrl, assertHttpsUrl, buildCallbackUrl, resolveApiUrl } from "./envs.js";
import { checkPreflight, type ExecFn } from "./preflight.js";
import { assertPort, defaultTryPort, portInUseHint } from "./ports.js";
import { verifyServer } from "./verify.js";
import {
  CLIENTS, buildServerEntry, claudeConfigPath, codexConfigPath, formatManual,
  readClaudeEntry, readCodexEntry, readVscodeEntry, vscodeConfigPath,
  writeClaudeEntry, writeCodexEntry, writeVscodeEntry, switchCodexEnv,
  type ClientName, type ServerEntry,
} from "./clients.js";

export const TDEI_ENV_KEYS = ["TDEI_API_URL", "TDEI_SPEC_URL", "TDEI_SSO_CALLBACK_URL"];

export interface Prompter {
  chooseEnv(): Promise<{ env?: string | undefined; url?: string | undefined }>;
  chooseClient(): Promise<ClientName>;
  confirm?(question: string): Promise<boolean>;
}

export interface Deps {
  exec: ExecFn;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  prompter: Prompter;
  log: (msg: string) => void;
  verify?: (entry: ServerEntry) => Promise<void>;
  isPortFree?: (port: number) => Promise<boolean>;
}

export interface LocalCheckout {
  indexPath: string;
  root: string;
}

function assertClient(value: string): ClientName {
  if (!(CLIENTS as readonly string[]).includes(value)) {
    throw new Error(`unknown client "${value}" (expected one of: ${CLIENTS.join(", ")})`);
  }
  return value as ClientName;
}

function configPath(local: LocalCheckout | undefined, home: string): string {
  return local
    ? join(local.root, "tdei.config.json")
    : join(home, ".tdei-mcp", "tdei.config.json");
}

async function scaffoldConfig(
  deps: Deps,
  path: string,
  local: LocalCheckout | undefined,
): Promise<void> {
  try {
    if ((await deps.readFile(path)).trim()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  await deps.mkdir(dirname(path));
  const contents = local
    ? DEFAULT_CONFIG_JSON
    : DEFAULT_CONFIG_JSON.replace("./tdei.config.schema.json", "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-MCP/main/tdei.config.schema.json");
  await deps.writeFile(path, contents);
  deps.log(`wrote default ${path} (all endpoints enabled, no workflows)`);
}

async function loadEnvironmentFile(
  deps: Deps,
  path: string,
): Promise<{ values: Record<string, string>; apiUrl: string; callbackUrl: string; port: number }> {
  if (!isAbsolute(path)) {
    throw new Error(`--env-file must resolve to an absolute path (received ${path})`);
  }
  let source: string;
  try {
    source = await deps.readFile(path);
  } catch (error) {
    throw new Error(`cannot read --env-file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let values: Record<string, string>;
  try {
    values = Object.fromEntries(
      Object.entries(parseEnv(source)).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  } catch (error) {
    throw new Error(`invalid --env-file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!values["TDEI_API_URL"]?.trim()) {
    throw new Error(`--env-file ${path} must define TDEI_API_URL`);
  }
  if (values["TDEI_TRANSPORT"] && values["TDEI_TRANSPORT"].trim().toLowerCase() !== "stdio") {
    throw new Error(`--env-file ${path} must use TDEI_TRANSPORT=stdio for an MCP client setup`);
  }
  const apiUrl = resolveApiUrl({ url: values["TDEI_API_URL"] });
  if (values["TDEI_SPEC_URL"]) assertHttpsUrl(values["TDEI_SPEC_URL"], "TDEI_SPEC_URL");
  const callbackUrl = assertCallbackUrl(values["TDEI_SSO_CALLBACK_URL"] ?? buildCallbackUrl(8765));
  return { values, apiUrl, callbackUrl, port: Number(new URL(callbackUrl).port) };
}

const RULE = "─".repeat(58);

function clientDisplayName(client: ClientName): string {
  if (client === "codex") return "Codex Desktop";
  if (client === "claude") return "Claude Desktop";
  if (client === "vscode") return "VS Code";
  return "your MCP client";
}

function indentBlock(text: string, prefix: string): string {
  return text.split("\n").map((line) => (line ? prefix + line : prefix.trimEnd())).join("\n");
}

export function clientConfigDropHint(client: ClientName): string {
  const examples = [
    `tdei-mcp init --client ${client} --env dev`,
    `node dist/index.js init --client ${client} --env-file .env.dev`,
  ];
  if (client === "custom") {
    return [
      "Re-apply the command, args, working directory, and env printed above.",
      "Then restart the client and run tdei_sso_login again (tokens are in-memory).",
    ].join("\n");
  }
  if (client === "vscode") {
    return [
      "The tdei server may be missing from .vscode/mcp.json.",
      "Restore it with the same init command, reload the window, then tdei_sso_login (tokens are in-memory):",
      ...examples.map((command) => `  ${command}`),
    ].join("\n");
  }
  const name = clientDisplayName(client);
  const config = client === "codex" ? "~/.codex/config.toml" : "claude_desktop_config.json";
  return [
    `${name} may rewrite ${config} and drop the tdei MCP server.`,
    "That rewrite cannot be blocked from this connector.",
    "Restore with the same init command, fully quit the app, start a new chat, then tdei_sso_login (tokens are in-memory):",
    ...examples.map((command) => `  ${command}`),
  ].join("\n");
}

export function formatSetupReport(opts: {
  status: string;
  client: ClientName;
  apiUrl: string;
  configPath?: string;
}): string {
  const name = clientDisplayName(opts.client);
  const next = opts.client === "vscode"
    ? [
        "    1. Reload the VS Code window",
        "    2. Call tdei_sso_login and open the loginUrl",
        "    3. After browser login: tdei_auth_status, then listServices",
      ]
    : [
        `    1. Fully quit and reopen ${name}`,
        "    2. Start a new chat",
        "    3. Call tdei_sso_login and open the loginUrl",
        "    4. After browser login: tdei_auth_status, then listServices",
      ];
  return [
    "",
    `  TDEI-MCP  ·  ${name}  ·  ${opts.status}`,
    `  ${RULE}`,
    `  API      ${opts.apiUrl}`,
    ...(opts.configPath ? [`  Config   ${opts.configPath}`] : []),
    "  Check    MCP initialize and tools/list passed",
    "",
    "  Next",
    ...next,
    "",
    "  If tools disappear later",
    indentBlock(clientConfigDropHint(opts.client), "    "),
    `  ${RULE}`,
    "",
  ].join("\n");
}

function clientPaths(client: ClientName, home: string, cwd: string): string {
  if (client === "codex") return codexConfigPath(home);
  if (client === "claude") return claudeConfigPath(process.platform, home);
  return vscodeConfigPath(cwd);
}

async function readExisting(deps: Deps, path: string): Promise<string> {
  try {
    return await deps.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

function writeEntry(client: ClientName, current: string, entry: ServerEntry, env: Record<string, string>, path: string): string {
  if (client === "codex") return writeCodexEntry(current, entry, env);
  if (client === "claude") return writeClaudeEntry(current, entry, env, path);
  return writeVscodeEntry(current, entry, env, path);
}

function readEntry(client: ClientName, current: string): {
  found: boolean;
  env: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
} {
  if (client === "codex") return readCodexEntry(current);
  if (client === "claude") return readClaudeEntry(current);
  return readVscodeEntry(current);
}

export async function runInit(
  deps: Deps,
  opts: {
    env?: string;
    url?: string;
    client?: ClientName;
    port?: number;
    serverPath?: string;
    nodePath?: string;
    home?: string;
    cwd?: string;
    local?: LocalCheckout;
    installUv?: boolean;
    envFile?: string;
  },
): Promise<{ client: ClientName; apiUrl: string; callbackUrl: string }> {
  if (opts.client !== undefined) assertClient(opts.client);
  if (opts.envFile && (opts.env || opts.url || opts.port !== undefined)) {
    throw new Error("--env-file cannot be combined with --env, --url, or --port");
  }
  const nodeExecPath = opts.nodePath ?? process.execPath;
  const confirmInstall = opts.installUv === undefined
    ? deps.prompter.confirm
      ? () => deps.prompter.confirm!("uv (uvx) was not found. Install it now with the official installer from astral.sh? [y/N] ")
      : undefined
    : async () => opts.installUv === true;
  await checkPreflight(deps.exec, {
    nodePath: nodeExecPath,
    log: deps.log,
    ...(confirmInstall ? { confirmInstall } : {}),
  });
  const fileEnvironment = opts.envFile
    ? await loadEnvironmentFile(deps, opts.envFile)
    : undefined;
  const choice = fileEnvironment
    ? undefined
    : opts.env ?? opts.url
      ? { env: opts.env, url: opts.url }
      : await deps.prompter.chooseEnv();
  const apiUrl = fileEnvironment?.apiUrl ?? resolveApiUrl(choice ?? {});
  const port = assertPort(fileEnvironment?.port ?? opts.port ?? 8765);
  if (!(await (deps.isPortFree ?? defaultTryPort)(port))) {
    throw new Error(`${portInUseHint(port)} Use another port only if its callback URI is registered with SSO.`);
  }
  const callbackUrl = fileEnvironment?.callbackUrl ?? assertCallbackUrl(buildCallbackUrl(port));
  const client = opts.client ?? (await deps.prompter.chooseClient());
  const home = opts.home ?? process.env.HOME ?? "";
  const defaultConfigPath = configPath(opts.local, home);
  const tdeiConfigPath = fileEnvironment?.values["TDEI_CONFIG_PATH"]
    ? resolve(opts.local?.root ?? opts.cwd ?? process.cwd(), fileEnvironment.values["TDEI_CONFIG_PATH"])
    : defaultConfigPath;
  const env: Record<string, string> = fileEnvironment
    ? {
        PATH: process.env.PATH ?? "",
        ...(fileEnvironment.values["TDEI_CONFIG_PATH"] ? {} : { TDEI_CONFIG_PATH: tdeiConfigPath }),
      }
    : {
        PATH: process.env.PATH ?? "",
        TDEI_API_URL: apiUrl,
        TDEI_SPEC_URL: DEFAULT_SPEC_URL,
        TDEI_SSO_CALLBACK_URL: callbackUrl,
        TDEI_CONFIG_PATH: tdeiConfigPath,
      };
  const entry = buildServerEntry(
    nodeExecPath,
    env,
    opts.local?.indexPath ?? opts.serverPath ?? fileURLToPath(new URL("../index.js", import.meta.url)),
    opts.envFile,
  );
  await scaffoldConfig(deps, tdeiConfigPath, opts.local);
  await (deps.verify ?? verifyServer)(entry);
  if (client === "custom") {
    deps.log(formatManual(entry, env));
    deps.log(formatSetupReport({ status: "manual setup", client, apiUrl }));
    return { client, apiUrl, callbackUrl };
  }
  const cwd = opts.cwd ?? process.cwd();
  const path = clientPaths(client, home, cwd);
  const current = await readExisting(deps, path);
  const updated = writeEntry(client, current, entry, env, path);
  await deps.mkdir(dirname(path));
  if (current) await deps.writeFile(`${path}.tdei.bak`, current);
  await deps.writeFile(path, updated);
  if (await deps.readFile(path) !== updated) {
    throw new Error(`configuration readback failed: ${path}`);
  }
  deps.log(formatSetupReport({
    status: "ready",
    client,
    apiUrl,
    configPath: path,
  }));
  return { client, apiUrl, callbackUrl };
}

export async function runSwitch(
  deps: Deps,
  opts: { env?: string | undefined; url?: string | undefined; client?: ClientName | undefined; home?: string; cwd?: string },
): Promise<{ client: ClientName; apiUrl: string }> {
  if (opts.client !== undefined) assertClient(opts.client);
  const client = opts.client ?? (await deps.prompter.chooseClient());
  if (client === "custom") {
    throw new Error("switch needs a client config file (custom has none) — re-run with --client codex|claude|vscode");
  }
  const home = opts.home ?? process.env.HOME ?? "";
  const cwd = opts.cwd ?? process.cwd();
  const path = clientPaths(client, home, cwd);
  const current = await readExisting(deps, path);
  const existing = readEntry(client, current);
  if (!existing.found) {
    throw new Error(`no tdei entry found in ${path} — run "tdei-mcp init" first`);
  }
  const choice = opts.env ?? opts.url ? { env: opts.env, url: opts.url } : await deps.prompter.chooseEnv();
  const apiUrl = resolveApiUrl(choice);
  if (!existing.command || !existing.args?.length) {
    throw new Error("existing launch configuration is incomplete; run init again");
  }
  if (existing.args.some((argument) => argument.startsWith("--env-file="))) {
    throw new Error('this MCP entry uses --env-file; select another file by re-running "tdei-mcp init --client <client> --env-file <path>"');
  }
  const specUrl = existing.env["TDEI_SPEC_URL"] && existing.env["TDEI_SPEC_URL"] !== DEFAULT_SPEC_URL
    ? existing.env["TDEI_SPEC_URL"]!
    : DEFAULT_SPEC_URL;
  const env: Record<string, string> = {
    ...existing.env,
    TDEI_API_URL: apiUrl,
    TDEI_SPEC_URL: specUrl,
    TDEI_SSO_CALLBACK_URL: existing.env["TDEI_SSO_CALLBACK_URL"] ?? buildCallbackUrl(8765),
    TDEI_CONFIG_PATH: existing.env["TDEI_CONFIG_PATH"] ?? configPath(undefined, home),
  };
  delete env.TDEI_SSO_CLIENT_ID;
  const entry: ServerEntry = {
    command: existing.command,
    args: existing.args,
    ...(existing.cwd ? { cwd: existing.cwd } : {}),
    env,
  };
  await (deps.verify ?? verifyServer)(entry);
  const updated = client === "codex"
    ? switchCodexEnv(current, env)
    : writeEntry(client, current, entry, env, path);
  await deps.writeFile(`${path}.tdei.bak`, current);
  await deps.writeFile(path, updated);
  if (await deps.readFile(path) !== updated) {
    throw new Error(`configuration readback failed: ${path}`);
  }
  deps.log(formatSetupReport({
    status: "environment updated",
    client,
    apiUrl,
    configPath: path,
  }));
  return { client, apiUrl };
}
