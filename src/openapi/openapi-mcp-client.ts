import SwaggerParser from "@apidevtools/swagger-parser";
import { basename } from "node:path";

import { summarizeFields } from "../mcp/field-summary.js";
import { readCachedSpec, writeCachedSpec } from "./spec-disk-cache.js";

type JsonObject = Record<string, unknown>;

export async function loadOpenApiDocument(specUrl: string): Promise<JsonObject> {
  const isRemote = /^https?:\/\//i.test(specUrl);
  if (!isRemote) return (await SwaggerParser.dereference(specUrl)) as unknown as JsonObject;
  try {
    const doc = (await SwaggerParser.dereference(specUrl, { resolve: { file: false } })) as unknown as JsonObject;
    writeCachedSpec(specUrl, doc);
    return doc;
  } catch (error) {
    // Spec host unreachable: fall back to the last spec this server loaded successfully.
    const cached = readCachedSpec(specUrl);
    if (!cached) throw error;
    console.error(
      `[openapi] could not load ${specUrl} (${error instanceof Error ? error.message : String(error)}); using the last cached copy`,
    );
    return (await SwaggerParser.dereference(cached as never)) as unknown as JsonObject;
  }
}

export interface OpenApiToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  tags?: string[];
}

interface OpenApiParameter extends JsonObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonObject;
  style?: string;
  explode?: boolean;
}

interface OpenApiOperation extends JsonObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonObject }>;
  };
  responses?: Record<string, unknown>;
}

interface CompiledSpecCacheEntry {
  tools: OpenApiToolDefinition[];
  operations: Map<string, CompiledOperation>;
}

const compiledSpecCache = new WeakMap<Record<string, unknown>, Map<string, CompiledSpecCacheEntry>>();

interface CompiledOperation {
  method: string;
  path: string;
  parameters: OpenApiParameter[];
  requestBody?: OpenApiOperation["requestBody"];
  bodyPropertyNames: Set<string>;
  binaryBodyProperties: Set<string>;
}

export interface OpenApiMcpClientOptions {
  apiUrl: string;
  specUrl?: string;
  headersProvider?: () => Promise<HeadersInit>;
  fetchImpl?: typeof fetch;
  loadSpec?: () => Promise<JsonObject>;
  operationName?: (operationId: string) => string;
  logger?: (message: string) => void;
  /** Per-request timeout for ordinary calls (default 30s). */
  timeoutMs?: number;
  /** Per-request timeout for multipart calls (default 5 min). */
  uploadTimeoutMs?: number;
}

function retryDelay(attempt: number): Promise<void> {
  const ms = Math.min(250 * 2 ** (attempt - 1), 2000) * (0.5 + Math.random() / 2);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenApiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "OpenApiHttpError";
  }
}

const FAILED_LOAD_BACKOFF_MS = 15_000;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultOperationName(operationId: string): string {
  return operationId.replace(/[^A-Za-z0-9_]/g, "_");
}

function schemaForParameter(parameter: OpenApiParameter): JsonObject {
  return {
    ...parameter.schema,
    ...(parameter.description ? { description: parameter.description } : {}),
  };
}

function responseStatuses(operation: OpenApiOperation): string[] {
  return Object.keys(operation.responses ?? {}).filter((status) => /^2\d\d$/.test(status));
}

function descriptionFor(operation: OpenApiOperation): string | undefined {
  const base = operation.description ?? operation.summary;
  const statuses = responseStatuses(operation);
  const withReturns = statuses.length === 0 ? base : `${base ? `${base} | ` : ""}Returns: ${statuses.join(", ")}`;
  const tags = Array.isArray(operation.tags)
    ? operation.tags.filter((t) => typeof t === "string" && t.trim().length > 0)
    : [];
  if (tags.length === 0) return withReturns;
  const prefix = `[${tags.join(", ")}]`;
  if (!withReturns) return prefix;
  return withReturns.startsWith(prefix) ? withReturns : `${prefix} ${withReturns}`;
}

function bodySchema(operation: OpenApiOperation): { mediaType: string; schema: JsonObject } | undefined {
  const content = operation.requestBody?.content;
  if (!content) return undefined;
  const mediaType =
    ["application/json", "multipart/form-data", "application/x-www-form-urlencoded", "text/plain"].find(
      (candidate) => content[candidate],
    ) ?? Object.keys(content)[0];
  if (!mediaType) return undefined;
  return { mediaType, schema: content[mediaType]?.schema ?? {} };
}

