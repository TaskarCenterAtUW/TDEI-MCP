import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  RELAY_LOG_NAME,
  RELAY_PORT,
  RELAY_SERVICE_LABEL,
  RELAY_SYSTEMD_UNIT,
  RELAY_TARGETS_NAME,
  RELAY_VERSION,
  RELAY_WINDOWS_TASK,
  relayDir,
  startCallbackRelay,
} from "./relay.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  home?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  /** Runs a system command (launchctl, systemctl, schtasks, lsof). Injectable for tests. */
  run?: (command: string, args: string[]) => { status: number | null; stdout: string };
  /** Restarts the relay and its service. Injectable so tests never spawn a process. */
  restart?: (home: string, gatewayOrigin: string) => void;
  waitMs?: number;
}

function systemRun(command: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function readTargets(dir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, RELAY_TARGETS_NAME), "utf-8"));
    const callbacks = (parsed as { callbacks?: unknown } | null)?.callbacks;
    if (Array.isArray(callbacks)) return callbacks.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Missing or corrupt.
  }
  return [];
}

interface Health {
  reachable: boolean;
  ours: boolean;
  version?: number | undefined;
}

async function probeHealth(fetchImpl: typeof fetch): Promise<Health> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${RELAY_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json().catch(() => null)) as { service?: unknown; version?: unknown } | null;
    const ours = body?.service === "tdei-mcp-sso-relay";
    return { reachable: true, ours, version: typeof body?.version === "number" ? body.version : undefined };
  } catch {
    return { reachable: false, ours: false };
  }
}

function serviceCheck(
  platform: NodeJS.Platform,
  uid: number,
  run: NonNullable<DoctorDeps["run"]>,
): { supported: boolean; ok: boolean; detail: string } {
  if (platform === "darwin") {
    const ok = run("launchctl", ["print", `gui/${uid}/${RELAY_SERVICE_LABEL}`]).status === 0;
    return { supported: true, ok, detail: ok ? "launchd agent registered" : "launchd agent not registered" };
  }
  if (platform === "linux") {
    const ok = run("systemctl", ["--user", "is-enabled", RELAY_SYSTEMD_UNIT]).status === 0;
    return { supported: true, ok, detail: ok ? "systemd user unit enabled" : "systemd user unit not enabled" };
  }
  if (platform === "win32") {
    const ok = run("schtasks", ["/Query", "/TN", RELAY_WINDOWS_TASK]).status === 0;
    return { supported: true, ok, detail: ok ? "scheduled task registered" : "scheduled task not registered" };
  }
  return { supported: false, ok: false, detail: `autostart is not supported on ${platform}` };
}

/** Diagnoses (and with --fix repairs) the local SSO callback relay. Returns a process exit code. */
export async function runDoctor(argv: string[], deps: DoctorDeps = {}): Promise<number> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 501);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const run = deps.run ?? systemRun;
  const fix = argv.includes("--fix");
  if (argv.includes("--help") || argv.includes("-h")) {
    log("Usage: tdei-mcp doctor [--fix]\n  Checks the local SSO callback relay (127.0.0.1:8765). --fix repairs it.");
    return 0;
  }

  const dir = relayDir(home);
  const collect = async (): Promise<DoctorCheck[]> => {
    const checks: DoctorCheck[] = [];
    const script = existsSync(join(dir, "sso-callback-relay.cjs"));
    checks.push({
      name: "relay program",
      ok: script,
      detail: script ? join(dir, "sso-callback-relay.cjs") : "missing: run TDEI MCP setup",
    });
    const targets = readTargets(dir);
    checks.push({
      name: "gateway targets",
      ok: targets.length > 0,
      detail: targets.length > 0 ? targets.join(", ") : `no usable ${RELAY_TARGETS_NAME}: run TDEI MCP setup`,
    });
    const service = serviceCheck(platform, uid, run);
    checks.push({ name: "autostart service", ok: service.ok, detail: service.detail });
    const health = await probeHealth(fetchImpl);
    if (!health.reachable) {
      checks.push({ name: "relay listening", ok: false, detail: `nothing answers on 127.0.0.1:${RELAY_PORT}` });
    } else if (!health.ours) {
      const holder =
        platform === "win32" ? "" : run("lsof", ["-nP", `-iTCP:${RELAY_PORT}`, "-sTCP:LISTEN"]).stdout.trim();
      checks.push({
        name: "relay listening",
        ok: false,
        detail: `port ${RELAY_PORT} is held by another program (stop it, the relay takes the port back by itself)${holder ? `:\n${holder}` : ""}`,
      });
    } else if (health.version !== RELAY_VERSION) {
      checks.push({
        name: "relay listening",
        ok: false,
        detail: `running an old relay (version ${health.version ?? "unknown"}, current ${RELAY_VERSION})`,
      });
    } else {
      checks.push({ name: "relay listening", ok: true, detail: `answering, version ${RELAY_VERSION}` });
    }
    return checks;
  };

  const print = (checks: DoctorCheck[]): void => {
    for (const check of checks) log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  };

  let checks = await collect();
  print(checks);
  if (checks.every((check) => check.ok)) {
    log("The sign-in relay is healthy.");
    return 0;
  }
  if (!fix) {
    log(`\nRun with --fix to repair it. Log: ${join(dir, RELAY_LOG_NAME)}`);
    return 1;
  }

  const targets = readTargets(dir);
  const first = targets[0];
  let origin: string | undefined;
  try {
    origin = first ? new URL(first).origin : undefined;
  } catch {
    origin = undefined;
  }
  if (!origin) {
    log(
      "\nCannot repair: no gateway is recorded on this machine. Run the TDEI MCP setup command from your install page.",
    );
    return 1;
  }
  log("\nRepairing...");
  (deps.restart ?? ((h: string, o: string) => void startCallbackRelay(h, o)))(home, origin);
  const deadline = Date.now() + (deps.waitMs ?? 8000);
  let healthy = false;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
    const health = await probeHealth(fetchImpl);
    if (health.ours && health.version === RELAY_VERSION) {
      healthy = true;
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  checks = await collect();
  print(checks);
  if (!healthy || !checks.every((check) => check.ok)) {
    const service = serviceCheck(platform, uid, run);
    log(
      service.supported
        ? "\nStill not healthy. If another program holds port 8765, stop it; the relay takes the port back by itself."
        : "\nAutostart is unavailable here, so the relay runs only until it has been idle for 10 minutes. Start it with: node ~/.tdei-mcp/sso-callback-relay.cjs",
    );
    return 1;
  }
  log("Fixed: the sign-in relay is healthy.");
  return 0;
}
