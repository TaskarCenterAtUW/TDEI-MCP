export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
}

export type AuthState =
  | "signed_out"
  | "login_pending"
  | "authenticated"
  | "logout_pending";

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  state: AuthState;
  loginMethod: "sso";
  expiresAt?: number;
}

export interface SsoLoginStart {
  loginUrl: string;
  callbackUrl: string;
  completion: Promise<void>;
}

export interface SsoLogoutStart {
  logoutUrl: string;
  callbackUrl: string;
  completion: Promise<void>;
}
