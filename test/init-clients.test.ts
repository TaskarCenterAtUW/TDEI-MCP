import { strict as assert } from "node:assert";
import test from "node:test";
import { buildServerEntry, formatManual, npxPathFor, readClaudeEntry, readCodexEntry, writeClaudeEntry, writeCodexEntry } from "../src/init/clients.js";
import { findFreePort } from "../src/init/ports.js";

const ENV = { TDEI_API_URL: "https://api.tdei.us", TDEI_SSO_CALLBACK_URL: "http://127.0.0.1:8765/callback" };

test("findFreePort skips busy ports", async () => {
  const busy = new Set([8765, 8766]);
  assert.equal(await findFreePort(8765, async (p) => !busy.has(p)), 8767);
  await assert.rejects(findFreePort(8765, async () => false), /No free loopback port found in 8765-8864.*lsof|netstat/s);
});

test("server entry launches npx, resolves beside node", () => {
  assert.equal(npxPathFor("/usr/bin/node"), "/usr/bin/npx");
  const entry = buildServerEntry("/usr/bin/npx", ENV);
  assert.equal(entry.command, "/usr/bin/npx");
  assert.deepEqual(entry.args, ["-y", "tdei-mcp"]);
});

test("codex writer upserts tdei block, reader finds env", () => {
  const entry = buildServerEntry("/usr/bin/npx", ENV);
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
  const entry = buildServerEntry("/usr/bin/npx", ENV);
  const out = writeClaudeEntry("", entry, ENV);
  assert.equal(JSON.parse(out).mcpServers.tdei.command, "/usr/bin/npx");
  assert.equal(readClaudeEntry(out).env.TDEI_API_URL, "https://api.tdei.us");
  assert.throws(() => writeClaudeEntry("{oops", entry, ENV), /not valid JSON/);
});

test("formatManual prints command, args, env", () => {
  const text = formatManual(buildServerEntry("/usr/bin/npx", ENV), ENV);
  assert.match(text, /\/usr\/bin\/npx/);
  assert.match(text, /TDEI_API_URL=https:\/\/api\.tdei\.us/);
});
