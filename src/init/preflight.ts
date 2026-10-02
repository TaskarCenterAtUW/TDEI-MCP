import { homedir } from "node:os";
import { join } from "node:path";

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export interface PreflightOptions {
  confirmInstall?: () => Promise<boolean>;
  log?: (message: string) => void;
  platform?: string;
  home?: string;
  nodePath?: string;
}

const UV_DOCS = "https://docs.astral.sh/uv/getting-started/installation/";

export function uvInstallCommand(
  platform: string = process.platform,
): { cmd: string; args: string[]; display: string } {
  if (platform === "win32") {
    const script = "irm https://astral.sh/uv/install.ps1 | iex";
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", script],
      display: `powershell -ExecutionPolicy ByPass -c "${script}"`,
    };
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
  options: PreflightOptions = {},
): Promise<{ nodeVersion: string; uvxVersion: string }> {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => undefined);
  const nodeOut = await probe(exec, options.nodePath ?? "node");
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
  if (!options.confirmInstall || !(await options.confirmInstall())) {
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

  const home = options.home ?? homedir();
  const executable = platform === "win32" ? "uvx.exe" : "uvx";
  for (const directory of [join(home, ".local", "bin"), join(home, ".cargo", "bin")]) {
    const version = await probe(exec, join(directory, executable));
    if (version !== undefined) {
      process.env.PATH = `${directory}${platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
      log(`uv installed at ${directory}, which is not on this shell's PATH. Open a new terminal and fully restart your MCP client so it can find uvx.`);
      return { nodeVersion: nodeOut, uvxVersion: version };
    }
  }
  throw new Error(`uv installer finished but uvx was not found. ${manual}`);
}
