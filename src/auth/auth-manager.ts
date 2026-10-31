import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { getConfig, TDEI_SSO_CLIENT_ID } from "../config.js";
import type {
  AuthStatus,
  SsoLoginOptions,
  SsoLoginStart,
  SsoLogoutOptions,
  SsoLogoutStart,
  TokenResponse,
  ValidateTokenOptions,
} from "./types.js";

const DEFAULT_TOKEN_LIFETIME_SECONDS = 29 * 60;
const REFRESH_SAFETY_WINDOW_MS = 2 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_VALIDATION_TTL_MS = 60 * 1000;
const MAX_TOKEN_CACHE_ENTRIES = 1000;
const MAX_CALLBACK_PARAM_LENGTH = 1024;
const MAX_AUTH_ERROR_DETAIL_LENGTH = 200;

const CALLBACK_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
} as const;

export function sanitizeAuthErrorDetail(raw: string, maxLength = MAX_AUTH_ERROR_DETAIL_LENGTH): string {
  const withoutTags = raw.replace(/<[^>]*>/g, " ");
  // oxlint-disable-next-line eslint/no-control-regex -- intentional: strips control chars from untrusted error detail.
  const withoutControl = withoutTags.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const collapsed = withoutControl.replace(/\s+/g, " ").trim();
  if (!collapsed) return "No additional error details provided";
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}...`;
}

export interface AuthIdentity {
  subject?: string;
  username?: string;
  email?: string;
  name?: string;
  roles: string[];
  groups: string[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf-8");
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    if (payload && typeof payload === "object") return payload;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Extract non-sensitive identity claims (email, username, roles) from the SSO JWT. Never returns the token itself. */
export function extractAuthIdentity(token: string): AuthIdentity | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const roles = new Set<string>();
  const realmAccess = payload.realm_access as Record<string, unknown> | undefined;
  for (const role of stringArray(realmAccess?.roles)) roles.add(role);
  const resourceAccess = payload.resource_access as Record<string, unknown> | undefined;
  if (resourceAccess && typeof resourceAccess === "object") {
    for (const client of Object.values(resourceAccess)) {
      const clientRoles = stringArray((client as Record<string, unknown>)?.roles);
      for (const role of clientRoles) roles.add(role);
    }
  }
  for (const role of stringArray((payload as Record<string, unknown>).roles)) roles.add(role);
  const groups = [...stringArray(payload.groups), ...stringArray(payload.group_membership)];
  const username =
    typeof payload.preferred_username === "string"
      ? payload.preferred_username
      : typeof payload.username === "string"
        ? payload.username
        : undefined;
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  const subject = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!username && !email && !subject && roles.size === 0 && groups.length === 0) return undefined;
  return {
    ...(subject ? { subject } : {}),
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    roles: [...roles].sort(),
    groups,
  };
}

export function extractJwtExpirationMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  if (payload && typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
    return payload.exp * 1000;
  }
  return undefined;
}

function isValidCallbackParam(value: string): boolean {
  // oxlint-disable-next-line eslint/no-control-regex -- intentional: rejects control chars in OAuth callback params.
  return value.length > 0 && value.length <= MAX_CALLBACK_PARAM_LENGTH && !/[\u0000-\u0020\u007f]/.test(value);
}

function safeEqualStrings(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf-8");
  const rightBuf = Buffer.from(right, "utf-8");
  if (leftBuf.byteLength !== rightBuf.byteLength) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

function hashTokenCacheKey(apiUrl: string, token: string): string {
  return createHash("sha256").update(`${apiUrl}:${token}`).digest("hex");
}

interface PendingLogin extends SsoLoginStart {
  server: Server | undefined;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  expectedState?: string | undefined;
}

interface PendingLogout extends SsoLogoutStart {
  server: Server | undefined;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function browserRedirectUri(override: string | undefined, fallback: URL): URL {
  const trimmed = override?.trim();
  if (!trimmed) return fallback;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("TDEI SSO redirect URI is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TDEI SSO redirect URI must use http or https");
  }
  return url;
}

export class AuthManager {
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private expiresAt: number | undefined;
  private tokenVersion = 0;
  private pendingLogin: PendingLogin | undefined;
  private pendingLogout: PendingLogout | undefined;
  private refreshPromise: Promise<void> | undefined;
  private loginExchangePromise: Promise<void> | undefined;
  private validatedUntil: number | undefined;

  getTokenVersion(): number {
    return this.tokenVersion;
  }

  /** Non-sensitive identity from the current JWT (email, username, roles). Never exposes the token. */
  getIdentity(): AuthIdentity | undefined {
    if (!this.accessToken) return undefined;
    return extractAuthIdentity(this.accessToken);
  }

  getStatus(): AuthStatus {
    const authenticated = this.hasUsableAccessToken();
    return {
      configured: Boolean(TDEI_SSO_CLIENT_ID && getConfig().ssoCallbackUrl),
      authenticated,
      state: authenticated
        ? "authenticated"
        : this.pendingLogin
          ? "login_pending"
          : this.pendingLogout
            ? "logout_pending"
            : "signed_out",
      loginMethod: "sso",
      expiresAt: this.expiresAt,
    };
  }

  async startSsoLogin(options?: SsoLoginOptions): Promise<SsoLoginStart> {
    if (this.pendingLogin) return this.publicLogin(this.pendingLogin);
    if (this.pendingLogout) {
      const reject = this.pendingLogout.reject;
      this.finishPendingLogout();
      reject(new Error("TDEI SSO logout cancelled by a new login"));
    }

    const expectedState = options?.state?.trim();
    if (expectedState !== undefined && !isValidCallbackParam(expectedState)) {
      throw new Error("TDEI SSO state parameter is invalid");
    }

    const callbackUrl = new URL(getConfig().ssoCallbackUrl);
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    // The stdio transport needs its own loopback listener; an HTTP server
    // that already serves /auth/callback on its own port opts out so SSO
    // login never holds a second port (and can never EADDRINUSE against a
    // parallel process). Completion then arrives via completeSsoLogin().
    let server: Server | undefined;
    if (options?.bindCallbackListener ?? true) {
      const listener = createServer(async (request, response) => {
        const requestUrl = new URL(request.url ?? "/", callbackUrl.origin);

        if (request.method !== "GET" || requestUrl.pathname !== callbackUrl.pathname) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...CALLBACK_SECURITY_HEADERS });
          response.end("Not found");
          return;
        }

        const secFetchSite = request.headers["sec-fetch-site"];
        const secFetchMode = request.headers["sec-fetch-mode"];
        if (secFetchSite === "cross-site" && secFetchMode && secFetchMode !== "navigate") {
          response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...CALLBACK_SECURITY_HEADERS });
          response.end("Forbidden cross-site callback request");
          return;
        }

        try {
          await this.completeSsoLogin(requestUrl.toString());

          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CALLBACK_SECURITY_HEADERS });
          response.end(
            "<!doctype html><title>TDEI login complete</title><h1>Login complete</h1><p>You may close this window and return to your agent.</p>",
          );
        } catch (error) {
          const loginError = error instanceof Error ? error : new Error(String(error));
          response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", ...CALLBACK_SECURITY_HEADERS });
          response.end(sanitizeAuthErrorDetail(loginError.message));
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            listener.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            listener.off("error", onError);
            resolve();
          };
          listener.once("error", onError);
          listener.once("listening", onListening);
          listener.listen(Number(callbackUrl.port), callbackUrl.hostname);
        });
      } catch (error) {
        throw new Error(
          `Unable to start TDEI SSO callback server at ${callbackUrl.origin}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      server = listener;
    }

    const loginUrl = new URL("/api/v1/sso-redirect", `${getConfig().apiUrl}/`);
    loginUrl.searchParams.set("redirect_uri", browserRedirectUri(options?.redirectUri, callbackUrl).toString());
    loginUrl.searchParams.set("client_id", TDEI_SSO_CLIENT_ID);
    if (expectedState) {
      loginUrl.searchParams.set("state", expectedState);
    }

    const timeout = setTimeout(() => {
      const error = new Error("TDEI SSO login timed out");
      const reject = this.pendingLogin?.reject;
      this.finishPendingLogin();
      reject?.(error);
    }, LOGIN_TIMEOUT_MS);
    timeout.unref();

    this.pendingLogin = {
      loginUrl: loginUrl.toString(),
      callbackUrl: callbackUrl.toString(),
      completion,
      ...(expectedState ? { state: expectedState, expectedState } : {}),
      server,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timeout,
    };
    return this.publicLogin(this.pendingLogin);
  }

  async completeSsoLogin(callback: string): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) throw new Error("No TDEI SSO login is pending");

    const expected = new URL(getConfig().ssoCallbackUrl);
    const received = new URL(callback);
    if (received.origin !== expected.origin || received.pathname !== expected.pathname) {
      throw new Error("TDEI SSO callback URL does not match the configured callback");
    }

    const providerError = received.searchParams.get("error");
    if (providerError) throw new Error(`TDEI SSO failed: ${sanitizeAuthErrorDetail(providerError)}`);
    const code = received.searchParams.get("code")?.trim() ?? "";
    const state = received.searchParams.get("state")?.trim() ?? "";
    if (!code || !state) throw new Error("TDEI SSO callback is missing code or state");
    if (!isValidCallbackParam(code) || !isValidCallbackParam(state)) {
      throw new Error("TDEI SSO callback contains invalid code or state parameter");
    }
    if (pending.expectedState && !safeEqualStrings(state, pending.expectedState)) {
      throw new Error("TDEI SSO callback state mismatch");
    }

    if (this.loginExchangePromise) return this.loginExchangePromise;
    this.loginExchangePromise = this.requestTokens(
      "/api/v1/sso-login",
      { code, state, clientId: TDEI_SSO_CLIENT_ID },
      "TDEI SSO login",
    )
      .then((tokens) => {
        this.storeTokens(tokens);
        this.finishPendingLogin();
        pending.resolve();
      })
      .catch((error: unknown) => {
        const loginError = error instanceof Error ? error : new Error(String(error));
        this.finishPendingLogin();
        pending.reject(loginError);
        throw loginError;
      })
      .finally(() => {
        this.loginExchangePromise = undefined;
      });
    return this.loginExchangePromise;
  }

  /** Finish a pending logout after the browser returns to the callback. */
  completeSsoLogout(callback: string): void {
    const pending = this.pendingLogout;
    if (!pending) throw new Error("No TDEI SSO logout is pending");

    const expected = new URL(getConfig().ssoCallbackUrl);
    const received = new URL(callback);
    if (received.origin !== expected.origin || received.pathname !== expected.pathname) {
      throw new Error("TDEI SSO callback URL does not match the configured callback");
    }

    const providerError = received.searchParams.get("error");
    this.finishPendingLogout();
    if (providerError) {
      const error = new Error(`TDEI SSO logout failed: ${sanitizeAuthErrorDetail(providerError)}`);
      pending.reject(error);
      throw error;
    }
    pending.resolve();
  }

  async getAccessToken(): Promise<string> {
    if (this.hasUsableAccessToken()) {
      console.error("[auth] using existing access token");
      return this.accessToken!;
    }
    if (this.refreshToken) {
      try {
        await this.refresh();
        return this.accessToken!;
      } catch (error) {
        console.error("[auth] token refresh failed:", error instanceof Error ? error.message : String(error));
        this.clearTokens();
      }
    }
    throw new Error("TDEI_SSO_REQUIRED");
  }

  /** Seed a Bearer received over HTTP. Internal: use injectAccessToken(). */
  seedInjectedToken(token: string, expiresInSeconds?: number): void {
    this.accessToken = token;
    this.refreshToken = undefined;
    this.validatedUntil = undefined;
    this.tokenVersion += 1;
    if (typeof expiresInSeconds === "number" && expiresInSeconds >= 0) {
      this.expiresAt = Date.now() + expiresInSeconds * 1000;
      return;
    }
    const jwtExpirationMs = extractJwtExpirationMs(token);
    this.expiresAt = jwtExpirationMs ?? Date.now() + DEFAULT_TOKEN_LIFETIME_SECONDS * 1000;
  }

  /**
   * Stateless validation for an injected Bearer: local expiry check first
   * (never attempts refresh — the server holds no refresh_token), then one
   * lightweight TDEI probe (cached for up to ttlMs). Throws TDEI_TOKEN_EXPIRED / TDEI_TOKEN_INVALID.
   */
  async validateToken(options?: typeof fetch | ValidateTokenOptions): Promise<void> {
    if (!this.hasUsableAccessToken()) {
      throw new Error("TDEI_TOKEN_EXPIRED");
    }
    const resolvedOptions: ValidateTokenOptions =
      typeof options === "function" ? { fetchImpl: options } : (options ?? {});
    const fetchImpl = resolvedOptions.fetchImpl ?? fetch;
    const ttlMs = resolvedOptions.ttlMs ?? DEFAULT_TOKEN_VALIDATION_TTL_MS;
    const apiUrl = getConfig().apiUrl;
    const now = Date.now();
    const cacheKey =
      resolvedOptions.cache && this.accessToken ? hashTokenCacheKey(apiUrl, this.accessToken) : undefined;

    if (this.validatedUntil && now < this.validatedUntil) {
      return;
    }
    if (cacheKey && resolvedOptions.cache) {
      const cachedUntil = resolvedOptions.cache.get(cacheKey);
      if (cachedUntil !== undefined) {
        if (now < cachedUntil) {
          this.validatedUntil = cachedUntil;
          return;
        }
        resolvedOptions.cache.delete(cacheKey);
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(new URL("/api/v1/project-groups", `${apiUrl}/`), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.accessToken}` },
      });
    } catch {
      throw new Error("TDEI_TOKEN_INVALID");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("TDEI_TOKEN_INVALID");
    }
    await response.body?.cancel().catch(() => undefined);

    if (ttlMs > 0) {
      const maxValidUntil = this.expiresAt
        ? Math.min(now + ttlMs, this.expiresAt - REFRESH_SAFETY_WINDOW_MS)
        : now + ttlMs;
      if (maxValidUntil > now) {
        this.validatedUntil = maxValidUntil;
        if (cacheKey && resolvedOptions.cache) {
          if (resolvedOptions.cache.size >= MAX_TOKEN_CACHE_ENTRIES) {
            const oldestKey = resolvedOptions.cache.keys().next().value;
            if (oldestKey !== undefined) resolvedOptions.cache.delete(oldestKey);
          }
          resolvedOptions.cache.set(cacheKey, maxValidUntil);
        }
      }
    }
  }

  async logout(options?: SsoLogoutOptions): Promise<SsoLogoutStart> {
    if (this.pendingLogout) return this.publicLogout(this.pendingLogout);

    if (this.pendingLogin) {
      const reject = this.pendingLogin.reject;
      this.finishPendingLogin();
      reject(new Error("TDEI SSO login cancelled"));
    }
    this.clearTokens();

    const callbackUrl = new URL(getConfig().ssoCallbackUrl);
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    const server: Server | undefined =
      (options?.bindCallbackListener ?? true)
        ? await new Promise<Server>((resolve, reject) => {
            const listener = createServer((request, response) => {
              const requestUrl = new URL(request.url ?? "/", callbackUrl.origin);

              if (request.method !== "GET" || requestUrl.pathname !== callbackUrl.pathname) {
                response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...CALLBACK_SECURITY_HEADERS });
                response.end("Not found");
                return;
              }

              const providerError = requestUrl.searchParams.get("error");
              this.finishPendingLogout();
              if (providerError) {
                const error = new Error(`TDEI SSO logout failed: ${sanitizeAuthErrorDetail(providerError)}`);
                rejectCompletion(error);
                response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", ...CALLBACK_SECURITY_HEADERS });
                response.end(sanitizeAuthErrorDetail(error.message));
                return;
              }

              resolveCompletion();
              response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CALLBACK_SECURITY_HEADERS });
              response.end(
                "<!doctype html><title>TDEI logout complete</title><h1>Logout complete</h1><p>You may close this window and return to your agent.</p>",
              );
            });

            const onError = (error: Error) => {
              listener.off("listening", onListening);
              listener.close();
              reject(error);
            };
            const onListening = () => {
              listener.off("error", onError);
              resolve(listener);
            };
            listener.once("error", onError);
            listener.once("listening", onListening);
            listener.listen(Number(callbackUrl.port), callbackUrl.hostname);
          }).catch((error: unknown) => {
            throw new Error(
              `Unable to start TDEI SSO logout callback server at ${callbackUrl.origin}: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
        : undefined;

    const logoutUrl = new URL("/api/v1/sso-logout", `${getConfig().apiUrl}/`);
    logoutUrl.searchParams.set("redirect_uri", browserRedirectUri(options?.redirectUri, callbackUrl).toString());
    logoutUrl.searchParams.set("client_id", TDEI_SSO_CLIENT_ID);

    const timeout = setTimeout(() => {
      const error = new Error("TDEI SSO logout timed out");
      const reject = this.pendingLogout?.reject;
      this.finishPendingLogout();
      reject?.(error);
    }, LOGIN_TIMEOUT_MS);
    timeout.unref();

    this.pendingLogout = {
      logoutUrl: logoutUrl.toString(),
      callbackUrl: callbackUrl.toString(),
      completion,
      server,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timeout,
    };
    return this.publicLogout(this.pendingLogout);
  }

  private refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.refreshToken) return Promise.reject(new Error("No refresh token available"));

    this.refreshPromise = this.requestTokens(
      "/api/v1/refresh-token",
      { refreshToken: this.refreshToken, clientId: TDEI_SSO_CLIENT_ID },
      "TDEI token refresh",
    )
      .then((tokens) => {
        this.storeTokens(tokens);
        console.error("[auth] token refresh successful");
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }

  /** Exchange a Keycloak code without storing it on this process. */
  async exchangeSsoCode(code: string, state: string): Promise<TokenResponse> {
    if (!isValidCallbackParam(code) || !isValidCallbackParam(state)) {
      throw new Error("TDEI SSO callback contains invalid code or state parameter");
    }
    return this.requestTokens("/api/v1/sso-login", { code, state, clientId: TDEI_SSO_CLIENT_ID }, "TDEI SSO login");
  }

  /** Refresh a TDEI token the client presented, without using this process's session. */
  async refreshExternalToken(refreshToken: string): Promise<TokenResponse> {
    // oxlint-disable-next-line eslint/no-control-regex -- intentional: rejects control chars in presented tokens.
    if (!refreshToken || refreshToken.length > 8192 || /[\u0000-\u0020\u007f]/.test(refreshToken)) {
      throw new Error("TDEI refresh token is invalid");
    }
    return this.requestTokens(
      "/api/v1/refresh-token",
      { refreshToken, clientId: TDEI_SSO_CLIENT_ID },
      "TDEI token refresh",
    );
  }

  private async requestTokens(path: string, body: unknown, action: string): Promise<TokenResponse> {
    const response = await fetch(new URL(path, `${getConfig().apiUrl}/`), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const details = sanitizeAuthErrorDetail(await response.text());
      console.error(`[auth] ${action} failed with status ${response.status}`);
      throw new Error(
        response.status === 401
          ? `${action} failed: invalid or expired authorization response`
          : `${action} failed with status ${response.status}: ${details}`,
      );
    }
    const tokens = (await response.json()) as TokenResponse;
    if (!tokens?.access_token) throw new Error(`${action} did not return an access token`);
    return tokens;
  }

  private storeTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.validatedUntil = undefined;
    this.tokenVersion += 1;
    if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) {
      this.expiresAt = Date.now() + tokens.expires_in * 1000;
      return;
    }
    const jwtExpirationMs = extractJwtExpirationMs(tokens.access_token);
    this.expiresAt = jwtExpirationMs ?? Date.now() + DEFAULT_TOKEN_LIFETIME_SECONDS * 1000;
  }

  private hasUsableAccessToken(): boolean {
    return Boolean(this.accessToken && this.expiresAt && Date.now() < this.expiresAt - REFRESH_SAFETY_WINDOW_MS);
  }

  private publicLogin(login: PendingLogin): SsoLoginStart {
    return {
      loginUrl: login.loginUrl,
      callbackUrl: login.callbackUrl,
      completion: login.completion,
      ...(login.state ? { state: login.state } : {}),
    };
  }

  private publicLogout(logout: PendingLogout): SsoLogoutStart {
    return { logoutUrl: logout.logoutUrl, callbackUrl: logout.callbackUrl, completion: logout.completion };
  }

  private finishPendingLogin(): void {
    const pending = this.pendingLogin;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingLogin = undefined;
    pending.server?.close();
  }

  private finishPendingLogout(): void {
    const pending = this.pendingLogout;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingLogout = undefined;
    pending.server?.close();
  }

  private clearTokens(): void {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.expiresAt = undefined;
    this.validatedUntil = undefined;
  }
}

export function injectAccessToken(token: string, expiresInSeconds?: number): AuthManager {
  if (!token) throw new Error("TDEI_TOKEN_INVALID");
  const manager = new AuthManager();
  manager.seedInjectedToken(token, expiresInSeconds);
  return manager;
}

export const authManager = new AuthManager();
