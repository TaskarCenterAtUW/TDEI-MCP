import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

import { SetupUsageError } from "./errors.js";
import {
  isTdeiEntryName,
  removeEntries,
  SETUP_CLIENTS,
  upsertEntry,
  type HostEnv,
  type SetupClient,
} from "./clients.js";
import { detectClients, systemProbe, type DetectProbe } from "./detect.js";
import { isLoopbackOrigin, startCallbackRelay } from "./relay.js";
import {
  resolveGateway,
  resolveTargets,
  npxSetupCommand,
  SETUP_ENVS,
  SETUP_PROFILES,
  type SetupEnv,
  type SetupProfile,
} from "./targets.js";

/** The command a user runs to start setup, shown in error messages. */
const SETUP_EXAMPLE = `${npxSetupCommand()} --env dev`;

function setupUsage(): string {
  return [
    "Usage:",
    "  tdei-mcp setup --env dev|stage|prod [--profile core|workspace|both] [--gateway <https-origin>]",
    "                 [--client codex,cursor,...] [--dry-run] [--yes] [--no-relay]",
    "  tdei-mcp setup cleanup [--client <list>] [--dry-run] [--yes]",
    "",
    "Detects the MCP clients installed on this machine (codex, opencode, claude-cli, claude-desktop,",
    "vscode, cursor) and adds the hosted TDEI connectors to them. `cleanup` removes every tdei / tdei-*",
    "entry and keeps all other servers. --client skips detection. Nothing is written without --yes or a",
    "confirmation; --dry-run only prints the plan.",
  ].join("\n");
}

interface SetupArgs {
  mode: "install" | "cleanup";
  env?: SetupEnv;
  profile: SetupProfile;
  gateway?: string;
  clients?: SetupClient[];
  dryRun: boolean;
  yes: boolean;
  relay: boolean;
  help: boolean;
}

const VALUED = new Set(["--env", "--profile", "--gateway", "--client"]);
const EXAMPLE_VALUE: Record<string, string> = {
  "--env": "dev",
  "--profile": "both",
  "--gateway": "https://tdei-mcp.example.org",
  "--client": "codex,cursor",
};

export function parseSetupArgs(argv: string[]): SetupArgs {
  const args: SetupArgs = { mode: "install", profile: "both", dryRun: false, yes: false, relay: true, help: false };
  // Accept --flag=value as well as --flag value.
  const list = argv.flatMap((arg) => {
    const eq = arg.indexOf("=");
    return arg.startsWith("--") && eq > 0 && VALUED.has(arg.slice(0, eq))
      ? [arg.slice(0, eq), arg.slice(eq + 1)]
      : [arg];
  });
  if (list[0] === "cleanup") {
    args.mode = "cleanup";
    list.shift();
  }
  for (let index = 0; index < list.length; index += 1) {
    const flag = list[index] as string;
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--yes" || flag === "-y") args.yes = true;
    else if (flag === "--no-relay") args.relay = false;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (VALUED.has(flag)) {
      const value = list[index + 1];
      if (!value || value.startsWith("--"))
        throw new SetupUsageError(`Missing value for ${flag}. Example: ${flag} ${EXAMPLE_VALUE[flag]}`);
      index += 1;
      if (flag === "--env") {
        if (!(SETUP_ENVS as readonly string[]).includes(value)) {
          throw new SetupUsageError(`Invalid --env "${value}". Choose one of: ${SETUP_ENVS.join(", ")}.`);
        }
        args.env = value as SetupEnv;
      } else if (flag === "--profile") {
        if (!(SETUP_PROFILES as readonly string[]).includes(value)) {
          throw new SetupUsageError(`Invalid --profile "${value}". Choose one of: ${SETUP_PROFILES.join(", ")}.`);
        }
        args.profile = value as SetupProfile;
      } else if (flag === "--gateway") {
        args.gateway = value;
      } else {
        const requested = value
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
        const unknown = requested.filter((item) => !(SETUP_CLIENTS as readonly string[]).includes(item));
        if (unknown.length > 0) {
          throw new SetupUsageError(
            `Unknown client ${unknown.join(", ")} in --client. Choose from: ${SETUP_CLIENTS.join(", ")}.`,
          );
        }
        args.clients = requested as SetupClient[];
      }
    } else {
      throw new SetupUsageError(
        flag.startsWith("-")
          ? `Unknown option ${flag}.`
          : `Unexpected argument "${flag}". The only subcommand is "cleanup"; to install use ${SETUP_EXAMPLE}.`,
      );
    }
  }
  return args;
}

const RESTART: Record<SetupClient, string> = {
  codex: "quit and reopen Codex, then start a new chat",
  opencode: "quit and reopen OpenCode, then start a new session",
  "claude-cli": "exit Claude Code and start a new session",
  "claude-desktop": "fully quit Claude Desktop (Cmd+Q / File > Exit), reopen it, then start a new chat",
  vscode: "reload the VS Code window (Developer: Reload Window), then start a new chat",
  cursor: "quit and reopen Cursor, then start a new chat",
};

export interface SetupDeps {
  host?: HostEnv;
  probe?: DetectProbe;
  log?: (message: string) => void;
  isTty?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Asks which environment to install when --env is missing (terminal only). */
  chooseEnv?: () => Promise<SetupEnv>;
  /** Starts the SSO callback relay; injectable so tests never spawn a process. */
  startRelay?: (home: string, gatewayOrigin: string) => string;
}

