import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { configPath, SETUP_CLIENTS, type HostEnv, type SetupClient } from "./clients.js";

export interface Detection {
  client: SetupClient;
  /** Why we think it is installed (a directory or an executable on PATH). */
  evidence: string;
}

export interface DetectProbe {
  /** True when the path exists (file or directory). */
  exists: (path: string) => boolean;
  /** Absolute path of an executable found on PATH, or undefined. */
  which: (binary: string) => string | undefined;
}

export function systemProbe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DetectProbe {
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter(Boolean);
  const extensions = platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return {
    exists: (path) => existsSync(path),
    which: (binary) => {
      for (const dir of dirs) {
        for (const ext of extensions) {
          const candidate = join(dir, binary + ext.toLowerCase());
          try {
            if (statSync(candidate).isFile()) return candidate;
          } catch {
            // not here
          }
        }
      }
      return undefined;
    },
  };
}

/**
 * Per client: config directories / executables that show it is installed.
 * Leftover config folders can give false positives, which is why the CLI
 * lists what it found and asks before writing.
 */
function evidenceFor(client: SetupClient, host: HostEnv, probe: DetectProbe): string | undefined {
  const dirOf = (path: string) => (probe.exists(path) ? path : undefined);
  const bin = (name: string) => probe.which(name);
  switch (client) {
    case "codex":
      return dirOf(join(host.home, ".codex")) ?? bin("codex");
    case "opencode":
      return dirOf(join(host.home, ".config", "opencode")) ?? bin("opencode");
    case "claude-cli":
      return bin("claude") ?? dirOf(join(host.home, ".claude")) ?? dirOf(join(host.home, ".claude.json"));
    case "claude-desktop":
      return dirOf(dirname(configPath(client, host)));
    case "vscode":
      return dirOf(dirname(configPath(client, host))) ?? bin("code");
    case "cursor":
      return dirOf(join(host.home, ".cursor")) ?? bin("cursor");
  }
}

export function detectClients(host: HostEnv, probe: DetectProbe): Detection[] {
  const found: Detection[] = [];
  for (const client of SETUP_CLIENTS) {
    const evidence = evidenceFor(client, host, probe);
    if (evidence) found.push({ client, evidence });
  }
  return found;
}
