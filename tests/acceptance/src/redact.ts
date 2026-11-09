// Secret redaction + leak scanning. Everything written to reports/logs goes through redact().
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+\/=-]{12,}/gi;
const KEYS = /\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,})\b/g;
const KV = /("?(?:access_token|refresh_token|id_token|code_verifier|client_secret|api[_-]?key)"?\s*[:=]\s*"?)([^"\s,&}]{6,})/gi;

const registered = new Set<string>();
/** Register an exact secret value (token, API key) to be scrubbed wherever it appears. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) registered.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of registered) out = out.split(s).join("[REDACTED]");
  return out.replace(JWT, "[REDACTED_JWT]").replace(BEARER, "$1[REDACTED]").replace(KEYS, "[REDACTED_KEY]").replace(KV, "$1[REDACTED]");
}

/** Invariant 1: a response must never contain token-like material. Returns findings (empty = clean). */
export function scanForSecrets(text: string, extraSecrets: string[] = []): string[] {
  const found: string[] = [];
  if (JWT.test(text)) found.push("JWT-shaped value");
  JWT.lastIndex = 0;
  if (/Bearer\s+[A-Za-z0-9._~+\/=-]{20,}/i.test(text)) found.push("Bearer credential");
  if (/"(?:access_token|refresh_token|id_token)"\s*:\s*"[^"]{12,}"/i.test(text)) found.push("token field");
  for (const s of [...registered, ...extraSecrets]) if (s.length >= 8 && text.includes(s)) found.push("registered secret value");
  return [...new Set(found)];
}
