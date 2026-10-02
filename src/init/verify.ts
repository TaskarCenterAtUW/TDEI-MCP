import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { ServerEntry } from "./clients.js";

export async function verifyServer(entry: ServerEntry): Promise<void> {
  const transport = new StdioClientTransport({ ...entry, stderr: "pipe" });
  const client = new Client({ name: "tdei-setup", version: "0.1.0" });
  transport.stderr?.on("data", () => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect(transport);
        const result = await client.listTools();
        if (!result.tools.some((tool) => tool.name === "tdei_sso_login")) {
          throw new Error("tools/list did not expose tdei_sso_login");
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("MCP verification timed out after 120 seconds")),
          120_000,
        );
      }),
    ]);
  } catch (error) {
    throw new Error(
      `MCP setup verification failed (${entry.command} ${JSON.stringify(entry.args)}): ${error instanceof Error ? error.message : String(error)}. Configuration was not changed.`,
    );
  } finally {
    clearTimeout(timer);
    await client.close();
    await transport.close();
  }
}
