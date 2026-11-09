import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerSecret } from "../redact.ts";

export interface StoredToken {
  accessToken: string; refreshToken?: string; expiresAt: number; // epoch ms
  slug: string; obtainedAt: number;
}
export const tokenPath = (dir: string, label: string, profile: string) => join(dir, label.replace(/[^\w.-]/g, "_"), `${profile.replace(/[^\w.-]/g, "_")}.json`);

export function readToken(path: string): StoredToken | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as StoredToken;
    registerSecret(t.accessToken); registerSecret(t.refreshToken);
    return t;
  } catch { return undefined; }
}
export function writeToken(path: string, t: StoredToken): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path); // atomic
  registerSecret(t.accessToken); registerSecret(t.refreshToken);
}
export function deleteToken(path: string): boolean { if (!existsSync(path)) return false; unlinkSync(path); return true; }

/** Cross-process lock via exclusive create; stale after 60 s. */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30000;
  for (;;) {
    try { closeSync(openSync(lock, "wx")); break; }
    catch {
      try { const st = (await import("node:fs")).statSync(lock); if (Date.now() - st.mtimeMs > 60000) unlinkSync(lock); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error(`could not acquire token lock ${lock}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try { return await fn(); } finally { try { unlinkSync(lock); } catch { /* gone */ } }
}
