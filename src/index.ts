#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";

import { createServer } from "./server.js";

export { createServer, type ServerDependencies } from "./server.js";

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
  const transport = transportFlag ?? process.env.TDEI_TRANSPORT?.trim().toLowerCase() ?? "stdio";

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
