import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

test("package entry routes setup commands without starting a transport", async () => {
  const help = await exec(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--help"],
    { timeout: 10_000, env: childEnv },
  );
  const helpOutput = `${help.stdout}\n${help.stderr}`;
  assert.match(helpOutput, /Usage:/);
  assert.doesNotMatch(helpOutput, /Starting MCP server|Serving MCP/);

  await assert.rejects(
    exec(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "init", "--unknown-option"],
      { timeout: 10_000, env: childEnv },
    ),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 1);
      assert.match(output, /unknown option --unknown-option/);
      assert.doesNotMatch(output, /Starting MCP server|Serving MCP/);
      return true;
    },
  );
});

test("package entry still rejects an invalid HTTP port as a transport option", async () => {
  await assert.rejects(
    exec(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "--transport=http", "--port=invalid"],
      { timeout: 10_000, env: childEnv },
    ),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /--port must be an integer/);
      return true;
    },
  );
});

test("unknown setup commands show usage instead of starting stdio", async () => {
  await assert.rejects(
    exec(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "unknown-command"],
      { timeout: 10_000, env: childEnv },
    ),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 2);
      assert.match(`${result.stdout}\n${result.stderr}`, /Usage:/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Starting MCP server/);
      return true;
    },
  );
});

test("npm-style symlink invokes the package CLI", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp, rm, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "tdei-bin-"));
  try {
    const binary = join(directory, "tdei-mcp.ts");
    await symlink(resolve("src/index.ts"), binary);
    const result = await exec(
      process.execPath,
      ["--import", "tsx", binary, "--help"],
      { timeout: 10_000, env: childEnv },
    );
    assert.match(`${result.stdout}\n${result.stderr}`, /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
