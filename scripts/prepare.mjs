// Runs as the `prepare` lifecycle step: on `pnpm install` / `npm install`, and when
// this repository is installed straight from git (`npx -y github:TaskarCenterAtUW/TDEI-MCP#<ref> setup ...`).
// Everything here is best effort: a failure must never break an install.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, options = {}) => spawnSync(command, { cwd: root, shell: true, stdio: "inherit", ...options });

// Contributors: install the git hooks.
if (existsSync(join(root, ".git"))) run("husky", { stdio: "ignore" });

// A git install has no dist/ (it is not committed), so compile it. Skipped when the
// sources are not there yet (the Docker dependency layer) or dist/ already exists.
if (!existsSync(join(root, "dist", "index.js")) && existsSync(join(root, "src", "index.ts"))) {
  console.error("[tdei-mcp] building dist/ ...");
  const result = run("tsc");
  if (result.status !== 0) console.error("[tdei-mcp] build failed; run `pnpm build` and read the errors above.");
}
