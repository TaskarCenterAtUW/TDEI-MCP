import { createServer, type Server } from "node:http";

import { config } from "../config.js";
import type {
  AuthStatus,
  SsoLoginStart,
  SsoLogoutStart,
  TokenResponse,
} from "./types.js";

const DEFAULT_TOKEN_LIFETIME_SECONDS = 29 * 60;
const REFRESH_SAFETY_WINDOW_MS = 2 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingLogin extends SsoLoginStart {
  server: Server;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingLogout extends SsoLogoutStart {
  server: Server;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class AuthManager {
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private tokenVersion = 0;
  private pendingLogin?: PendingLogin;
  private pendingLogout?: PendingLogout;
  private refreshPromise?: Promise<void>;

  getTokenVersion(): number {
    return this.tokenVersion;
  }

  getStatus(): AuthStatus {
    const authenticated = this.hasUsableAccessToken();
    return {
      configured: Boolean(config.ssoClientId && config.ssoCallbackUrl),
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

  async startSsoLogin(): Promise<SsoLoginStart> {
    if (this.pendingLogin) return this.publicLogin(this.pendingLogin);
    if (this.pendingLogout) {
      const reject = this.pendingLogout.reject;
      this.finishPendingLogout();
      reject(new Error("TDEI SSO logout cancelled by a new login"));
    }

    const callbackUrl = new URL(config.ssoCallbackUrl);
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    let exchanging = false;
    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", callbackUrl.origin);

      if (request.method !== "GET" || requestUrl.pathname !== callbackUrl.pathname) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      if (exchanging) {
        response.writeHead(409, { "Content-Type": "text/plain" });
        response.end("TDEI SSO login is already being completed.");
        return;
      }
      exchanging = true;

      try {
        const providerError = requestUrl.searchParams.get("error");
        if (providerError) throw new Error(`TDEI SSO failed: ${providerError}`);

        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");
        if (!code || !state) {
          throw new Error("TDEI SSO callback is missing code or state");
        }

        const tokens = await this.requestTokens(
          "/api/v1/sso-login",
          { code, state, clientId: config.ssoClientId },
          "TDEI SSO login",
        );
        this.storeTokens(tokens);
        this.finishPendingLogin();
        resolveCompletion();

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>TDEI login complete</title><h1>Login complete</h1><p>You may close this window and return to your agent.</p>");
      } catch (error) {
        const loginError = error instanceof Error ? error : new Error(String(error));
        this.finishPendingLogin();
        rejectCompletion(loginError);
        response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(loginError.message);
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(Number(callbackUrl.port), callbackUrl.hostname);
      });
    } catch (error) {
      throw new Error(`Unable to start TDEI SSO callback server at ${callbackUrl.origin}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const loginUrl = new URL("/api/v1/sso-redirect", `${config.apiUrl}/`);
    loginUrl.searchParams.set("redirect_uri", callbackUrl.toString());
    loginUrl.searchParams.set("client_id", config.ssoClientId);

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
      server,
      reject: rejectCompletion,
      timeout,
    };
    return this.publicLogin(this.pendingLogin);
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

  async logout(): Promise<SsoLogoutStart> {
    if (this.pendingLogout) return this.publicLogout(this.pendingLogout);

    if (this.pendingLogin) {
      const reject = this.pendingLogin.reject;
      this.finishPendingLogin();
      reject(new Error("TDEI SSO login cancelled"));
    }
    this.clearTokens();

    const callbackUrl = new URL(config.ssoCallbackUrl);
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", callbackUrl.origin);

      if (request.method !== "GET" || requestUrl.pathname !== callbackUrl.pathname) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }

      const providerError = requestUrl.searchParams.get("error");
      this.finishPendingLogout();
      if (providerError) {
        const error = new Error(`TDEI SSO logout failed: ${providerError}`);
        rejectCompletion(error);
        response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(error.message);
        return;
      }

      resolveCompletion();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>TDEI logout complete</title><h1>Logout complete</h1><p>You may close this window and return to your agent.</p>");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(Number(callbackUrl.port), callbackUrl.hostname);
      });
    } catch (error) {
      server.close();
      throw new Error(`Unable to start TDEI SSO logout callback server at ${callbackUrl.origin}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const logoutUrl = new URL("/api/v1/sso-logout", `${config.apiUrl}/`);
    logoutUrl.searchParams.set("redirect_uri", callbackUrl.toString());
    logoutUrl.searchParams.set("client_id", config.ssoClientId);

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
      { refreshToken: this.refreshToken, clientId: config.ssoClientId },
      "TDEI token refresh",
    ).then((tokens) => {
      this.storeTokens(tokens);
      console.error("[auth] token refresh successful");
    }).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async requestTokens(path: string, body: unknown, action: string): Promise<TokenResponse> {
    const response = await fetch(new URL(path, `${config.apiUrl}/`), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const details = await response.text();
      console.error(`[auth] ${action} failed with status ${response.status}`);
      throw new Error(response.status === 401
        ? `${action} failed: invalid or expired authorization response`
        : `${action} failed with status ${response.status}: ${details}`);
    }
    const tokens = (await response.json()) as TokenResponse;
    if (!tokens?.access_token) throw new Error(`${action} did not return an access token`);
    return tokens;
  }

  private storeTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.tokenVersion += 1;
    const lifetime = typeof tokens.expires_in === "number" && tokens.expires_in > 0
      ? tokens.expires_in
      : DEFAULT_TOKEN_LIFETIME_SECONDS;
    this.expiresAt = Date.now() + lifetime * 1000;
  }

  private hasUsableAccessToken(): boolean {
    return Boolean(this.accessToken && this.expiresAt && Date.now() < this.expiresAt - REFRESH_SAFETY_WINDOW_MS);
  }

  private publicLogin(login: PendingLogin): SsoLoginStart {
    return { loginUrl: login.loginUrl, callbackUrl: login.callbackUrl, completion: login.completion };
  }

  private publicLogout(logout: PendingLogout): SsoLogoutStart {
    return { logoutUrl: logout.logoutUrl, callbackUrl: logout.callbackUrl, completion: logout.completion };
  }

  private finishPendingLogin(): void {
    const pending = this.pendingLogin;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingLogin = undefined;
    pending.server.close();
  }

  private finishPendingLogout(): void {
    const pending = this.pendingLogout;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingLogout = undefined;
    pending.server.close();
  }

  private clearTokens(): void {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.expiresAt = undefined;
  }
}

export const authManager = new AuthManager();
