#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createServer } from "./server.js";
import { loadConfig, TdeiConfigError } from "./config.js";

export { createServer, type ServerDependencies } from "./server.js";

/** Message when STDIO is launched from a terminal instead of an MCP client. */
export function interactiveStdioRefusal(stdinIsTTY: boolean): string | undefined {
  if (!stdinIsTTY) return undefined;
  return [
    "[tdei-mcp] STDIO mode is started automatically by your MCP client (e.g. Codex), not from a terminal.",
    "[tdei-mcp] To start a server manually, use Streamable HTTP:",
    "[tdei-mcp]   node --env-file=.env dist/index.js --transport=http --port 3000",
    "[tdei-mcp] Or configure a client: npx -y tdei-mcp init",
  ].join("\n");
}

function failFastConfig(error: unknown): never {
  const errors = error instanceof TdeiConfigError
    ? error.errors
    : [{ var: "unknown", rule: String(error), example: "" }];
  console.error(JSON.stringify({ code: "TDEI_CONFIG_INVALID", errors }));
  process.exit(1);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const command = process.argv[2];
  const isSetupCommand = ["init", "switch", "--help", "-h"].includes(command ?? "")
    || (command !== undefined && !command.startsWith("--"));
  if (isSetupCommand) {
    await import("./init.js");
  } else {
    // Flags accept "--name=value" or "--name value" form; flag wins over env.
    const flagValue = (name: string): string | undefined => {
      const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      if (inline !== undefined) return inline.trim();
      const index = process.argv.indexOf(name);
      if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1].trim();
      return undefined;
    };
    const transportFlag = flagValue("--transport")?.toLowerCase();
    const portFlag = flagValue("--port");
    const hostFlag = flagValue("--host");

    // Fail fast on bad env before serving anything. loadConfig() reads env
    // fresh so CLI --port/--host overrides below still apply afterwards.
    const envCheck = loadConfig();
    if (!envCheck.ok) failFastConfig(new TdeiConfigError(envCheck.errors));
    const transport = transportFlag ?? envCheck.config.transport;

    if (transport === "http") {
      const overrides: { port?: number; host?: string } = {};
      if (portFlag) {
        const port = Number(portFlag);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          console.error("[tdei-mcp] --port must be an integer 1-65535.");
          process.exit(1);
        }
        overrides.port = port;
      }
      if (hostFlag) overrides.host = hostFlag;
      const { serveHttp } = await import("./http.js");
      await serveHttp({}, overrides);
    } else if (transport === "stdio" || transport === "") {
      // STDIO is for MCP clients (Codex, Claude Desktop, etc.) that spawn this
      // process with piped stdin. A terminal TTY means someone started it by hand.
      const refusal = interactiveStdioRefusal(Boolean(process.stdin.isTTY));
      if (refusal) {
        console.error(refusal);
        process.exit(1);
      }
      console.error("[tdei-mcp] Starting MCP server (stdio)");
      await serveStdio(() => createServer());
    } else {
      console.error(`[tdei-mcp] Unknown transport "${transport}". Use --transport=stdio|http.`);
      process.exit(1);
    }
  }
}
