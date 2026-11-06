import type { IncomingHttpHeaders } from "node:http";

/**
 * When may one login be reused for a caller?
 *
 * Only when the caller is plainly the person sitting at this machine: a direct
 * loopback connection, no proxy in between, and the server is not running as a
 * gateway child. Everything else (a deployed server, anything behind a reverse
 * proxy, any other host) is a different user or system, and gets no shared
 * login: each request must carry its own bearer token, and the server stores
 * and hands out nothing. Each user can still hold any number of logins
 * (one per client or machine) because tokens live with the client.
 *
 * There is deliberately no setting to turn sharing on for remote callers.
 */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"] as const;

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || bare === "127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

export function isDirectLocalCaller(remoteAddress: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (!isLoopbackAddress(remoteAddress)) return false;
  return PROXY_HEADERS.every((name) => headers[name] === undefined);
}

export function sharedSessionAllowed(input: {
  gatewaySlug: string | undefined;
  remoteAddress: string | undefined;
  headers: IncomingHttpHeaders;
}): boolean {
  if (input.gatewaySlug) return false;
  return isDirectLocalCaller(input.remoteAddress, input.headers);
}
