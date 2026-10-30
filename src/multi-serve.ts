#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadMultiMcpFile,
  resolveMultiMcp,
  resolveMultiMcpFilePath,
  type ResolvedMultiMcpServer,
} from "./multi-config.js";

function flagValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (inline !== undefined) return inline.trim();
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1]?.trim();
  return undefined;
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

function indexEntry(): string {
  // dist/multi-serve.js -> dist/index.js (same for src/ under tsx).
  return resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
}

function startChild(server: ResolvedMultiMcpServer, extraEnv: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(
    process.execPath,
    [indexEntry(), "--transport=http", "--port", String(server.port), "--host", server.host],
    {
      env: {
        ...process.env,
        ...extraEnv,
        TDEI_API_URL: server.apiUrl,
        TDEI_SPEC_URL: server.specUrl,
        TDEI_HTTP_HOST: server.host,
        TDEI_HTTP_PORT: String(server.port),
        TDEI_HTTP_BASE_PATH: server.basePath,
        TDEI_SSO_CALLBACK_URL: server.ssoCallbackUrl,
        TDEI_GATEWAY_SLUG: server.slug,
        TDEI_MCP_NAME: server.name,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.log(`[${server.name}] ${line}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.error(`[${server.name}] ${line}`);
    }
  });
  return child;
}

export async function serveMulti(): Promise<{ servers: ResolvedMultiMcpServer[]; close(): Promise<void> }> {
  const filePath = resolveMultiMcpFilePath(flagValue("--file"));
  const file = loadMultiMcpFile(filePath);
  const hostOverride = flagValue("--host");
  const basePortRaw = flagValue("--base-port") ?? flagValue("--port");
  const servers = resolveMultiMcp(file, {
    ...(hostOverride ? { host: hostOverride } : {}),
    ...(basePortRaw !== undefined ? { basePort: Number(basePortRaw) } : {}),
  });

  // Shared TDEI_* env (CORS, geocoder, TLS) is inherited; per-server
  // API/spec/port/path/callback are pinned per child above so the
  // singleton getConfig() in each child stays isolated.
  const children = new Map<string, ChildProcess>();
  for (const server of servers) {
    children.set(server.name, startChild(server, {}));
  }

  console.error(`[multi-mcp] launched ${servers.length} servers from ${filePath}`);
  for (const server of servers) {
    console.error(`[multi-mcp] ${server.name} -> ${server.url} (api ${server.apiUrl})`);
  }

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.all(
      [...children.values()].map(
        (child) =>
          new Promise<void>((resolvePromise) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolvePromise();
              return;
            }
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolvePromise();
            }, 5000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolvePromise();
            });
            child.kill("SIGTERM");
          }),
      ),
    );
  };

  const onSignal = (): void => {
    void close().then(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  for (const [name, child] of children) {
    child.once("exit", (code, signal) => {
      if (closing) return;
      console.error(`[multi-mcp] ${name} exited (code=${code} signal=${signal}) — shutting down remaining servers`);
      void close().then(() => process.exit(code ?? 1));
    });
  }

  return { servers, close };
}

if (isEntryPoint()) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      [
        "Usage: tdei-mcp-multi [--file mcps.json] [--host 127.0.0.1] [--base-port 3000]",
        "",
        "mcps.json:",
        '  {"host":"127.0.0.1","basePort":3000,"servers":[{"name":"tdei-core","apiUrl":"https://api-dev.tdei.us"}]}',
        "Ports auto-increment from basePort; specUrl defaults via specUrlForApiUrl; basePath defaults to /<slug>/mcp.",
      ].join("\n"),
    );
    process.exit(0);
  }
  try {
    await serveMulti();
  } catch (error) {
    console.error(`[multi-mcp] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
