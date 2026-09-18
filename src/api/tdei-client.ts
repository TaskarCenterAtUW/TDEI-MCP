import { authManager } from "../auth/auth-manager.js";
import { config } from "../config.js";

export class TdeiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "TdeiApiError";
  }
}

type TdeiRequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

async function parseResponseBody(
  response: Response,
): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType =
    response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();

  return text || undefined;
}

export async function tdeiRequest<T>(
  path: string,
  options: TdeiRequestOptions = {},
): Promise<T> {
  const accessToken =
    await authManager.getAccessToken();

  const response = await fetch(
    new URL(path, `${config.apiUrl}/`),
    {
      ...options,

      headers: {
        Accept: "application/json",

        ...(options.body
          ? { "Content-Type": "application/json" }
          : {}),

        ...options.headers,

        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const responseBody =
    await parseResponseBody(response);

  if (!response.ok) {
    throw new TdeiApiError(
      getErrorMessage(
        response.status,
        responseBody,
      ),
      response.status,
      responseBody,
    );
  }

  return responseBody as T;
}

function getErrorMessage(
  status: number,
  body: unknown,
): string {
  const backendMessage =
    extractBackendMessage(body);

  switch (status) {
    case 400:
      return backendMessage
        ? `TDEI request was invalid: ${backendMessage}`
        : "TDEI request was invalid.";

    case 401:
      return "TDEI authentication failed or the session is no longer valid.";

    case 403:
      return "You do not have permission to perform this TDEI operation.";

    case 404:
      return "The requested TDEI resource was not found.";

    case 409:
      return backendMessage
        ? `TDEI request conflict: ${backendMessage}`
        : "The TDEI request conflicts with the current resource state.";

    default:
      if (status >= 500) {
        return "The TDEI service returned a server error.";
      }

      return backendMessage
        ? `TDEI request failed: ${backendMessage}`
        : `TDEI request failed with status ${status}.`;
  }
}

function extractBackendMessage(
  body: unknown,
): string | undefined {
  if (!body || typeof body !== "object") {
    return typeof body === "string"
      ? body
      : undefined;
  }

  const record =
    body as Record<string, unknown>;

  if (typeof record.message === "string") {
    return record.message;
  }

  if (typeof record.error === "string") {
    return record.error;
  }

  if (typeof record.detail === "string") {
    return record.detail;
  }

  return undefined;
}