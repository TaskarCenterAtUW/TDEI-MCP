import assert from "node:assert/strict";
import { test } from "node:test";

async function loadBuild(env: Record<string, string | undefined>) {
  const saved = { v: process.env.TDEI_MCP_BUILD_VERSION, s: process.env.TDEI_MCP_BUILD_SHA };
  process.env.TDEI_MCP_BUILD_VERSION = env.version ?? "";
  process.env.TDEI_MCP_BUILD_SHA = env.sha ?? "";
  try {
    return (await import(`../src/build-info.js?${Math.random()}`)).BUILD as {
      version: string;
      sha: string;
      serverVersion: string;
    };
  } finally {
    process.env.TDEI_MCP_BUILD_VERSION = saved.v ?? "";
    process.env.TDEI_MCP_BUILD_SHA = saved.s ?? "";
  }
}

test("CI build version overrides package.json and keeps the commit suffix", async () => {
  const b = await loadBuild({ version: "0.1.57", sha: "a582e67238de6bf2a7194d6446dc3a6d592ab24e" });
  assert.equal(b.version, "0.1.57");
  assert.equal(b.serverVersion, "0.1.57+a582e67");
});

test("without a CI build version the package.json version is used", async () => {
  const b = await loadBuild({ sha: "abcdef1234567" });
  assert.match(b.version, /^\d+\.\d+\.\d+/);
  assert.equal(b.serverVersion, `${b.version}+abcdef1`);
});
