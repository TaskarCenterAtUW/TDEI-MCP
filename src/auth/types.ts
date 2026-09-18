export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  username?: string;
  expiresAt?: number;
}