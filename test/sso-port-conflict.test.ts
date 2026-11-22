import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.TDEI_SSO_CALLBACK_URL = "http://127.0.0.1:18766/callback";
const { AuthManager } = await import("../src/auth/auth-manager.js");

function listen(status: number, body: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(18766, "127.0.0.1", () => {
      resolve({
        port: 18766,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function listenRelay(): Promise<{ close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, service: "tdei-mcp-sso-relay" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  return new Promise((resolve) => {
    server.listen(18766, "127.0.0.1", () => {
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

test("port held by a sibling TDEI login names it instead of blaming the relay", async () => {
  const holder = await listen(404, "Not found");
  try {
    const auth = new AuthManager();
    const error = await auth.startSsoLogin().then(
      () => assert.fail("expected a bind conflict"),
      (err: unknown) => err,
    );
    assert.match(String((error as Error).message), /Another TDEI sign-in/);
    assert.match(String((error as Error).message), /VS Code/);
  } finally {
    await holder.close();
  }
});

test("port held by an orphaned relay names the relay instead of a sibling login", async () => {
  // Point HOME at an empty dir so stopOwnRelay finds no pid file: the relay
  // holder must be classified by its /health response, with no real process
  // touched.
  const previousHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "tdei-home-"));
  const holder = await listenRelay();
  try {
    const auth = new AuthManager();
    const error = await auth.startSsoLogin().then(
      () => assert.fail("expected a bind conflict"),
      (err: unknown) => err,
    );
    assert.match(String((error as Error).message), /SSO relay is still holding/);
    assert.match(String((error as Error).message), /pkill -f sso-callback-relay/);
    assert.doesNotMatch(String((error as Error).message), /Another TDEI sign-in/);
  } finally {
    await holder.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("port held by a foreign backend keeps the generic remediation", async () => {
  const holder = await listen(200, "orchestrator console");
  try {
    const auth = new AuthManager();
    const error = await auth.startSsoLogin().then(
      () => assert.fail("expected a bind conflict"),
      (err: unknown) => err,
    );
    assert.match(String((error as Error).message), /TDEI-Orchestrator/);
  } finally {
    await holder.close();
  }
});
