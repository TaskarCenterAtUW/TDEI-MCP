#!/usr/bin/env tsx
/**
 * Transport-level check for already-running multi MCP servers.
 * Uses the real MCP client (Streamable HTTP) against each resolved
 * server URL from mcps.json — no raw curl, full initialize handshake.
 *
 * Usage (servers must already be up, e.g. `npm run start:multi`):
 *   node --import tsx scripts/multi-transport-check.ts [--file mcps.json]
 *
 * Exit 0 = all servers passed, 1 = any failure.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  loadMultiMcpFile,
  resolveMultiMcp,
  resolveMultiMcpFilePath,
} from "../src/multi-config.js";

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
  try {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    record(s.name, "tools/list reachable", true, `${tools.length} tools`);
    for (const need of ["tdei_sso_login", "tdei_auth_status", "tdei_test_authentication"]) {
      record(s.name, `has ${need}`, names.has(need));
    }
  } catch (e) {
    record(s.name, "tools/list reachable", false, e instanceof Error ? e.message : String(e));
  }
  for (const tool of ["tdei_auth_status", "tdei_test_authentication"] as const) {
    try {
      const res = await client.callTool({ name: tool, arguments: {} });
      const text = (res.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => (c as { text?: string }).text ?? "")
        .join("\n");
      // tdei_test_authentication signed-out returns isError with
      // TDEI_SSO_REQUIRED — still a successful transport round-trip.
      const ok =
        tool === "tdei_auth_status" ? !res.isError : text.includes("SSO login is required");
      record(s.name, `call ${tool} (signed-out safe)`, ok, text.slice(0, 100).replace(/\n/g, " "));
    } catch (e) {
      record(s.name, `call ${tool}`, false, e instanceof Error ? e.message : String(e));
    }
  }
  try {
    await client.close();
  } catch {
    /* ignore */
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n== SUMMARY: ${checks.length - failed.length}/${checks.length} passed ==`);
if (failed.length > 0) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - [${f.server}] ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log("All running servers answer over real MCP transport with correct per-server routing.");
