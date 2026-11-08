import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
// CI sets TDEI_MCP_BUILD_VERSION (0.1.<run number>); local builds fall back to package.json.
const version = (process.env.TDEI_MCP_BUILD_VERSION ?? "").trim() || pkg.version;
const sha = (process.env.TDEI_MCP_BUILD_SHA ?? "").trim();
export const BUILD = {
  version,
  sha: sha || "unknown",
  serverVersion: sha ? `${version}+${sha.slice(0, 7)}` : version,
} as const;
