import { createHash } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, fields: { tool?: string; sessionHash?: string } = {}): void {
  if ((process.env.LOG_LEVEL?.trim().toLowerCase() || "pretty") === "json") {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
    return;
  }
  const suffix = fields.tool ? ` [${fields.tool}]` : "";
  console.error(`[${level}]${suffix} ${msg}`);
}
