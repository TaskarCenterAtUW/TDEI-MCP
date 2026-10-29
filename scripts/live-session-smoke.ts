#!/usr/bin/env tsx
/**
 * Live SSO + data test over REAL MCP stdio transport.
 *
 * Replaces the old in-process InMemoryTransport version: spawns the real
 * server as a child (dist/index.js when built, else src/index.ts via tsx),
 * performs the MCP handshake, then:
 *   1. tdei_sso_login -> prints loginUrl, waits up to 5 min for browser SSO
 *   2. asserts tdei_auth_status.authenticated == true
 *   3. waits for generated listServices tool, calls it
 *   4. tdei_resolve_intent "get me datasets for Seattle"
 *      + tdei_find_datasets {place:"Seattle"} -> asserts >=1 match
 *   5. tdei_logout -> asserts signed out
 *
 * Usage:
 *   npm run test:live
 *   node --env-file=.env --import tsx scripts/live-session-smoke.ts [--timeout-ms 20000]
 *
 * Requires one browser SSO login. Tokens live in the child server memory.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = `${REPO_ROOT}/dist/index.js`;
const HAS_DIST = existsSync(DIST);
const HAS_ENV_FILE = existsSync(`${REPO_ROOT}/.env`);
const TIMEOUT_MS = Number(
  process.argv.find((a) => a.startsWith("--timeout-ms="))?.split("=")[1] ??
    process.env.TDEI_LIVE_TIMEOUT_MS ??
    20_000,
);

type TextContent = { type?: string; text?: string };
type ToolResult = {
  isError?: boolean;
  content?: TextContent[];
};

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function main(): Promise<void> {
  const serverArgs = [
    ...(HAS_ENV_FILE ? ["--env-file=.env"] : []),
    HAS_DIST ? "dist/index.js" : "src/index.ts",
    "--transport=stdio",
  ];
  const command = HAS_DIST ? process.execPath : "npx";
  const cmdArgs = HAS_DIST ? serverArgs : ["-y", "tsx", ...serverArgs];

  console.log(
    `[tdei-mcp] live test via MCP stdio (server: ${HAS_DIST ? "dist/index.js" : "src/index.ts via tsx"}, .env: ${HAS_ENV_FILE ? "yes" : "no"})`,
  );

  const transport = new StdioClientTransport({
    command,
    args: cmdArgs,
    cwd: REPO_ROOT,
    // NOTE: no TDEI_NO_RELAY here — live SSO needs the real loopback
    // callback listener on 127.0.0.1:8765.
    env: { ...process.env, TDEI_TRANSPORT: "stdio" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (c: Buffer) => process.stderr.write(c));

  const client = new Client({ name: "tdei-live-mcp-test", version: "1.0.0" });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    if (result.isError) throw new Error(`${name} returned an error: ${textOf(result).slice(0, 500)}`);
    return result;
  }

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`MCP connect timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
    console.log("[tdei-mcp] MCP handshake OK");

    // ---- 1. SSO login ----
    const login = await call("tdei_sso_login");
    const loginMessage = textOf(login);
    console.log("Open the loginUrl below in your browser:\n");
    console.log(loginMessage);
    console.log(
      "If the browser cannot reach the loopback callback, paste its final callback URL here and press Enter.\n",
    );

    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (value) => {
      const callbackUrl = value.trim();
      if (!callbackUrl) return;
      void client
        .callTool({ name: "tdei_sso_complete", arguments: { callbackUrl } })
        .catch((error) => {
          console.error(
            "[auth] callback relay failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
    });

    const loginDeadline = Date.now() + 5 * 60_000;
    while (Date.now() < loginDeadline) {
      const status = await call("tdei_auth_status");
      if (textOf(status).includes('"authenticated": true')) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const status = await call("tdei_auth_status");
    const statusText = textOf(status);
    assert.match(statusText, /"authenticated": true/, "SSO login did not complete within five minutes");
    console.log("[tdei-mcp] SSO authenticated");

    // ---- 2. Generated API tools ----
    const toolDeadline = Date.now() + 30_000;
    let tools: Array<{ name: string }> = [];
    while (Date.now() < toolDeadline) {
      ({ tools } = await client.listTools());
      if (tools.some((t) => t.name === "listServices")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    ({ tools } = await client.listTools());
    assert.ok(
      tools.some((t) => t.name === "listServices"),
      "listServices was not loaded after SSO login",
    );
    await call("listServices");
    console.log(`[tdei-mcp] listServices OK (${tools.length} tools)`);

    // ---- 3. Seattle datasets (semantic path = product path) ----
    const intent = await call("tdei_resolve_intent", { request: "get me datasets for Seattle" });
    const intentText = textOf(intent);
    console.log("[tdei-mcp] tdei_resolve_intent:", intentText.slice(0, 300));
    assert.match(intentText, /find_datasets/, "intent resolver did not map Seattle request to find_datasets");

    const found = await call("tdei_find_datasets", { place: "Seattle", limit: 5 });
    const foundText = textOf(found);
    const parsed = JSON.parse(foundText) as {
      data?: { matches?: Array<{ dataset?: { metadata?: { dataset_detail?: { name?: string } }; tdei_dataset_id?: string; status?: string; data_type?: string } }> };
    };
    const matches = parsed.data?.matches ?? [];
    assert.ok(matches.length > 0, "tdei_find_datasets returned zero matches for Seattle");
    console.log(`[tdei-mcp] tdei_find_datasets Seattle: ${matches.length} match(es)`);
    for (const m of matches.slice(0, 5)) {
      const d = m.dataset;
      console.log(
        `  - ${d?.metadata?.dataset_detail?.name ?? "?"} [${d?.data_type}/${d?.status}] ${d?.tdei_dataset_id ?? ""}`,
      );
    }

    // ---- 4. Logout ----
    await call("tdei_logout");
    const after = textOf(await call("tdei_auth_status"));
    assert.match(after, /"authenticated": false/, "expected logged-out (authenticated:false) after tdei_logout");
    console.log("Live SSO session smoke test passed (MCP stdio + Seattle).");
  } finally {
    process.stdin.pause();
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

await main();