function compileInputSchema(
  parameters: OpenApiParameter[],
  operation: OpenApiOperation,
): { schema: JsonObject; bodyPropertyNames: Set<string>; binaryBodyProperties: Set<string> } {
  const properties: JsonObject = {};
  const required = new Set<string>();
  for (const parameter of parameters) {
    properties[parameter.name] = schemaForParameter(parameter);
    if (parameter.required) required.add(parameter.name);
  }

  const bodyPropertyNames = new Set<string>();
  const binaryBodyProperties = new Set<string>();
  const body = bodySchema(operation);
  if (body) {
    const bodyProperties = isObject(body.schema.properties) ? body.schema.properties : undefined;
    if (bodyProperties) {
      for (const [name, propertySchema] of Object.entries(bodyProperties)) {
        properties[name] = propertySchema;
        bodyPropertyNames.add(name);
        if (isObject(propertySchema) && propertySchema.format === "binary") {
          binaryBodyProperties.add(name);
        }
      }
      if (Array.isArray(body.schema.required)) {
        for (const name of body.schema.required) {
          if (typeof name === "string") required.add(name);
        }
      }
    } else {
      properties.requestBody = body.schema;
      bodyPropertyNames.add("requestBody");
      if (operation.requestBody?.required) required.add("requestBody");
    }
  }

  return {
    schema: {
      type: "object",
      properties,
      required: [...required],
    },
    bodyPropertyNames,
    binaryBodyProperties,
  };
}

function serializeQuery(url: URL, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) url.searchParams.append(name, String(item));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) url.searchParams.append(key, String(item));
    }
    return;
  }
  url.searchParams.append(name, String(value));
}

