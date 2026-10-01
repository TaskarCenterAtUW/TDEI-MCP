#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { assertPort } from "./init/ports.js";
import { runInit, runSwitch, type LocalCheckout } from "./init/commands.js";
import { CLIENTS, type ClientName } from "./init/clients.js";

// dist/init.js -> package root. A git checkout has src/; the published npm
// package ships only dist/, so its absence means "run via npx".
function detectCheckout(): LocalCheckout | undefined {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(join(root, "src", "index.ts"))) return undefined;
  const indexPath = join(root, "dist", "index.js");
  if (!existsSync(indexPath)) throw new Error(`dist/index.js not found in ${root} — run "npm ci" and "npm run build" there first, then re-run init`);
  return { root, indexPath };
}

function usage(): string {
  return [
    "Usage:",
    "  tdei-mcp init [--env stage|prod] [--url <https-url>] [--client codex|claude|vscode|custom] [--port <n>] [--install-uv|--no-install-uv]",
    "  tdei-mcp switch base-url [--env stage|prod] [--url <https-url>] [--client codex|claude|vscode]",
    "",
    "First setup: init. Change environment: switch base-url.",
  ].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const execFn = (cmd: string, args: string[]) =>
  new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (error, stdout) => (error ? reject(error) : resolve({ stdout: String(stdout) })));
  });

async function interactivePrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async chooseEnv() {
      for (;;) {
        const answer = (await rl.question("TDEI base URL (e.g. https://api.tdei.us — a portal page or endpoint path is fine, only the host is used): ")).trim();
        if (answer) return { url: answer };
        console.error("A base URL is required — there is no default.");
      }
    },
    async chooseClient(): Promise<ClientName> {
      const answer = (await rl.question(`MCP client (${CLIENTS.join("/")}) [codex]: `)).trim() || "codex";
      if ((CLIENTS as readonly string[]).includes(answer)) return answer as ClientName;
      throw new Error(`unknown client "${answer}" (expected one of: ${CLIENTS.join(", ")})`);
    },
    async confirm(question: string): Promise<boolean> {
      // No TTY (CI, piped input): never block waiting for an answer.
      if (!process.stdin.isTTY) return false;
      return /^y(es)?$/i.test((await rl.question(question)).trim());
    },
    close() { rl.close(); },
  };
}

const [, , sub, ...rest] = process.argv;
const depsBase = {
  exec: execFn,
  readFile: (p: string) => readFile(p, "utf8"),
  writeFile: (p: string, c: string) => writeFile(p, c, "utf8"),
  mkdir: (p: string) => mkdir(p, { recursive: true }).then(() => undefined),
  log: (m: string) => console.error(m),
};

try {
  if (sub === "init") {
    const prompter = await interactivePrompter();
    try {
      const portFlag = flag(rest, "--port");
      await runInit({ ...depsBase, prompter }, {
        env: flag(rest, "--env"),
        url: flag(rest, "--url"),
        client: flag(rest, "--client") as ClientName | undefined,
        port: portFlag === undefined ? undefined : assertPort(portFlag),
        local: detectCheckout(),
        installUv: rest.includes("--install-uv") ? true : rest.includes("--no-install-uv") ? false : undefined,
      });
    } finally {
      prompter.close();
    }
  } else if (sub === "switch" && rest[0] === "base-url") {
    const prompter = await interactivePrompter();
    try {
      await runSwitch({ ...depsBase, prompter }, {
        env: flag(rest, "--env"),
        url: flag(rest, "--url"),
        client: flag(rest, "--client") as ClientName | undefined,
        local: detectCheckout(),
      });
    } finally {
      prompter.close();
    }
  } else {
    console.error(usage());
    process.exitCode = sub === "--help" || sub === "-h" ? 0 : 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
