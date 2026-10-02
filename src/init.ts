#!/usr/bin/env node
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { runInit, runSwitch, type LocalCheckout } from "./init/commands.js";
import { CLIENTS, type ClientName } from "./init/clients.js";
import { assertPort } from "./init/ports.js";

function detectCheckout(): LocalCheckout | undefined {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(join(root, "src", "index.ts"))) return undefined;
  const indexPath = join(root, "dist", "index.js");
  if (!existsSync(indexPath)) {
    throw new Error(`dist/index.js not found in ${root} — run "npm ci" and "npm run build" there first, then re-run init`);
  }
  return { root, indexPath };
}

function usage(): string {
  return [
    "Usage:",
    "  tdei-mcp init [--env dev|stage|prod | --url <https-url> | --env-file <path>] [--client codex|claude|vscode|custom] [--port <n>] [--install-uv|--no-install-uv]",
    "  tdei-mcp switch base-url [--env dev|stage|prod] [--url <https-url>] [--client codex|claude|vscode]",
    "",
    "First setup: tdei-mcp init. Change environment: tdei-mcp switch base-url.",
  ].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const execFn = (cmd: string, args: string[]) =>
  new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout: String(stdout) })
    );
  });

async function interactivePrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async chooseEnv() {
      for (;;) {
        const answer = (await rl.question("TDEI base URL (e.g. https://api-dev.tdei.us — a portal page or endpoint path is fine, only the host is used): ")).trim();
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
  writeFile: async (p: string, c: string) => {
    const temporary = `${p}.${process.pid}.tmp`;
    await writeFile(temporary, c, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, p);
  },
  mkdir: (p: string) => mkdir(p, { recursive: true }).then(() => undefined),
  log: (m: string) => console.error(m),
};

try {
  if (sub === "init" || sub === "switch") {
    const flags = sub === "switch" ? rest.slice(1) : rest;
    const valued = new Set(["--env", "--url", "--client", ...(sub === "init" ? ["--port", "--env-file"] : [])]);
    for (let index = 0; index < flags.length; index += 1) {
      if (sub === "init" && ["--install-uv", "--no-install-uv"].includes(flags[index] as string)) continue;
      if (!valued.has(flags[index] as string)) throw new Error(`unknown option ${flags[index]}; run tdei-mcp --help`);
      if (!flags[index + 1] || flags[index + 1]?.startsWith("--")) {
        throw new Error(`missing value for ${flags[index]}`);
      }
      index += 1;
    }
  }
  if (sub === "init") {
    const prompter = await interactivePrompter();
    try {
      const portFlag = flag(rest, "--port");
      const envFlag = flag(rest, "--env");
      const urlFlag = flag(rest, "--url");
      const clientFlag = flag(rest, "--client");
      const envFileFlag = flag(rest, "--env-file");
      const local = detectCheckout();
      let serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
      if (serverPath.split(/[\\/]/).includes("_npx")) {
        const packageRoot = dirname(dirname(serverPath));
        const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string };
        const runtimeRoot = process.env.CODEX_HOME || join(homedir(), ".codex");
        const runtime = join(runtimeRoot, "tdei-runtime", packageJson.version);
        await mkdir(runtime, { recursive: true });
        await cp(join(packageRoot, "dist"), join(runtime, "dist"), { recursive: true });
        await cp(dirname(packageRoot), join(runtime, "node_modules"), { recursive: true });
        await cp(join(packageRoot, "package.json"), join(runtime, "package.json"));
        serverPath = join(runtime, "dist", "index.js");
      }
      await runInit({ ...depsBase, prompter }, {
        serverPath,
        ...(envFlag ? { env: envFlag } : {}),
        ...(urlFlag ? { url: urlFlag } : {}),
        ...(envFileFlag ? { envFile: resolve(envFileFlag) } : {}),
        ...(clientFlag ? { client: clientFlag as ClientName } : {}),
        ...(portFlag === undefined ? {} : { port: assertPort(portFlag) }),
        ...(rest.includes("--install-uv")
          ? { installUv: true }
          : rest.includes("--no-install-uv")
            ? { installUv: false }
            : {}),
        ...(local ? { local } : {}),
      });
    } finally {
      prompter.close();
    }
  } else if (sub === "switch" && rest[0] === "base-url") {
    const prompter = await interactivePrompter();
    try {
      const envFlag = flag(rest, "--env");
      const urlFlag = flag(rest, "--url");
      const clientFlag = flag(rest, "--client");
      await runSwitch({ ...depsBase, prompter }, {
        ...(envFlag ? { env: envFlag } : {}),
        ...(urlFlag ? { url: urlFlag } : {}),
        ...(clientFlag ? { client: clientFlag as ClientName } : {}),
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
