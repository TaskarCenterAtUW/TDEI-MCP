#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { runInit, runSwitch } from "./init/commands.js";
import { CLIENTS, type ClientName } from "./init/clients.js";
import { ENVS } from "./init/envs.js";

function usage(): string {
  return [
    "Usage:",
    "  tdei-mcp-init init [--env dev|stage|prod] [--url <https-url>] [--client codex|claude|vscode|custom] [--port <n>]",
    "  tdei-mcp-init switch base-url [--env dev|stage|prod] [--url <https-url>] [--client codex|claude|vscode]",
    "",
    "First setup: tdei-mcp-init init. Change environment: tdei-mcp-init switch base-url.",
  ].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const execFn = (cmd: string, args: string[]) =>
  new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(cmd, args, (error, stdout) => (error ? reject(error) : resolve({ stdout: String(stdout) })));
  });

async function interactivePrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async chooseEnv() {
      const names = Object.keys(ENVS);
      const answer = (await rl.question(`TDEI environment (${names.join("/")}/custom) [dev]: `)).trim() || "dev";
      if (answer === "custom") {
        const url = (await rl.question("Custom TDEI API URL (https://...): ")).trim();
        return { url };
      }
      return { env: answer };
    },
    async chooseClient(): Promise<ClientName> {
      const answer = (await rl.question(`MCP client (${CLIENTS.join("/")}) [codex]: `)).trim() || "codex";
      if ((CLIENTS as readonly string[]).includes(answer)) return answer as ClientName;
      throw new Error(`unknown client "${answer}" (expected one of: ${CLIENTS.join(", ")})`);
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
        port: portFlag === undefined ? undefined : Number(portFlag),
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