async function ttyConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function ttyChooseEnv(): Promise<SetupEnv> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Environment (${SETUP_ENVS.join("/")}): `)).trim().toLowerCase();
    if ((SETUP_ENVS as readonly string[]).includes(answer)) return answer as SetupEnv;
    throw new SetupUsageError(`Unknown environment "${answer}". Choose one of: ${SETUP_ENVS.join(", ")}.`);
  } finally {
    rl.close();
  }
}

/** Returns a process exit code. */
export async function runSetup(argv: string[], deps: SetupDeps = {}): Promise<number> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const args = parseSetupArgs(argv);
  if (args.help) {
    log(setupUsage());
    return 0;
  }
  const host: HostEnv = deps.host ?? {
    home: homedir(),
    platform: process.platform,
    appData: process.env["APPDATA"],
  };
  const probe = deps.probe ?? systemProbe();

  if (args.mode === "install" && !args.env) {
    const interactive = deps.isTty ?? Boolean(process.stdin.isTTY);
    if (!interactive && !deps.chooseEnv) {
      throw new SetupUsageError(
        `Missing required option --env. Choose the TDEI environment: ${SETUP_ENVS.join(", ")}.\n  Example: ${SETUP_EXAMPLE}\n  (Run in a terminal without --env to be asked.)`,
      );
    }
    args.env = await (deps.chooseEnv ?? ttyChooseEnv)();
  }
  // 1. Which clients?
  let clients: SetupClient[];
  if (args.clients) {
    clients = args.clients;
  } else {
    const found = detectClients(host, probe);
    log(found.length > 0 ? "Detected MCP clients:" : "No supported MCP client detected.");
    for (const item of found) log(`  - ${item.client} (${item.evidence})`);
    const missing = SETUP_CLIENTS.filter((client) => !found.some((item) => item.client === client));
    if (missing.length > 0 && found.length > 0) log(`Not found: ${missing.join(", ")} (use --client to force one)`);
    clients = found.map((item) => item.client);
  }
  if (clients.length === 0) {
    log(
      `No supported MCP client was detected, so nothing was changed.\n  Name the client yourself: ${SETUP_EXAMPLE} --client ${SETUP_CLIENTS.join("|")}`,
    );
    return 1;
  }

  // 2. What to do?
  const targets =
    args.mode === "install" && args.env ? resolveTargets(args.env, args.profile, resolveGateway(args.gateway)) : [];
  log("");
  log(
    args.mode === "install"
      ? "Plan: add these connectors to each client"
      : "Plan: remove every tdei / tdei-* entry from each client",
  );
  for (const target of targets) log(`  + ${target.name} -> ${target.url}`);
  log(`  clients: ${clients.join(", ")}`);
  if (args.dryRun) {
    log("Dry run: nothing written.");
    return 0;
  }

  // 3. Confirm.
  if (!args.yes) {
    const interactive = deps.isTty ?? Boolean(process.stdin.isTTY);
    if (!interactive && !deps.confirm) {
      log("This is not an interactive terminal, so nothing was written. Re-run with --yes to apply the plan above.");
      return 1;
    }
    if (!(await (deps.confirm ?? ttyConfirm)("Apply? [y/N] "))) {
      log("Cancelled; nothing written.");
      return 1;
    }
  }

  // 4. Apply.
  let failures = 0;
  let changed = 0;
  for (const client of clients) {
    if (args.mode === "install") {
      for (const target of targets) {
        const result = upsertEntry(client, host, target.name, target.url);
        if (result.status === "written") {
          changed += 1;
          log(`[${client}] ${target.name} written to ${result.filePath}`);
        } else {
          failures += 1;
          log(`[${client}] SKIPPED ${result.filePath}: ${result.reason}`);
        }
      }
    } else {
      const result = removeEntries(client, host, isTdeiEntryName);
      if (result.reason) {
        failures += 1;
        log(`[${client}] SKIPPED ${result.filePath}: ${result.reason}`);
      } else if (result.removed.length > 0) {
        changed += result.removed.length;
        log(`[${client}] removed ${result.removed.join(", ")} from ${result.filePath}`);
      } else {
        log(`[${client}] no tdei entries in ${result.filePath}`);
      }
    }
  }

  // 5. SSO relay (install only, remote gateways only).
  if (args.mode === "install" && args.relay && !process.env["TDEI_NO_RELAY"] && changed > 0 && args.env) {
    const gateway = resolveGateway(args.gateway);
    if (!isLoopbackOrigin(gateway)) {
      const start = deps.startRelay ?? startCallbackRelay;
      start(host.home, gateway);
      log(`Local SSO callback relay on http://127.0.0.1:8765/callback -> ${gateway}/auth/callback`);
    }
  }

  if (changed > 0) {
    log("");
    log("=== RESTART REQUIRED ===");
    for (const client of clients) log(`  ${client}: ${RESTART[client]}`);
    if (args.mode === "install")
      log(
        "Then ask your agent to use any TDEI tool. The first call starts the TDEI sign-in: approve the browser login and the call is retried.",
      );
  }
  return failures > 0 ? 1 : 0;
}
