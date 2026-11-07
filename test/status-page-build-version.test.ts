import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

// build-info reads TDEI_MCP_BUILD_SHA once, at module load. Test files run in
// their own process, so setting it here (before the first, dynamic import of
// the status page) is what makes the "CI built this SHA" path reachable.
const CI_SHA = "0123456789abcdef0123456789abcdef01234567";
process.env.TDEI_MCP_BUILD_SHA = CI_SHA;

test("status page shows the full deployed build version (package version + full commit SHA)", async () => {
  const { renderStatusPage } = await import("../src/http-status-page.js");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
  const full = `${pkg.version}+${CI_SHA}`;

  const html = renderStatusPage("https://tdei-mcp.example", "/mcp");

  // Baked server-side into the header, so the version is visible in the HTML
  // even before (or without) the /health fetch succeeding.
  assert.ok(
    html.includes(`Deployed build: <code>${full}</code>`),
    `header must show the full version ${full}, got: ${html.slice(0, 400)}`,
  );
  // The live status table reports the build from /health, with the baked
  // version as the fallback when an older /health has no build block.
  assert.ok(html.includes("row('build', build)"), "health table must render a build row");
  assert.ok(html.includes(`const TDEI_BUILD = ${JSON.stringify(full)}`), "JS fallback must be the full version");
});
