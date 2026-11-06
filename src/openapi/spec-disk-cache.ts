import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Last-good copy of each remote OpenAPI spec, keyed by URL. If the spec host is
 * down at startup the server can still come up with the previous spec instead
 * of failing every request. Keyed by URL because core and workspace servers
 * use different specs.
 */
function cachePath(specUrl: string): string {
  const dir = process.env.TDEI_SPEC_CACHE_DIR?.trim() || join(tmpdir(), "tdei-mcp-spec-cache");
  const name = createHash("sha256").update(specUrl).digest("hex").slice(0, 16);
  return join(dir, `${name}.json`);
}

export function readCachedSpec(specUrl: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(specUrl), "utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Best effort: a cache write must never fail a successful spec load. */
export function writeCachedSpec(specUrl: string, doc: unknown): void {
  try {
    const file = cachePath(specUrl);
    mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, file);
  } catch {
    /* circular structure, read-only disk, ...: ignore */
  }
}
