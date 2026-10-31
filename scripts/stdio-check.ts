#!/usr/bin/env tsx
/**
 * Stdio startup check: spawns the real built server (dist/index.js) as a
 * child over stdio, performs the MCP handshake (initialize + listTools),
 * prints status, then tears everything down and exits.
 *
 * Usage:
 *   pnpm check:stdio
 *   node --env-file=.env --import tsx scripts/stdio-check.ts [--timeout-ms 15000]
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const timeoutMs = Number(
  process.argv.find((a) => a.startsWith("--timeout-ms="))?.split("=")[1] ??
    process.env.TDEI_STDIO_CHECK_TIMEOUT_MS ??
    15_000,
);

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    // --transport=stdio wins over .env's TDEI_TRANSPORT=http (see src/index.ts);
    // env override is belt-and-braces since --env-file never clobbers real env.
    args: ["--env-file=.env", "dist/index.js", "--transport=stdio"],
    env: { ...process.env, TDEI_TRANSPORT: "stdio" },
    stderr: "pipe", // keep server logs off stdout (stdout is JSON-RPC)
  });

  // Surface server stderr (e.g. "[tdei-mcp] Starting MCP server") to our stderr
  // so config errors are visible even when the handshake fails.
  transport.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  const client = new Client({ name: "tdei-stdio-check", version: "0.1.0" });
  const timer = setTimeout(() => {
    console.error(`[tdei-mcp] stdio check TIMED OUT after ${timeoutMs}ms`);
    process.exit(2);
  }, timeoutMs);
  timer.unref?.();

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    clearTimeout(timer);
    console.log(`[tdei-mcp] stdio check OK: server started, handshake succeeded, ${tools.length} tool(s) listed.`);
  } catch (error) {
    clearTimeout(timer);
    console.error("[tdei-mcp] stdio check FAILED:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors - exit code already set
    }
    // Give the child a moment to exit, then force it; otherwise the
    // parent hangs and the user is back to pressing CTRL+C.
    await new Promise((r) => setTimeout(r, 250));
    process.exit(process.exitCode ?? 0);
  }
}

await main();
