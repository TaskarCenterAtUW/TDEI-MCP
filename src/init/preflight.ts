export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export interface PreflightOptions {
  nodePath?: string;
}

async function probe(exec: ExecFn, cmd: string): Promise<string | undefined> {
  try {
    return (await exec(cmd, ["--version"])).stdout.trim();
  } catch {
    return undefined;
  }
}

export async function checkPreflight(
  exec: ExecFn,
  options: PreflightOptions = {},
): Promise<{ nodeVersion: string }> {
  const nodeOut = await probe(exec, options.nodePath ?? "node");
  if (nodeOut === undefined) {
    throw new Error("node not found on PATH. Install Node.js >=22 from https://nodejs.org/ and re-run init.");
  }
  const major = Number.parseInt(nodeOut.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`tdei-mcp requires Node.js >=22 (found ${nodeOut}). Download from https://nodejs.org/`);
  }

  return { nodeVersion: nodeOut };
}
