import { strict as assert } from "node:assert";
import test from "node:test";
import { buildServerEntry, formatManual, readClaudeEntry, readCodexEntry, writeClaudeEntry, writeCodexEntry } from "../src/init/clients.js";
import { findFreePort } from "../src/init/ports.js";

const ENV = { TDEI_API_URL: "https://api-dev.tdei.us", TDEI_SSO_CALLBACK_URL: "http://127.0.0.1:8765/callback" };

test("findFreePort skips busy ports", async () => {
  const busy = new Set([8765, 8766]);
  assert.equal(await findFreePort(8765, async (p) => !busy.has(p)), 8767);
  await assert.rejects(findFreePort(8765, async () => false), /No free loopback port/);
});

test("server entry launches its build with absolute Node", () => {
  const entry = buildServerEntry("/usr/bin/node", ENV, "/project/dist/index.js");
  assert.equal(entry.command, "/usr/bin/node");
  assert.deepEqual(entry.args, ["/project/dist/index.js"]);
});

test("server entry loads an absolute environment file before its build", () => {
  const entry = buildServerEntry(
    "/usr/bin/node",
    { PATH: "/usr/bin" },
    "/project/dist/index.js",
    "/project/.env.dev",
  );
  assert.deepEqual(entry.args, ["--env-file=/project/.env.dev", "/project/dist/index.js"]);
});

test("codex writer upserts tdei block, reader finds env", () => {
  const entry = buildServerEntry("/usr/bin/node", ENV, "/project/dist/index.js");
  const first = writeCodexEntry("", entry, ENV);
  assert.match(first, /\[mcp_servers\.tdei\]/);
  assert.match(first, /startup_timeout_sec = 120/);
  const second = writeCodexEntry('[mcp_servers.other]\ncommand = "x"\n' + first, entry, { ...ENV, TDEI_API_URL: "https://api-stage.tdei.us" });
  assert.match(second, /\[mcp_servers\.other\]/);
  assert.match(second, /api-stage/);
  assert.equal(readCodexEntry(second).env.TDEI_API_URL, "https://api-stage.tdei.us");
  assert.equal(readCodexEntry("").found, false);
});

test("claude writer upserts mcpServers.tdei, invalid JSON throws", () => {
  const entry = buildServerEntry("/usr/bin/node", ENV, "/project/dist/index.js");
  const out = writeClaudeEntry("", entry, ENV);
  assert.equal(JSON.parse(out).mcpServers.tdei.command, "/usr/bin/node");
  assert.equal(readClaudeEntry(out).env.TDEI_API_URL, "https://api-dev.tdei.us");
  assert.throws(() => writeClaudeEntry("{oops", entry, ENV), /not valid JSON/);
});

test("formatManual prints command, args, env", () => {
  const text = formatManual(buildServerEntry("/usr/bin/node", ENV, "/project/dist/index.js"), ENV);
  assert.match(text, /\/usr\/bin\/node/);
  assert.match(text, /TDEI_API_URL=https:\/\/api-dev\.tdei\.us/);
});
