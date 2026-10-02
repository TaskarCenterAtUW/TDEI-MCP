import { strict as assert } from "node:assert";
import test from "node:test";

import { checkPreflight, uvInstallCommand } from "../src/init/preflight.js";

function fakeExec(options: { afterInstall?: "path" | "candidate"; installFails?: boolean }) {
  let installed = false;
  const calls: string[] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args].join(" "));
    if (command === "node") return { stdout: "v22.1.0\n" };
    if (command === "sh" || command === "powershell") {
      if (options.installFails) throw new Error("network down");
      installed = true;
      return { stdout: "" };
    }
    if (command === "uvx") {
      if (installed && options.afterInstall === "path") return { stdout: "uvx 0.9.0\n" };
      throw new Error("ENOENT");
    }
    if (command.endsWith("uvx") || command.endsWith("uvx.exe")) {
      if (installed && options.afterInstall === "candidate") return { stdout: "uvx 0.9.0\n" };
      throw new Error("ENOENT");
    }
    throw new Error(`unexpected ${command}`);
  };
  return { exec, calls };
}

test("uv installation is explicit and uses the official installer", async () => {
  assert.match(uvInstallCommand("linux").display, /curl -LsSf https:\/\/astral\.sh\/uv\/install\.sh \| sh/);
  const declined = fakeExec({});
  await assert.rejects(
    checkPreflight(declined.exec, { platform: "linux", confirmInstall: async () => false }),
    /uvx not found.*docs\.astral\.sh\/uv.*curl -LsSf/s,
  );
  assert.ok(!declined.calls.some((call) => call.startsWith("sh ")));

  const accepted = fakeExec({ afterInstall: "path" });
  const result = await checkPreflight(accepted.exec, {
    platform: "linux",
    confirmInstall: async () => true,
  });
  assert.equal(result.uvxVersion, "uvx 0.9.0");
  assert.ok(accepted.calls.some((call) => call.startsWith("sh -c")));
});

test("preflight reports missing Node and installer failures with remediation", async () => {
  await assert.rejects(
    checkPreflight(async () => { throw new Error("ENOENT"); }),
    /node not found on PATH.*nodejs\.org/s,
  );
  await assert.rejects(
    checkPreflight(fakeExec({ installFails: true }).exec, {
      platform: "linux",
      confirmInstall: async () => true,
    }),
    /uv installation failed: network down.*docs\.astral\.sh/s,
  );
});