function appendFormValue(form: FormData, name: string, value: unknown, binary: boolean): void {
  if (binary && typeof value === "string") {
    // File bytes never go through MCP and the gateway is never a relay: binary
    // form fields only accept file paths for hands-free client-side curl.
    throw new Error(
      `MCP never accepts file bytes — execute the upload yourself with your shell tool via curl from the client machine directly against the TDEI backend (single hop, any size) then poll with tdei_list_jobs. Refused local file "${basename(value)}".`,
    );
  }
  if (value instanceof Blob) {
    form.append(name, value);
    return;
  }
  form.append(name, typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * In-process OpenAPI adapter for the existing raw-tool seam. It deliberately
 * exposes the same listTools/callTool/close interface as the former child MCP
 * client so registration, filtering, workflows, and semantic tools stay local.
 */
export class OpenApiMcpClient {
  private readonly headersProvider: () => Promise<HeadersInit>;
  private readonly fetchImpl: typeof fetch;
  private readonly loadSpecImpl: () => Promise<JsonObject>;
  private readonly apiUrl: string;
  private readonly operationName: (operationId: string) => string;
  private readonly logger: (message: string) => void;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private tools: OpenApiToolDefinition[] | undefined;
  private operations = new Map<string, CompiledOperation>();
  private loading: Promise<void> | undefined;
  private lastFailure: { at: number; error: unknown } | undefined;

  constructor(options: OpenApiMcpClientOptions) {
    if (!options.specUrl && !options.loadSpec) {
      throw new Error("OpenApiMcpClient requires specUrl or loadSpec.");
    }
    this.apiUrl = options.apiUrl;
    this.headersProvider = options.headersProvider ?? (async () => ({}));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.operationName = options.operationName ?? defaultOperationName;
    this.logger = options.logger ?? ((message) => console.error(message));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 300_000;
    const specUrl = options.specUrl;
    this.loadSpecImpl = options.loadSpec ?? (() => loadOpenApiDocument(specUrl!));
  }

  async listTools(): Promise<{ tools: OpenApiToolDefinition[] }> {
    await this.ensureLoaded();
    return { tools: this.tools! };
  }

  async callTool(name: string, args: Record<string, unknown>) {
    await this.ensureLoaded();
    const operation = this.operations.get(name);
    if (!operation) throw new Error(`Unknown OpenAPI operation: ${name}`);

    let path = operation.path;
    const base = `${this.apiUrl.replace(/\/+$/, "")}/`;
    const url = new URL(base);
    const headers = new Headers(await this.headersProvider());
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json, text/plain, */*");
    }

    for (const parameter of operation.parameters) {
      const value = args[parameter.name];
      if (value === undefined || value === null) continue;
      if (parameter.in === "path") {
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
      } else if (parameter.in === "query") {
        serializeQuery(url, parameter.name, value);
      } else if (parameter.in === "header") {
        headers.set(parameter.name, String(value));
      } else if (parameter.in === "cookie") {
        headers.append("Cookie", `${parameter.name}=${encodeURIComponent(String(value))}`);
      }
    }
    url.pathname = new URL(path.replace(/^\/+/, ""), base).pathname;

    // oxlint-disable-next-line unicorn/consistent-function-scoping -- reassigned per request below; module scope would share mutable state across concurrent calls.
    let buildBody: () => Promise<BodyInit | undefined> = async () => undefined;
    const requestBody = operation.requestBody;
    const selectedBody = requestBody ? bodySchema({ requestBody }) : undefined;
    const isMultipart = selectedBody?.mediaType === "multipart/form-data";
    if (selectedBody) {
      const values = Object.fromEntries(
        [...operation.bodyPropertyNames].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
      );
      if (isMultipart) {
        buildBody = async () => {
          const form = new FormData();
          for (const [key, value] of Object.entries(values)) {
            appendFormValue(form, key, value, operation.binaryBodyProperties.has(key));
          }
          return form;
        };
      } else if (selectedBody.mediaType === "application/x-www-form-urlencoded") {
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) {
          if (Array.isArray(value)) value.forEach((item) => form.append(key, String(item)));
          else form.append(key, String(value));
        }
        headers.set("Content-Type", selectedBody.mediaType);
        buildBody = async () => form;
      } else if (selectedBody.mediaType === "application/json") {
        headers.set("Content-Type", selectedBody.mediaType);
        const serialized = JSON.stringify(operation.bodyPropertyNames.has("requestBody") ? args.requestBody : values);
        buildBody = async () => serialized;
      } else {
        headers.set("Content-Type", selectedBody.mediaType);
        const serialized = String(args.requestBody ?? Object.values(values)[0] ?? "");
        buildBody = async () => serialized;
      }
    }

    const method = operation.method.toUpperCase();
    // Retry policy. GETs are idempotent, so transient statuses and network
    // errors are retried. Uploads may already have been accepted when a
    // request times out or a gateway answers 502/504, and retrying would
    // create a duplicate, so they retry only on 429/503 (the server explicitly
    // did not process the request) and never after a network error or timeout.
    const isGet = method === "GET";
    const maxAttempts = isGet ? 3 : isMultipart ? 2 : 1;
    const retryableStatuses = isGet ? new Set([408, 429, 502, 503, 504]) : new Set([429, 503]);
    let response: Response | undefined;
    /* oxlint-disable no-await-in-loop -- retries with backoff are sequential by definition: each attempt must settle before the delay and the next attempt */
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const body = await buildBody();
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(isMultipart ? this.uploadTimeoutMs : this.timeoutMs),
        });
        if (attempt < maxAttempts && retryableStatuses.has(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          await retryDelay(attempt);
          continue;
        }
        break;
      } catch (error) {
        if (isGet && attempt < maxAttempts) {
          await retryDelay(attempt);
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          isMultipart ? `Multipart upload for "${name}" failed after ${attempt} attempt(s): ${reason}` : reason,
          { cause: error },
        );
      }
    }
    /* oxlint-enable no-await-in-loop */
    const finalResponse = response!;
    const contentType = finalResponse.headers.get("content-type") ?? "";
    const text = await finalResponse.text();
    let value: unknown = text;
    if (text && contentType.includes("json")) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = text;
      }
    }
    if (!finalResponse.ok) {
      throw new OpenApiHttpError(
        `Upstream API request failed with status ${finalResponse.status}.`,
        finalResponse.status,
        value,
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text: typeof value === "string" ? value : JSON.stringify(value),
        },
      ],
    };
  }

  isConnected(): boolean {
    return this.tools !== undefined;
  }

  async close(): Promise<void> {
    this.loading = undefined;
    this.tools = undefined;
    this.operations.clear();
  }

  private ensureLoaded(): Promise<void> {
    if (this.tools) return Promise.resolve();
    // A load that just failed is not retried by every request; callers fail fast for a few seconds.
    if (this.lastFailure && Date.now() - this.lastFailure.at < FAILED_LOAD_BACKOFF_MS) {
      return Promise.reject(this.lastFailure.error);
    }
    // Concurrent first calls share one spec load instead of each dereferencing it.
    const pending = (this.loading ??= this.loadAndCompile()
      .then(() => {
        this.lastFailure = undefined;
      })
      .catch((error: unknown) => {
        this.lastFailure = { at: Date.now(), error };
        throw error;
      })
      .finally(() => {
        if (this.loading === pending) this.loading = undefined;
      }));
    return pending;
  }

  /**
   * Re-reads the spec and swaps in the new tools when it changed. A failed
   * refresh keeps the current tools. Returns true when the tool set changed.
   */
  async refresh(): Promise<boolean> {
    if (!this.tools) return false;
    const compiled = this.compile(await this.loadSpecImpl());
    const changed = JSON.stringify(compiled.tools) !== JSON.stringify(this.tools);
    if (changed) {
      this.operations = compiled.operations;
      this.tools = compiled.tools;
      this.logger(`[openapi] refreshed spec: ${compiled.tools.length} operations`);
    }
    return changed;
  }

  private async loadAndCompile(): Promise<void> {
    const compiled = this.compile(await this.loadSpecImpl());
    this.tools = compiled.tools;
    this.operations = compiled.operations;
    this.logger(
      `[openapi] loaded ${compiled.tools.length} operations ${compiled.fromCache ? "from cache" : "in process"}`,
    );
  }

  private compile(spec: JsonObject): {
    tools: OpenApiToolDefinition[];
    operations: Map<string, CompiledOperation>;
    fromCache: boolean;
  } {
    const paths = isObject(spec.paths) ? spec.paths : {};

    const nameSignatureParts: string[] = [];
    for (const [path, pathItemValue] of Object.entries(paths)) {
      if (!isObject(pathItemValue)) continue;
      for (const [method, operationValue] of Object.entries(pathItemValue)) {
        if (!HTTP_METHODS.has(method) || !isObject(operationValue)) continue;
        const operation = operationValue as OpenApiOperation;
        if (!operation.operationId) continue;
        nameSignatureParts.push(`${method}:${path}:${this.operationName(operation.operationId)}`);
      }
    }
    const nameSignature = nameSignatureParts.join("|");
    const cachedBySpec = compiledSpecCache.get(spec);
    const cachedEntry = cachedBySpec?.get(nameSignature);
    if (cachedEntry) {
      return {
        tools: cachedEntry.tools.map((tool) => ({
          ...tool,
          ...(tool.tags ? { tags: [...tool.tags] } : {}),
        })),
        operations: new Map(cachedEntry.operations),
        fromCache: true,
      };
    }

    const tools: OpenApiToolDefinition[] = [];
    const operations = new Map<string, CompiledOperation>();
    const rawIdByName = new Map<string, string>();

    for (const [path, pathItemValue] of Object.entries(paths)) {
      if (!isObject(pathItemValue)) continue;
      const sharedParameters = Array.isArray(pathItemValue.parameters)
        ? (pathItemValue.parameters.filter(isObject) as OpenApiParameter[])
        : [];
      for (const [method, operationValue] of Object.entries(pathItemValue)) {
        if (!HTTP_METHODS.has(method) || !isObject(operationValue)) continue;
        const operation = operationValue as OpenApiOperation;
        if (!operation.operationId) continue;
        const name = this.operationName(operation.operationId);
        if (operations.has(name)) {
          // One operationId reused across methods or paths (FastAPI gives a multi-method
          // route such as the workspace catch-all the same id for every method): keep the
          // first and skip the rest instead of failing the whole spec. Two different ids
          // that normalize to one name stay an error, since the tool would be ambiguous.
          if (rawIdByName.get(name) === operation.operationId) {
            this.logger(
              `[openapi] duplicate operationId "${operation.operationId}" on ${method.toUpperCase()} ${path}: keeping the first operation`,
            );
            continue;
          }
          throw new Error(
            `OpenAPI operation name collision: "${operation.operationId}" maps to existing MCP tool "${name}".`,
          );
        }
        const ownParameters = Array.isArray(operation.parameters)
          ? (operation.parameters.filter(isObject) as OpenApiParameter[])
          : [];
        const parameters = [...sharedParameters, ...ownParameters];
        const compiled = compileInputSchema(parameters, operation);
        const baseDescription = descriptionFor(operation);
        // Mandatory/optional inputs straight from the spec, so the model can fill them in one go.
        const properties = isObject(compiled.schema.properties) ? Object.keys(compiled.schema.properties) : [];
        const requiredNames = Array.isArray(compiled.schema.required) ? (compiled.schema.required as string[]) : [];
        const fieldsLine =
          properties.length > 0
            ? summarizeFields({
                required: requiredNames,
                optional: properties.filter((field) => !requiredNames.includes(field)),
              })
            : undefined;
        const description = fieldsLine
          ? `${baseDescription ? `${baseDescription}\n` : ""}${fieldsLine}`
          : baseDescription;
        const tags = Array.isArray(operation.tags)
          ? operation.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          : [];
        tools.push({
          name,
          ...(description ? { description } : {}),
          inputSchema: compiled.schema,
          ...(tags.length > 0 ? { tags: [...tags] } : {}),
        });
        rawIdByName.set(name, operation.operationId);
        operations.set(name, {
          method,
          path,
          parameters,
          requestBody: operation.requestBody,
          bodyPropertyNames: compiled.bodyPropertyNames,
          binaryBodyProperties: compiled.binaryBodyProperties,
        });
      }
    }

    let specMap = compiledSpecCache.get(spec);
    if (!specMap) {
      specMap = new Map<string, CompiledSpecCacheEntry>();
      compiledSpecCache.set(spec, specMap);
    }
    specMap.set(nameSignature, {
      tools: tools.map((tool) => ({
        ...tool,
        ...(tool.tags ? { tags: [...tool.tags] } : {}),
      })),
      operations: new Map(operations),
    });

    return { tools, operations, fromCache: false };
  }
}
