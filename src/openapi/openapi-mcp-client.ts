import SwaggerParser from "@apidevtools/swagger-parser";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

import { ALLOWED_UPLOAD_EXTENSIONS } from "../adapters/direct-multipart-tdei-mutations.js";

type JsonObject = Record<string, unknown>;

export async function loadOpenApiDocument(specUrl: string): Promise<JsonObject> {
  const isRemote = /^https?:\/\//i.test(specUrl);
  const doc = isRemote
    ? await SwaggerParser.dereference(specUrl, { resolve: { file: false } })
    : await SwaggerParser.dereference(specUrl);
  return doc as unknown as JsonObject;
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
  allowLocalFileUploads?: boolean;
  allowedUploadExtensions?: ReadonlySet<string>;
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

function uploadMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".zip":
      return "application/zip";
    case ".json":
      return "application/json";
    case ".geojson":
      return "application/geo+json";
    case ".osm":
    case ".osc":
    case ".xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

async function appendFormValue(
  form: FormData,
  name: string,
  value: unknown,
  binary: boolean,
  allowedExtensions: ReadonlySet<string> = ALLOWED_UPLOAD_EXTENSIONS,
): Promise<void> {
  if (binary && typeof value === "string" && isAbsolute(value)) {
    const ext = extname(value).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new Error(
        `Unsupported upload file extension "${ext || "(none)"}" for "${basename(value)}". Allowed extensions: ${[...allowedExtensions].join(", ")}.`,
      );
    }
    let fileStat;
    try {
      fileStat = await stat(value);
    } catch {
      throw new Error(`Upload file "${value}" does not exist or is not readable.`);
    }
    if (!fileStat.isFile()) {
      throw new Error(`Upload path "${value}" must point to a regular file.`);
    }
    if (fileStat.size === 0) {
      throw new Error(`Upload file "${basename(value)}" is empty (0 bytes).`);
    }
    const blob = await openAsBlob(value, { type: uploadMimeType(value) });
    form.append(name, blob, basename(value));
    return;
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
  private readonly allowLocalFileUploads: boolean;
  private readonly allowedUploadExtensions: ReadonlySet<string>;
  private tools: OpenApiToolDefinition[] | undefined;
  private operations = new Map<string, CompiledOperation>();

  constructor(options: OpenApiMcpClientOptions) {
    if (!options.specUrl && !options.loadSpec) {
      throw new Error("OpenApiMcpClient requires specUrl or loadSpec.");
    }
    this.apiUrl = options.apiUrl;
    this.headersProvider = options.headersProvider ?? (async () => ({}));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.operationName = options.operationName ?? defaultOperationName;
    this.logger = options.logger ?? ((message) => console.error(message));
    this.allowLocalFileUploads = options.allowLocalFileUploads ?? false;
    this.allowedUploadExtensions = options.allowedUploadExtensions ?? ALLOWED_UPLOAD_EXTENSIONS;
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
    const url = new URL(path.replace(/^\/+/, ""), `${this.apiUrl.replace(/\/+$/, "")}/`);
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
    url.pathname = new URL(path.replace(/^\/+/, ""), `${this.apiUrl.replace(/\/+$/, "")}/`).pathname;

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
            if (
              operation.binaryBodyProperties.has(key) &&
              !this.allowLocalFileUploads &&
              typeof value === "string" &&
              isAbsolute(value)
            ) {
              throw new Error(
                `MCP never accepts file bytes — run the upload via curl from the client machine (single hop, any size) with the SSO bearer from tdei_sso_login, then poll with tdei_list_jobs. Refused local file "${basename(value)}".`,
              );
            }
            await appendFormValue(
              form,
              key,
              value,
              operation.binaryBodyProperties.has(key) && this.allowLocalFileUploads,
              this.allowedUploadExtensions,
            );
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

    const maxAttempts = isMultipart ? 2 : 1;
    let response: Response | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const body = await buildBody();
      try {
        response = await this.fetchImpl(url, {
          method: operation.method.toUpperCase(),
          headers,
          ...(body === undefined ? {} : { body }),
        });
        if (isMultipart && attempt < maxAttempts && [408, 429, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        break;
      } catch (error) {
        if (attempt < maxAttempts) {
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          isMultipart ? `Multipart upload for "${name}" failed after ${attempt} attempt(s): ${reason}` : reason,
          { cause: error },
        );
      }
    }
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
    this.tools = undefined;
    this.operations.clear();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.tools) return;
    const spec = await this.loadSpecImpl();
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
      this.tools = cachedEntry.tools.map((tool) => ({
        ...tool,
        ...(tool.tags ? { tags: [...tool.tags] } : {}),
      }));
      this.operations = new Map(cachedEntry.operations);
      this.logger(`[openapi] loaded ${this.tools.length} operations from cache`);
      return;
    }

    const tools: OpenApiToolDefinition[] = [];
    const operations = new Map<string, CompiledOperation>();

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
          throw new Error(
            `OpenAPI operation name collision: "${operation.operationId}" maps to existing MCP tool "${name}".`,
          );
        }
        const ownParameters = Array.isArray(operation.parameters)
          ? (operation.parameters.filter(isObject) as OpenApiParameter[])
          : [];
        const parameters = [...sharedParameters, ...ownParameters];
        const compiled = compileInputSchema(parameters, operation);
        const description = descriptionFor(operation);
        const tags = Array.isArray(operation.tags)
          ? operation.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          : [];
        tools.push({
          name,
          ...(description ? { description } : {}),
          inputSchema: compiled.schema,
          ...(tags.length > 0 ? { tags: [...tags] } : {}),
        });
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

    this.operations = operations;
    this.tools = tools;
    this.logger(`[openapi] loaded ${tools.length} operations in process`);
  }
}
