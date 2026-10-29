import { serveHttp, type HttpServeOptions } from "../../src/http.js";

/**
 * Serve the Streamable HTTP connector for tests without consuming any
 * fixed port:
 * - HTTP listener uses port 0 (kernel-assigned ephemeral); the actual URL
 *   is on the returned handle.
 * - The SSO loopback callback listener is disabled: the server already
 *   completes login via GET /auth/callback on its own port, so tests never
 *   bind 8765 and parallel test processes cannot EADDRINUSE each other.
 */
export function serveTestHttp(options: HttpServeOptions = {}): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  return serveHttp(
    { ...options, ssoCallbackListener: false },
    { port: 0, host: "127.0.0.1" },
  );
}
