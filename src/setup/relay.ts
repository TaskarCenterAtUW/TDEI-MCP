import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { publicAuthCallbackUrl } from "../sso-public-callback.js";

/**
 * One-shot loopback relay: the Keycloak client only accepts
 * http://127.0.0.1:8765/callback, so forward that hit to the hosted gateway.
 * Same program as the curl installer writes; quits after one callback or 300s.
 */
function relayProgram(targetBase: string, port: number): string {
  return `const http = require("node:http");
const targetBase = ${JSON.stringify(targetBase)};
const port = ${port};
const idle = setTimeout(() => process.exit(0), 300000);
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1:" + port);
  if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
    const dest = new URL(targetBase);
    dest.search = url.search;
    res.writeHead(302, { Location: dest.toString(), "Cache-Control": "no-store" });
    res.end(() => { clearTimeout(idle); setTimeout(() => process.exit(0), 200); });
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
server.on("error", () => process.exit(0));
server.listen(port, "127.0.0.1");
`;
}

export function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Writes ~/.tdei-mcp/sso-callback-relay.cjs and starts it detached. Returns its path. */
export function startCallbackRelay(home: string, gatewayOrigin: string, port = 8765): string {
  const dir = join(home, ".tdei-mcp");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "sso-callback-relay.cjs");
  writeFileSync(script, relayProgram(publicAuthCallbackUrl(gatewayOrigin), port), "utf-8");
  spawn(process.execPath, [script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return script;
}
