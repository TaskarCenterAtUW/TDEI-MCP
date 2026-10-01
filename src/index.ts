#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";

import { createServer } from "./server.js";
import { loadConfig, TdeiConfigError } from "./config.js";

export { createServer, type ServerDependencies } from "./server.js";

function failFastConfig(error: unknown): never {
  const errors = error instanceof TdeiConfigError
    ? error.errors
    : [{ var: "unknown", rule: String(error), example: "" }];
  console.error(JSON.stringify({ code: "TDEI_CONFIG_INVALID", errors }));
  process.exit(1);
}

const entryPoint = process.argv[1];

if (
  entryPoint &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
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
    console.error("[tdei-mcp] Starting MCP server");
    await serveStdio(() => createServer());
  } else {
    console.error(`[tdei-mcp] Unknown transport "${transport}". Use --transport=stdio|http.`);
    process.exit(1);
  }
}
