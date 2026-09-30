export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export async function checkPreflight(exec: ExecFn): Promise<{ nodeVersion: string; uvxVersion: string }> {
  const nodeOut = (await exec("node", ["--version"])).stdout.trim();
  const major = Number.parseInt(nodeOut.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`tdei-mcp requires Node.js >=22 (found ${nodeOut}). Download from https://nodejs.org/`);
  }
  let uvxVersion: string;
  try {
    uvxVersion = (await exec("uvx", ["--version"])).stdout.trim();
  } catch {
    throw new Error("uvx not found on PATH. Install uv from https://docs.astral.sh/uv/, ensure uvx is on PATH, then re-run tdei-mcp-init");
  }
  return { nodeVersion: nodeOut, uvxVersion };
}
