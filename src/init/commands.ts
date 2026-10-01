import { dirname, join } from "node:path";
import { defaultConfigJson } from "../config-file.js";
import { DEFAULT_SPEC_URL, assertCallbackUrl, buildCallbackUrl, resolveApiUrl } from "./envs.js";
import { checkPreflight, type ExecFn } from "./preflight.js";
import { findFreePort } from "./ports.js";
import {
  buildLocalEntry, buildServerEntry, claudeConfigPath, codexConfigPath, formatManual, npxPathFor,
  readClaudeEntry, readCodexEntry, readVscodeEntry, vscodeConfigPath,
  writeClaudeEntry, writeCodexEntry, writeVscodeEntry,
  type ClientName, type ServerEntry,
} from "./clients.js";

export const TDEI_ENV_KEYS = ["TDEI_API_URL", "TDEI_SPEC_URL", "TDEI_SSO_CLIENT_ID", "TDEI_SSO_CALLBACK_URL"];

export interface Prompter {
  chooseEnv(): Promise<{ env?: string; url?: string }>;
  chooseClient(): Promise<ClientName>;
}

export interface Deps {
  exec: ExecFn;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  prompter: Prompter;
  log: (msg: string) => void;
}

export interface LocalCheckout {
  /** Absolute path to the checkout's built dist/index.js. */
  indexPath: string;
  /** Absolute path of the checkout root (tdei.config.json lives here). */
  root: string;
}

function resolveConfigPath(local: LocalCheckout | undefined, home: string): string {
  return local ? join(local.root, "tdei.config.json") : join(home, ".tdei-mcp", "tdei.config.json");
}

// Create-if-missing, never overwrite. The path is also written into the client
// entry as TDEI_CONFIG_PATH because MCP clients start the server in an
// unpredictable working directory.
async function scaffoldConfig(deps: Deps, path: string, local: LocalCheckout | undefined): Promise<void> {
  try {
    if ((await deps.readFile(path)).trim()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  await deps.mkdir(dirname(path));
  await deps.writeFile(path, defaultConfigJson(local ? "./tdei.config.schema.json" : undefined));
  deps.log(`wrote default ${path} (all endpoints enabled, no workflows) — edit it to filter endpoints or add workflows`);
}

export const VERIFY_PROMPT = "Verify: Call tdei_sso_login and give me the loginUrl. After browser login, check tdei_auth_status and call listServices.";

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

function readEntry(client: ClientName, current: string): { found: boolean; env: Record<string, string>; command?: string } {
  if (client === "codex") return readCodexEntry(current);
  if (client === "claude") return readClaudeEntry(current);
  return readVscodeEntry(current);
}

export async function runInit(
  deps: Deps,
  opts: { env?: string; url?: string; client?: ClientName; port?: number; npxPath?: string; nodePath?: string; home?: string; cwd?: string; local?: LocalCheckout },
): Promise<{ client: ClientName; apiUrl: string; callbackUrl: string }> {
  await checkPreflight(deps.exec);
  const choice = opts.env ?? opts.url ? { env: opts.env, url: opts.url } : await deps.prompter.chooseEnv();
  const apiUrl = resolveApiUrl(choice);
  const port = opts.port ?? (await findFreePort(8765));
  const callbackUrl = assertCallbackUrl(buildCallbackUrl(port));
  const client = opts.client ?? (await deps.prompter.chooseClient());
  const nodeExecPath = opts.nodePath ?? (await deps.exec(process.execPath, ["-p", "process.execPath"])).stdout.trim();
  const npxPath = opts.npxPath ?? npxPathFor(nodeExecPath);
  const home = opts.home ?? process.env.HOME ?? "";
  const configPath = resolveConfigPath(opts.local, home);
  const env: Record<string, string> = {
    TDEI_API_URL: apiUrl,
    TDEI_SPEC_URL: DEFAULT_SPEC_URL,
    TDEI_SSO_CLIENT_ID: "tdei-mcp",
    TDEI_SSO_CALLBACK_URL: callbackUrl,
    TDEI_CONFIG_PATH: configPath,
  };
  const entry = opts.local ? buildLocalEntry(nodeExecPath, opts.local.indexPath, env) : buildServerEntry(npxPath, env);
  await scaffoldConfig(deps, configPath, opts.local);
  if (client === "custom") {
    deps.log(formatManual(entry, env));
    deps.log(VERIFY_PROMPT);
    return { client, apiUrl, callbackUrl };
  }
  const cwd = opts.cwd ?? process.cwd();
  const path = clientPaths(client, home, cwd);
  const updated = writeEntry(client, await readExisting(deps, path), entry, env, path);
  await deps.mkdir(dirname(path));
  await deps.writeFile(path, updated);
  deps.log(`wrote ${client} MCP entry for ${apiUrl} to ${path}`);
  deps.log(VERIFY_PROMPT);
  return { client, apiUrl, callbackUrl };
}

export async function runSwitch(
  deps: Deps,
  opts: { env?: string; url?: string; client?: ClientName; home?: string; cwd?: string; local?: LocalCheckout; nodePath?: string },
): Promise<{ client: ClientName; apiUrl: string }> {
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
  const nodeExecPath = opts.nodePath ?? process.execPath;
  const command = existing.command ?? npxPathFor(nodeExecPath);
  const specUrl = existing.env["TDEI_SPEC_URL"] && existing.env["TDEI_SPEC_URL"] !== DEFAULT_SPEC_URL
    ? existing.env["TDEI_SPEC_URL"]!
    : DEFAULT_SPEC_URL;
  const env: Record<string, string> = {
    TDEI_API_URL: apiUrl,
    TDEI_SPEC_URL: specUrl,
    TDEI_SSO_CLIENT_ID: existing.env["TDEI_SSO_CLIENT_ID"] ?? "tdei-mcp",
    TDEI_SSO_CALLBACK_URL: existing.env["TDEI_SSO_CALLBACK_URL"] ?? buildCallbackUrl(8765),
    TDEI_CONFIG_PATH: existing.env["TDEI_CONFIG_PATH"] ?? resolveConfigPath(opts.local, home),
  };
  const entry = opts.local ? buildLocalEntry(nodeExecPath, opts.local.indexPath, env) : buildServerEntry(command, env);
  await deps.writeFile(path, writeEntry(client, current, entry, env, path));
  deps.log(`restart your MCP client to reconnect to ${apiUrl} (tokens are in-memory)`);
  return { client, apiUrl };
}
