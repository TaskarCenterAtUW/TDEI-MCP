import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("package entry routes help and init errors without starting stdio", async () => {
  const help = await exec(process.execPath, ["--import", "tsx", "src/index.ts", "--help"], { timeout: 10_000 });
  assert.match(help.stderr, /Usage:/);
  assert.doesNotMatch(help.stderr, /Starting MCP server/);
  await assert.rejects(exec(process.execPath, ["--import", "tsx", "src/index.ts", "init", "--env", "invalid", "--client", "codex"], { timeout: 10_000 }), (error: unknown) => {
    const result = error as { code: number; stderr: string };
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown environment/);
    assert.doesNotMatch(result.stderr, /Starting MCP server/);
    return true;
  });
  await assert.rejects(exec(process.execPath, ["--import", "tsx", "src/index.ts", "typo"], { timeout: 10_000 }), (error: unknown) => {
    assert.equal((error as { code: number }).code, 2);
    return true;
  });
});


test("npm-style symlink invokes the package CLI", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "tdei-bin-"));
  try {
    const binary = join(directory, "tdei-mcp.ts");
    await symlink(resolve("src/index.ts"), binary);
    const result = await exec(process.execPath, ["--import", "tsx", binary, "--help"], { timeout: 10_000 });
    assert.match(result.stderr, /Usage:/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
