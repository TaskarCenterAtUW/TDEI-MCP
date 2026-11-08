import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The validated bearer token of the MCP request being served. A multi-user
 * server shares one OpenAPI client (and its cached spec) across callers, so
 * each upstream call reads the caller's own token from here instead of any
 * process-wide login.
 */
export const requestBearer = new AsyncLocalStorage<string>();
