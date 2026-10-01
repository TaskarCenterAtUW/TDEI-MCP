import { portInUseHint } from "../port-hint.js";

export { portInUseHint };

export function assertPort(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`--port must be an integer between 1024 and 65535 (got "${String(value)}")`);
  }
  return n;
}

export async function findFreePort(
  fromPort = 8765,
  tryPort: (port: number) => Promise<boolean> = defaultTryPort,
): Promise<number> {
  for (let port = fromPort; port < fromPort + 100; port += 1) {
    if (await tryPort(port)) return port;
  }
  throw new Error(`No free loopback port found in ${fromPort}-${fromPort + 99}. ${portInUseHint(fromPort)}`);
}

export async function defaultTryPort(port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
