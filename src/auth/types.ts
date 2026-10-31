export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
}

type AuthState = "signed_out" | "login_pending" | "authenticated" | "logout_pending";

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  state: AuthState;
  loginMethod: "sso";
  expiresAt?: number | undefined;
}

export interface SsoLoginStart {
  loginUrl: string;
  callbackUrl: string;
  completion: Promise<void>;
  state?: string | undefined;
}

export interface SsoLoginOptions {
  state?: string | undefined;
  /**
   * Bind the loopback SSO callback listener (default true). HTTP servers
   * that already serve /auth/callback on their own port pass false so SSO
   * login never grabs a second port.
   */
  bindCallbackListener?: boolean | undefined;
  /**
   * Browser redirect sent to TDEI. Defaults to the configured loopback
   * callback. Gateway logins pass the public URL nginx routes back to
   * this process.
   */
  redirectUri?: string | undefined;
}

export interface ValidateTokenOptions {
  fetchImpl?: typeof fetch | undefined;
  cache?: Map<string, number> | undefined;
  ttlMs?: number | undefined;
}

export interface SsoLogoutStart {
  logoutUrl: string;
  callbackUrl: string;
  completion: Promise<void>;
}

export interface SsoLogoutOptions {
  /**
   * Bind the loopback SSO callback listener (default true). See
   * SsoLoginOptions.bindCallbackListener.
   */
  bindCallbackListener?: boolean | undefined;
  /** Browser redirect sent to TDEI. See SsoLoginOptions.redirectUri. */
  redirectUri?: string | undefined;
}
