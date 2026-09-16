export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

const buildVersion = process.env["BUILD_VERSION"]?.trim();
export const MCP_SERVER_INFO = Object.freeze({ name: "terrence-mcp", version: buildVersion === undefined || buildVersion === "" ? "dev" : buildVersion });
export const MCP_SERVER_CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([MCP_PROTOCOL_VERSION]);

export const MCP_HEADER_MISMATCH = -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type JsonRpcId = string | number;

export type JsonRpcSuccess = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Readonly<Record<string, unknown>>;
}>;

export type JsonRpcError = Readonly<{
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: Readonly<{ code: number; message: string; data?: unknown }>;
}>;

export type ParsedMcpRequest = Readonly<{
  id: JsonRpcId;
  method: string;
  params: Readonly<Record<string, unknown>>;
  protocolVersion: string;
  clientCapabilities: Readonly<Record<string, unknown>>;
  clientInfo: Readonly<Record<string, unknown>> | null;
}>;

export type McpRequestFailure = Readonly<{
  status: number;
  response: JsonRpcError;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function mcpError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function completeMcpResult(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const existingMeta = record(payload["_meta"]) ?? {};
  return {
    ...payload,
    resultType: "complete",
    _meta: {
      ...existingMeta,
      [MCP_SERVER_INFO_META_KEY]: MCP_SERVER_INFO,
    },
  };
}

export function mcpSuccess(id: JsonRpcId, payload: Readonly<Record<string, unknown>>): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result: completeMcpResult(payload) };
}

function invalidRequest(id: JsonRpcId | null, message: string): McpRequestFailure {
  return { status: 400, response: mcpError(id, -32600, message) };
}

function invalidParams(id: JsonRpcId | null, message: string): McpRequestFailure {
  return { status: 400, response: mcpError(id, -32602, message) };
}

function validClientInfo(value: unknown): value is Readonly<Record<string, unknown>> {
  const info = record(value);
  if (info === null) return false;
  if (typeof info["name"] !== "string" || info["name"] === "") return false;
  if (typeof info["version"] !== "string" || info["version"] === "") return false;
  return info["title"] === undefined || typeof info["title"] === "string";
}

type ParsedMeta = Readonly<{
  protocolVersion: string;
  clientCapabilities: Readonly<Record<string, unknown>>;
  clientInfo: Readonly<Record<string, unknown>> | null;
}>;

function parseRequestMeta(id: JsonRpcId, params: Readonly<Record<string, unknown>>): ParsedMeta | McpRequestFailure {
  const meta = record(params["_meta"]);
  if (meta === null) {
    return invalidParams(id, `params._meta must be an object carrying ${MCP_PROTOCOL_VERSION_META_KEY} and ${MCP_CLIENT_CAPABILITIES_META_KEY}`);
  }
  const protocolVersion = meta[MCP_PROTOCOL_VERSION_META_KEY];
  if (typeof protocolVersion !== "string" || protocolVersion === "") {
    return invalidParams(id, `params._meta.${MCP_PROTOCOL_VERSION_META_KEY} must be a non-empty string`);
  }
  const clientCapabilities = record(meta[MCP_CLIENT_CAPABILITIES_META_KEY]);
  if (clientCapabilities === null) {
    return invalidParams(id, `params._meta.${MCP_CLIENT_CAPABILITIES_META_KEY} must be an object`);
  }
  const clientInfoValue = meta[MCP_CLIENT_INFO_META_KEY];
  if (clientInfoValue !== undefined && !validClientInfo(clientInfoValue)) {
    return invalidParams(id, `params._meta.${MCP_CLIENT_INFO_META_KEY} must contain non-empty name and version strings`);
  }
  return { protocolVersion, clientCapabilities, clientInfo: clientInfoValue ?? null };
}

/** Parse the modern, stateless MCP request envelope defined by 2026-07-28. */
export function parseModernMcpRequest(rawBody: unknown): ParsedMcpRequest | McpRequestFailure {
  const body = record(rawBody);
  if (body === null) return invalidRequest(null, "Invalid Request: body must be a JSON object");
  const rawId = body["id"];
  const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  const method = body["method"];
  if (body["jsonrpc"] !== "2.0" || typeof method !== "string" || id === null) {
    return invalidRequest(id, "Invalid Request: jsonrpc='2.0', a request id, and method are required");
  }
  const params = record(body["params"] ?? {});
  if (params === null) return invalidParams(id, "params must be an object");
  const meta = parseRequestMeta(id, params);
  if ("response" in meta) return meta;
  return { id, method, params, ...meta };
}

function decodedHeaderValue(value: string): string | null {
  if (!(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
  const encoded = value.slice("=?base64?".length, -2);
  if (encoded === "" || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function headerMismatch(id: JsonRpcId, message: string): McpRequestFailure {
  return { status: 400, response: mcpError(id, MCP_HEADER_MISMATCH, message) };
}

/** Validate the Streamable HTTP metadata mirrored from the JSON-RPC body. */
export function validateModernMcpHeaders(headers: Readonly<Headers>, request: Readonly<ParsedMcpRequest>): McpRequestFailure | null {
  const headerVersion = headers.get("mcp-protocol-version");
  if (headerVersion === null) return headerMismatch(request.id, "Header mismatch: MCP-Protocol-Version is required");
  if (headerVersion !== request.protocolVersion) {
    return headerMismatch(request.id, "Header mismatch: MCP-Protocol-Version does not match params._meta protocol version");
  }
  if (request.protocolVersion !== MCP_PROTOCOL_VERSION) {
    return {
      status: 400,
      response: mcpError(request.id, MCP_UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${request.protocolVersion}`, {
        supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
        requested: request.protocolVersion,
      }),
    };
  }
  const method = headers.get("mcp-method");
  if (method === null) return headerMismatch(request.id, "Header mismatch: Mcp-Method is required");
  if (method !== request.method) return headerMismatch(request.id, "Header mismatch: Mcp-Method does not match the JSON-RPC method");
  if (request.method !== "tools/call") return null;
  const bodyName = request.params["name"];
  if (typeof bodyName !== "string" || bodyName === "") return invalidParams(request.id, "tools/call requires a non-empty params.name");
  const rawName = headers.get("mcp-name");
  if (rawName === null) return headerMismatch(request.id, "Header mismatch: Mcp-Name is required for tools/call");
  const name = decodedHeaderValue(rawName);
  if (name === null) return headerMismatch(request.id, "Header mismatch: Mcp-Name is malformed");
  if (name !== bodyName) return headerMismatch(request.id, "Header mismatch: Mcp-Name does not match params.name");
  return null;
}

export function acceptsModernMcp(headers: Readonly<Headers>): boolean {
  const mediaTypes = (headers.get("accept") ?? "").split(",").map((value): string => value.split(";", 1)[0]?.trim().toLowerCase() ?? "");
  return mediaTypes.includes("application/json") && mediaTypes.includes("text/event-stream");
}

export function isJsonContent(headers: Readonly<Headers>): boolean {
  return (headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
