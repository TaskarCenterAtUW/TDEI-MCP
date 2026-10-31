import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { TDEI_SSO_CLIENT_ID } from "../config.js";
import { REGISTERED_SSO_REDIRECT_URI } from "../sso-public-callback.js";
import type { TokenResponse } from "../auth/types.js";

const COOKIE_NAME = "tdei_oauth";
const COOKIE_TTL_SECONDS = 10 * 60;
const CODE_TTL_MS = 2 * 60 * 1000;

export interface OAuthEndpoints {
  origin: string;
  slug: string;
  mcpPath: string;
  resource: string;
  protectedResourceMetadata: string;
  authorizationServerMetadata: string;
  issuer: string;
  authorize: string;
  token: string;
  register: string;
}

export interface OAuthPendingLogin {
  slug: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  exp: number;
}

export interface SealedAccessToken extends TokenResponse {
  redirectUri: string;
  codeChallenge: string;
  exp: number;
}

export interface OAuthHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function oauthEndpoints(origin: string, slug: string, mcpPath: string): OAuthEndpoints {
  const base = origin.replace(/\/$/, "");
  const path = mcpPath.startsWith("/") ? mcpPath : `/${mcpPath}`;
  return {
    origin: base,
    slug,
    mcpPath: path,
    resource: `${base}${path}`,
    protectedResourceMetadata: `${base}/.well-known/oauth-protected-resource${path}`,
    authorizationServerMetadata: `${base}/.well-known/oauth-authorization-server/${slug}`,
    issuer: `${base}/${slug}`,
    authorize: `${base}/${slug}/oauth/authorize`,
    token: `${base}/${slug}/oauth/token`,
    register: `${base}/${slug}/oauth/register`,
  };
}

export function oauthChallengeHeader(endpoints: OAuthEndpoints): string {
  return `Bearer realm="tdei-mcp", resource_metadata="${endpoints.protectedResourceMetadata}"`;
}

export function isAllowedClientRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "cursor:" || url.protocol === "vscode:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function sealAuthorizationCode(tokens: TokenResponse, redirectUri: string, codeChallenge: string): string {
  const payload: SealedAccessToken = {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(typeof tokens.expires_in === "number" ? { expires_in: tokens.expires_in } : {}),
    redirectUri,
    codeChallenge,
    exp: Date.now() + CODE_TTL_MS,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", challengeKey(codeChallenge), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, ciphertext, tag].map((part) => part.toString("base64url")).join(".");
}

export function openAuthorizationCode(code: string, verifier: string): SealedAccessToken {
  const challenge = codeChallengeS256(verifier);
  const parts = code.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("invalid_grant");
  }
  const [ivPart, cipherPart, tagPart] = parts as [string, string, string];
  let payload: SealedAccessToken;
  try {
    const decipher = createDecipheriv("aes-256-gcm", challengeKey(challenge), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const json = Buffer.concat([decipher.update(Buffer.from(cipherPart, "base64url")), decipher.final()]).toString(
      "utf8",
    );
    payload = JSON.parse(json) as SealedAccessToken;
  } catch {
    throw new Error("invalid_grant");
  }
  if (payload.codeChallenge !== challenge || payload.exp <= Date.now() || !payload.access_token) {
    throw new Error("invalid_grant");
  }
  return payload;
}

function challengeKey(codeChallenge: string): Buffer {
  return createHash("sha256").update(codeChallenge).digest();
}

function signingKey(apiUrl: string, slug: string): Buffer {
  const extra = process.env.TDEI_OAUTH_SECRET?.trim() ?? "";
  return createHash("sha256").update(`tdei-mcp-oauth-v1\n${apiUrl}\n${slug}\n${extra}`).digest();
}

