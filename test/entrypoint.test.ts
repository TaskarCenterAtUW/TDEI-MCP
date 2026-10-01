import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("server starts when launched through a symlink (npx bin shim)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-link-"));
  const link = join(dir, "index.ts");
  symlinkSync(resolve("src/index.ts"), link);
  const child = spawn(process.execPath, ["--import", "tsx", link], { stdio: ["pipe", "ignore", "pipe"] });
  try {
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("server did not start via symlink")), 20_000);
      child.stderr.on("data", (d) => { if (String(d).includes("Starting MCP server")) { clearTimeout(timer); ok(); } });
      child.on("exit", () => { clearTimeout(timer); fail(new Error("exited before start")); });
    });
  } finally { child.kill(); }
});
