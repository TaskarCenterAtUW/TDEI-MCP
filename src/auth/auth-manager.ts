import { config } from "../config.js";
import type {
  AuthStatus,
  TokenResponse,
} from "./types.js";

const DEFAULT_TOKEN_LIFETIME_SECONDS = 29 * 60;
const REFRESH_SAFETY_WINDOW_MS = 2 * 60 * 1000;

export class AuthManager {
  private username?: string;
  private password?: string;

  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private tokenVersion = 0;

  constructor() {
    this.username = config.username;
    this.password = config.password;
  }
  getTokenVersion(): number {
    return this.tokenVersion;
}

  getStatus(): AuthStatus {
    return {
      configured: Boolean(this.username && this.password),
      authenticated: this.hasUsableAccessToken(),
      username: this.username,
      expiresAt: this.expiresAt,
    };
  }

  async getAccessToken(): Promise<string> {
    if (this.hasUsableAccessToken()) {
      console.error("[auth] using existing access token");
      return this.accessToken!;
    }

    if (this.refreshToken) {
      try {
        console.error("[auth] access token expired; attempting refresh");

        await this.refresh();

        console.error("[auth] token refresh successful");

        return this.accessToken!;
      } catch (error) {
        console.error(
          "[auth] token refresh failed:",
          error instanceof Error ? error.message : String(error),
        );

        this.clearTokens();
      }
    }

    if (!this.username || !this.password) {
      throw new Error("TDEI_AUTH_REQUIRED");
    }

    console.error("[auth] no usable token; performing login");

    await this.login();

    return this.accessToken!;
  }

  logout(): void {
    this.clearTokens();
  }

  private async login(): Promise<void> {
    if (!this.username || !this.password) {
      throw new Error("TDEI_AUTH_REQUIRED");
    }

    console.error(`[auth] authenticating ${this.username}`);

    const tokens = await this.requestTokens(
      "/api/v1/authenticate",
      {
        username: this.username,
        password: this.password,
      },
      "TDEI authentication",
    );

    this.storeTokens(tokens);

    console.error("[auth] authentication successful");
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("No refresh token available");
    }

    console.error("[auth] refreshing access token");

    const tokens = await this.requestTokens(
      "/api/v1/refresh-token",
      {
        refreshToken: this.refreshToken,
      },
      "TDEI token refresh",
    );

    this.storeTokens(tokens);
  }

  private async requestTokens(
    path: string,
    body: unknown,
    action: string,
  ): Promise<TokenResponse> {
    const response = await fetch(
      new URL(path, `${config.apiUrl}/`),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
        `[auth] ${action} failed with status ${response.status}:`,
        errorText,
      );

      if (response.status === 401) {
        throw new Error(`${action} failed: invalid credentials`);
      }

      throw new Error(
        `${action} failed with status ${response.status}`,
      );
    }

    const tokens = (await response.json()) as TokenResponse;

    if (
      !tokens ||
      typeof tokens.access_token !== "string" ||
      !tokens.access_token
    ) {
      throw new Error(
        `${action} did not return an access token`,
      );
    }

    return tokens;
  }

  private storeTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token;

    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }
    this.tokenVersion += 1;

    const lifetimeSeconds =
      typeof tokens.expires_in === "number" &&
        Number.isFinite(tokens.expires_in) &&
        tokens.expires_in > 0
        ? tokens.expires_in
        : DEFAULT_TOKEN_LIFETIME_SECONDS;
    this.expiresAt =
      Date.now() + lifetimeSeconds * 1000;
  }

  private hasUsableAccessToken(): boolean {
    if (!this.accessToken || !this.expiresAt) {
      return false;
    }

    return (
      Date.now() <
      this.expiresAt - REFRESH_SAFETY_WINDOW_MS
    );
  }

  private clearTokens(): void {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.expiresAt = undefined;
  }
}

export const authManager = new AuthManager();
