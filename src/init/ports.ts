export async function findFreePort(
  fromPort = 8765,
  tryPort: (port: number) => Promise<boolean> = defaultTryPort,
): Promise<number> {
  for (let port = fromPort; port < fromPort + 100; port += 1) {
    if (await tryPort(port)) return port;
  }
  throw new Error(`no free loopback port found starting at ${fromPort} (tried 100 ports). Stop the process holding port ${fromPort} and re-run tdei-mcp-init`);
}

async function defaultTryPort(port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
