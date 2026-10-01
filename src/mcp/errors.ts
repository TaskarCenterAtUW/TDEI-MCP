export const MAX_OUTPUT_BYTES = 262144;

const TRUNCATION_HINT = "Output exceeded 256KB; refine filters or call a narrower operation.";

export type TdeiErrorCode =
  | "TDEI_SSO_REQUIRED"
  | "TDEI_TOKEN_EXPIRED"
  | "TDEI_TOKEN_INVALID"
  | "TDEI_FORBIDDEN"
  | "TDEI_NOT_FOUND"
  | "TDEI_CONFLICT"
  | "TDEI_UPSTREAM_5XX"
  | "TDEI_CONFIG_INVALID"
  | "TDEI_TOOL_DISABLED"
  | "TDEI_CHILD_UNAVAILABLE";

export interface TdeiErrorStepRef {
  workflow: string;
  stepId: string;
  stepIndex: number;
  tool: string;
}

export interface TdeiMcpError {
  code: TdeiErrorCode;
  message: string;
  hint: string;
  retryable: boolean;
  stepRef?: TdeiErrorStepRef;
}

interface BackendShaped {
  status?: number;
  body?: unknown;
}

function extractBackendMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body ? body : undefined;
  }
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}

// Status table folded in from the deleted dead API helper's
// getErrorMessage(). That module is gone: nothing imported its request
// helper, and workflow steps must go through the version-gated child.
export function inferCode(err: unknown): { code: TdeiErrorCode; message: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const status = typeof err === "object" && err !== null && typeof (err as BackendShaped).status === "number"
    ? (err as BackendShaped).status as number
    : undefined;
  const backendMessage = typeof err === "object" && err !== null
    ? extractBackendMessage((err as BackendShaped).body)
    : undefined;

  if (/TDEI_SSO_REQUIRED/.test(message)) {
    return { code: "TDEI_SSO_REQUIRED", message: "TDEI SSO login is required. Call tdei_sso_login and open the returned URL.", retryable: false };
  }
  if (/TDEI_TOKEN_EXPIRED/.test(message)) {
    return { code: "TDEI_TOKEN_EXPIRED", message: "TDEI access token expired. Refresh via POST /api/v1/refresh-token or call tdei_sso_login.", retryable: true };
  }
  if (/TDEI_TOKEN_INVALID/.test(message)) {
    return { code: "TDEI_TOKEN_INVALID", message: "TDEI access token is invalid. Call tdei_sso_login and open the returned URL.", retryable: false };
  }
  if (status === 403 || /forbidden|permission/i.test(message)) {
    return {
      code: "TDEI_FORBIDDEN",
      message: backendMessage ? `You do not have permission: ${backendMessage}` : "You do not have permission to perform this TDEI operation.",
      retryable: false,
    };
  }
  if (status === 404) {
    return { code: "TDEI_NOT_FOUND", message: "The requested TDEI resource was not found.", retryable: false };
  }
  if (status === 409) {
    return { code: "TDEI_CONFLICT", message: backendMessage ? `TDEI request conflict: ${backendMessage}` : "The TDEI request conflicts with the current resource state.", retryable: false };
  }
  if ((status !== undefined && status >= 500) || /child|spawn|ENOENT|ECONNRESET/i.test(message)) {
    return { code: status !== undefined && status >= 500 ? "TDEI_UPSTREAM_5XX" : "TDEI_CHILD_UNAVAILABLE", message: status !== undefined && status >= 500 ? "The TDEI service returned a server error." : "The AWS tool child is unavailable.", retryable: true };
  }
  if (/disabled by config/.test(message)) {
    return { code: "TDEI_TOOL_DISABLED", message, retryable: false };
  }
  if (status === 400) {
    return { code: "TDEI_CONFIG_INVALID", message: backendMessage ? `TDEI request was invalid: ${backendMessage}` : "TDEI request was invalid.", retryable: false };
  }
  return { code: "TDEI_UPSTREAM_5XX", message: message || "Unexpected TDEI error.", retryable: false };
}

const HINTS: Record<TdeiErrorCode, string> = {
  TDEI_SSO_REQUIRED: "Call tdei_sso_login and open the returned URL.",
  TDEI_TOKEN_EXPIRED: "Refresh via POST /api/v1/refresh-token or call tdei_sso_login.",
  TDEI_TOKEN_INVALID: "Call tdei_sso_login and open the returned URL.",
  TDEI_FORBIDDEN: "Check your TDEI account's project-group permissions for this operation.",
  TDEI_NOT_FOUND: "Verify the resource id and environment (dev/stage/prod).",
  TDEI_CONFLICT: "Re-read the resource state and retry with current values.",
  TDEI_UPSTREAM_5XX: "Retry; if it persists, check TDEI environment status.",
  TDEI_CONFIG_INVALID: "Check .env values and tdei.config.json against the documented schema.",
  TDEI_TOOL_DISABLED: "Enable the tool in tdei.config.json or call tdei_reload_config.",
  TDEI_CHILD_UNAVAILABLE: "Call tdei_load_api_tools to restart the AWS child.",
};

export function formatError(err: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const inferred = inferCode(err);
  const stepRef = typeof err === "object" && err !== null && "stepRef" in err
    ? (err as { stepRef: TdeiErrorStepRef }).stepRef
    : undefined;
  const payload: TdeiMcpError = {
    code: inferred.code,
    message: inferred.message,
    hint: HINTS[inferred.code],
    retryable: inferred.retryable,
    ...(stepRef ? { stepRef } : {}),
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function truncateText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  let end = MAX_OUTPUT_BYTES;
  while (end > 0 && (text.charCodeAt(end) & 0xc0) === 0x80) end -= 1;
  const suffix = `\n{"truncated":true,"hint":${JSON.stringify(TRUNCATION_HINT)}}`;
  return { text: text.slice(0, end) + suffix, truncated: true };
}