export function issueOAuthCookie(pending: OAuthPendingLogin, apiUrl: string, secure: boolean): string {
  const body = Buffer.from(JSON.stringify(pending)).toString("base64url");
  const sig = createHmac("sha256", signingKey(apiUrl, pending.slug)).update(body).digest("base64url");
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${COOKIE_TTL_SECONDS}`];
  if (secure) flags.push("Secure");
  return `${COOKIE_NAME}=${body}.${sig}; ${flags.join("; ")}`;
}

function clearOAuthCookie(secure: boolean): string {
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) flags.push("Secure");
  return `${COOKIE_NAME}=; ${flags.join("; ")}`;
}

export function readOAuthCookie(
  cookieHeader: string | undefined,
  apiUrl: string,
  slug: string,
): OAuthPendingLogin | undefined {
  const raw = readCookieValue(cookieHeader, COOKIE_NAME);
  if (!raw) return undefined;
  const splitAt = raw.lastIndexOf(".");
  if (splitAt <= 0) return undefined;
  const body = raw.slice(0, splitAt);
  const sig = raw.slice(splitAt + 1);
  const expected = createHmac("sha256", signingKey(apiUrl, slug)).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) return undefined;
  try {
    const pending = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthPendingLogin;
    if (pending.slug !== slug || pending.exp <= Date.now()) return undefined;
    if (!isAllowedClientRedirect(pending.redirectUri) || !pending.codeChallenge || !pending.state) return undefined;
    return pending;
  } catch {
    return undefined;
  }
}

function readCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

function ssoRedirectUrl(apiUrl: string): string {
  const loginUrl = new URL("/api/v1/sso-redirect", `${apiUrl}/`);
  loginUrl.searchParams.set("redirect_uri", REGISTERED_SSO_REDIRECT_URI);
  loginUrl.searchParams.set("client_id", TDEI_SSO_CLIENT_ID);
  return loginUrl.toString();
}

export function matchesOAuthPath(pathname: string, endpoints: OAuthEndpoints): boolean {
  return (
    pathname === new URL(endpoints.protectedResourceMetadata).pathname ||
    pathname === new URL(endpoints.authorizationServerMetadata).pathname ||
    pathname === new URL(endpoints.authorize).pathname ||
    pathname === new URL(endpoints.token).pathname ||
    pathname === new URL(endpoints.register).pathname
  );
}

export interface OAuthDispatchInput {
  method: string;
  url: URL;
  origin: string;
  slug: string;
  mcpPath: string;
  apiUrl: string;
  cookieHeader?: string | undefined;
  body?: string | undefined;
  exchangeCode: (code: string, state: string) => Promise<TokenResponse>;
  refreshToken: (refreshToken: string) => Promise<TokenResponse>;
}

function jsonResult(status: number, body: unknown, extraHeaders?: Record<string, string>): OAuthHttpResult {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: text,
  };
}

function textResult(status: number, body: string, extraHeaders?: Record<string, string>): OAuthHttpResult {
  return {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
    body,
  };
}

export async function dispatchOAuth(input: OAuthDispatchInput): Promise<OAuthHttpResult | undefined> {
  const endpoints = oauthEndpoints(input.origin, input.slug, input.mcpPath);
  const pathname = input.url.pathname;
  if (!matchesOAuthPath(pathname, endpoints)) return undefined;
  const secure = input.origin.startsWith("https://");

  if (input.method === "GET" && pathname === new URL(endpoints.protectedResourceMetadata).pathname) {
    return jsonResult(200, {
      resource: endpoints.resource,
      authorization_servers: [endpoints.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid"],
    });
  }

  if (input.method === "GET" && pathname === new URL(endpoints.authorizationServerMetadata).pathname) {
    return jsonResult(200, {
      issuer: endpoints.issuer,
      authorization_endpoint: endpoints.authorize,
      token_endpoint: endpoints.token,
      registration_endpoint: endpoints.register,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }

  if (input.method === "POST" && pathname === new URL(endpoints.register).pathname) {
    const requested = parseJson(input.body);
    const redirectUris = Array.isArray(requested.redirect_uris)
      ? requested.redirect_uris.filter(
          (value): value is string => typeof value === "string" && isAllowedClientRedirect(value),
        )
      : [];
    return jsonResult(201, {
      client_id: TDEI_SSO_CLIENT_ID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  if (input.method === "GET" && pathname === new URL(endpoints.authorize).pathname) {
    return authorize(input, secure);
  }

  if (input.method === "POST" && pathname === new URL(endpoints.token).pathname) {
    return token(input);
  }

  return textResult(405, "Method not allowed");
}

function authorize(input: OAuthDispatchInput, secure: boolean): OAuthHttpResult {
  const redirectUri = input.url.searchParams.get("redirect_uri")?.trim() ?? "";
  const state = input.url.searchParams.get("state")?.trim() ?? "";
  const challenge = input.url.searchParams.get("code_challenge")?.trim() ?? "";
  const method = input.url.searchParams.get("code_challenge_method")?.trim() ?? "";
  const responseType = input.url.searchParams.get("response_type")?.trim() ?? "";
  if (responseType !== "code" || method !== "S256" || !challenge || !state) {
    return textResult(400, "Authorization requests must use response_type=code and S256 PKCE.");
  }
  if (!isAllowedClientRedirect(redirectUri)) {
    return textResult(400, "redirect_uri must be a localhost or Cursor callback.");
  }
  const pending: OAuthPendingLogin = {
    slug: input.slug,
    redirectUri,
    state,
    codeChallenge: challenge,
    exp: Date.now() + COOKIE_TTL_SECONDS * 1000,
  };
  return {
    status: 302,
    headers: {
      Location: ssoRedirectUrl(input.apiUrl),
      "Set-Cookie": issueOAuthCookie(pending, input.apiUrl, secure),
      "Cache-Control": "no-store",
    },
    body: "",
  };
}

async function token(input: OAuthDispatchInput): Promise<OAuthHttpResult> {
  const form = new URLSearchParams(input.body ?? "");
  const grant = form.get("grant_type") ?? "";
  try {
    if (grant === "authorization_code") {
      const verifier = form.get("code_verifier") ?? "";
      const code = form.get("code") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const opened = openAuthorizationCode(code, verifier);
      if (opened.redirectUri !== redirectUri) throw new Error("invalid_grant");
      return jsonResult(200, tokenResponseBody(opened));
    }
    if (grant === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      const refreshed = await input.refreshToken(refreshToken);
      return jsonResult(200, tokenResponseBody(refreshed));
    }
  } catch {
    return jsonResult(400, { error: "invalid_grant" });
  }
  return jsonResult(400, { error: "unsupported_grant_type" });
}

function tokenResponseBody(tokens: TokenResponse): Record<string, unknown> {
  return {
    access_token: tokens.access_token,
    token_type: "Bearer",
    expires_in: typeof tokens.expires_in === "number" && tokens.expires_in > 0 ? tokens.expires_in : 1800,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
  };
}

export async function oauthCallbackResult(input: {
  url: URL;
  origin: string;
  slug: string;
  apiUrl: string;
  cookieHeader?: string | undefined;
  exchangeCode: (code: string, state: string) => Promise<TokenResponse>;
}): Promise<OAuthHttpResult | undefined> {
  const secure = input.origin.startsWith("https://");
  const pending = readOAuthCookie(input.cookieHeader, input.apiUrl, input.slug);
  if (!pending) return undefined;
  const fail = (status: number, body: string): OAuthHttpResult =>
    textResult(status, body, {
      "Set-Cookie": clearOAuthCookie(secure),
    });
  const providerError = input.url.searchParams.get("error");
  if (providerError) return fail(401, "TDEI sign-in was declined.");
  const code = input.url.searchParams.get("code")?.trim() ?? "";
  const state = input.url.searchParams.get("state")?.trim() ?? "";
  if (!code || !state) return fail(400, "TDEI sign-in callback is missing code or state.");
  try {
    const tokens = await input.exchangeCode(code, state);
    const issued = sealAuthorizationCode(tokens, pending.redirectUri, pending.codeChallenge);
    const destination = new URL(pending.redirectUri);
    destination.searchParams.set("code", issued);
    destination.searchParams.set("state", pending.state);
    return {
      status: 302,
      headers: {
        Location: destination.toString(),
        "Set-Cookie": clearOAuthCookie(secure),
        "Cache-Control": "no-store",
      },
      body: "",
    };
  } catch {
    return fail(401, "TDEI sign-in could not be completed.");
  }
}

function parseJson(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
