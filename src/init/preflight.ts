import { homedir } from "node:os";
import { join } from "node:path";

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export interface PreflightOptions {
  /** Called when uvx is missing; return true to run the official uv installer. */
  confirmInstall?: () => Promise<boolean>;
  log?: (message: string) => void;
  platform?: string;
  home?: string;
}

const UV_DOCS = "https://docs.astral.sh/uv/getting-started/installation/";

export function uvInstallCommand(platform: string = process.platform): { cmd: string; args: string[]; display: string } {
  if (platform === "win32") {
    const script = "irm https://astral.sh/uv/install.ps1 | iex";
    return { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", script], display: `powershell -ExecutionPolicy ByPass -c "${script}"` };
  }
  const script = "curl -LsSf https://astral.sh/uv/install.sh | sh";
  return { cmd: "sh", args: ["-c", script], display: script };
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
  opts: PreflightOptions = {},
): Promise<{ nodeVersion: string; uvxVersion: string }> {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? (() => undefined);

  const nodeOut = await probe(exec, "node");
  if (nodeOut === undefined) {
    throw new Error("node not found on PATH. Install Node.js >=22 from https://nodejs.org/ and re-run init.");
  }
  const major = Number.parseInt(nodeOut.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`tdei-mcp requires Node.js >=22 (found ${nodeOut}). Download from https://nodejs.org/`);
  }

  const found = await probe(exec, "uvx");
  if (found !== undefined) return { nodeVersion: nodeOut, uvxVersion: found };

  const install = uvInstallCommand(platform);
  const manual = `Install uv (${UV_DOCS}) — e.g. run: ${install.display} — make sure uvx is on PATH, then re-run init.`;
  if (!opts.confirmInstall || !(await opts.confirmInstall())) {
    throw new Error(`uvx not found on PATH (uv is required to run the AWS OpenAPI server). ${manual}`);
  }

  log(`installing uv: ${install.display}`);
  try {
    await exec(install.cmd, install.args);
  } catch (error) {
    throw new Error(`uv installation failed: ${error instanceof Error ? error.message : String(error)}. ${manual}`);
  }

  const afterInstall = await probe(exec, "uvx");
  if (afterInstall !== undefined) return { nodeVersion: nodeOut, uvxVersion: afterInstall };

  // The installer adds its directory to PATH for NEW shells only.
  const home = opts.home ?? homedir();
  const exe = platform === "win32" ? "uvx.exe" : "uvx";
  for (const dir of [join(home, ".local", "bin"), join(home, ".cargo", "bin")]) {
    const candidate = join(dir, exe);
    const version = await probe(exec, candidate);
    if (version !== undefined) {
      log(`uv installed at ${dir}, which is not on this shell's PATH. Open a new terminal and fully restart your MCP client so it can find uvx.`);
      return { nodeVersion: nodeOut, uvxVersion: version };
    }
  }
  throw new Error(`uv installer finished but uvx was not found. ${manual}`);
}
