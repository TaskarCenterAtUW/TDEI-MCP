import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
const sha = (process.env.TDEI_MCP_BUILD_SHA ?? "").trim();
export const BUILD = {
  version: pkg.version,
  sha: sha || "unknown",
  serverVersion: sha ? `${pkg.version}+${sha.slice(0, 7)}` : pkg.version,
} as const;
