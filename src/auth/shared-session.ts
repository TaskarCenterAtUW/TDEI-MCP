import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TokenResponse } from "./types.js";

/**
 * File-backed SSO session shared by MCP servers that authenticate against
 * the same Keycloak auth server (dev/staging/prod entries in one mcps.json).
 *
 * Each server keeps its own in-memory AuthManager session, but the browser
 * SSO redirect + code exchange only needs to happen once per auth server:
 * the first login persists its tokens here and siblings adopt them after a
 * lightweight server-side validation instead of forcing another login.
 *
 * Keyed by authApiUrl so environments with distinct issuers never mix tokens.
 * Best-effort only: every failure degrades to "no shared session" and the
 * caller falls back to the normal SSO redirect.
 */

interface SharedSessionTokens extends TokenResponse {
  expiresAt: number;
}

function sessionsDir(): string {
  const override = process.env.TDEI_SESSION_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".tdei-mcp", "sessions");
}

function sessionPath(apiUrl: string): string {
  const key = createHash("sha256").update(`tdei-mcp-session-v1\n${apiUrl}`).digest("hex");
  return join(sessionsDir(), `${key}.json`);
}

/** Absolute expiry for tokens: explicit expires_in wins, else the JWT exp claim. */
export function expiresAtForTokens(tokens: TokenResponse, now = Date.now()): number {
  if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) {
    return now + tokens.expires_in * 1000;
  }
  const parts = tokens.access_token.split(".");
  const payloadPart = parts.length === 3 ? parts[1] : undefined;
  if (payloadPart) {
    try {
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf-8")) as Record<string, unknown>;
      if (typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
        return payload.exp * 1000;
      }
    } catch {
      // Fall through to the fallback lifetime below.
    }
  }
  return now + 29 * 60 * 1000;
}

export function saveSharedSession(apiUrl: string, tokens: TokenResponse, expiresAt: number): void {
  try {
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body: SharedSessionTokens = {
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(typeof tokens.expires_in === "number" ? { expires_in: tokens.expires_in } : {}),
      expiresAt,
    };
    writeFileSync(sessionPath(apiUrl), `${JSON.stringify(body)}\n`, { mode: 0o600 });
  } catch {
    // Shared cache is opportunistic; an unwritable home never blocks login.
  }
}

export function loadSharedSession(
  apiUrl: string,
  now = Date.now(),
  safetyWindowMs = 2 * 60 * 1000,
): TokenResponse | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionPath(apiUrl), "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SharedSessionTokens>;
    if (typeof parsed.access_token !== "string" || !parsed.access_token) return undefined;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now + safetyWindowMs) {
      try {
        unlinkSync(sessionPath(apiUrl));
      } catch {
        // Stale file removal is best-effort.
      }
      return undefined;
    }
    const tokens: TokenResponse = { access_token: parsed.access_token };
    if (typeof parsed.refresh_token === "string" && parsed.refresh_token) {
      tokens.refresh_token = parsed.refresh_token;
    }
    if (typeof parsed.expires_in === "number") tokens.expires_in = parsed.expires_in;
    return tokens;
  } catch {
    return undefined;
  }
}

export function clearSharedSession(apiUrl: string): void {
  try {
    unlinkSync(sessionPath(apiUrl));
  } catch {
    // Missing file or unwritable home: nothing to do.
  }
}
