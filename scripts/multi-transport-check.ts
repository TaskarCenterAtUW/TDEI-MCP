#!/usr/bin/env tsx
/**
 * Transport-level check for already-running multi MCP servers (gateway children:
 * lazy auth, so tools list without a sign-in and the first protected call is challenged).
 * Uses the real MCP client (Streamable HTTP) against each resolved
 * server URL from mcps.json — no raw curl, full initialize handshake.
 *
 * Usage (servers must already be up, e.g. `pnpm start:multi`):
 *   node --import tsx scripts/multi-transport-check.ts [--file mcps.json]
 *
 * Exit 0 = all servers passed, 1 = any failure.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { loadMultiMcpFile, resolveMultiMcp, resolveMultiMcpFilePath } from "../src/multi-config.js";

type Check = { server: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(server: string, name: string, ok: boolean, detail = "") {
  checks.push({ server, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${server}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function flagValue(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  if (inline !== undefined) return inline.trim();
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1]?.trim();
  }
  return undefined;
}

const servers = resolveMultiMcp(loadMultiMcpFile(resolveMultiMcpFilePath(flagValue("--file"))));
console.log(`multi transport check: ${servers.length} servers`);

/* oxlint-disable no-await-in-loop -- servers are checked one at a time so the report stays in file order and a slow server cannot stall the others' output */
for (const s of servers) {
  console.log(`\n== ${s.name} (${s.url}) ==`);
  const client = new Client({ name: "tdei-multi-check", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(s.url)));
    record(s.name, "handshake (initialize)", true);
  } catch (e) {
    record(s.name, "handshake (initialize)", false, e instanceof Error ? e.message : String(e));
    continue;
  }
  // Gateway children use lazy auth: connecting and listing tools never needs a
  // sign-in, and the first protected call is answered with an OAuth challenge.
  let firstTool: string | undefined;
  try {
    const { tools } = await client.listTools();
    firstTool = tools.find((t) => !t.name.startsWith("tdei_sso_") && t.name !== "tdei_health")?.name;
    record(s.name, "tools/list reachable without sign-in", tools.length > 0, `${tools.length} tools`);
  } catch (e) {
    record(s.name, "tools/list reachable without sign-in", false, e instanceof Error ? e.message : String(e));
  }
  if (firstTool) {
    try {
      const res = await fetch(s.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: firstTool, arguments: {} },
        }),
      });
      const challenge = res.headers.get("www-authenticate") ?? "";
      record(
        s.name,
        `protected call "${firstTool}" is challenged for sign-in`,
        res.status === 401 && /resource_metadata=/.test(challenge),
        `HTTP ${res.status}`,
      );
    } catch (e) {
      record(s.name, "protected call challenge", false, e instanceof Error ? e.message : String(e));
    }
  }
  try {
    await client.close();
  } catch {
    /* ignore */
  }
}
/* oxlint-enable no-await-in-loop */

const failed = checks.filter((c) => !c.ok);
console.log(`\n== SUMMARY: ${checks.length - failed.length}/${checks.length} passed ==`);
if (failed.length > 0) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - [${f.server}] ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log("All running servers answer over real MCP transport with correct per-server routing.");
