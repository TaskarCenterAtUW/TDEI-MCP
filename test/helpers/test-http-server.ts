import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHttp, type HttpServeOptions } from "../../src/http.js";

/**
 * Serve the Streamable HTTP connector for tests without consuming any
 * fixed port:
 * - HTTP listener uses port 0 (kernel-assigned ephemeral); the actual URL
 *   is on the returned handle.
 * - The SSO loopback callback listener is disabled: the server already
 *   completes login via GET /auth/callback on its own port, so tests never
 *   bind 8765 and parallel test processes cannot EADDRINUSE each other.
 * - The shared-session dir defaults to a fresh temp dir per server (unless
 *   the test already set TDEI_SESSION_DIR, e.g. to assert sibling reuse),
 *   so logins completed inside tests never touch the real ~/.tdei-mcp
 *   sessions and cannot leak from one test into another.
 */
let helperOwned = false;
export function serveTestHttp(options: HttpServeOptions = {}): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  // Fresh dir per server unless the test preset TDEI_SESSION_DIR itself
  // (e.g. to assert sibling session reuse across two gateways).
  if (!process.env.TDEI_SESSION_DIR || helperOwned) {
    process.env.TDEI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tdei-test-sessions-"));
    helperOwned = true;
  }
  return serveHttp({ ...options, ssoCallbackListener: false }, { port: 0, host: "127.0.0.1" });
}
