import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { teams } from "../db/schema";
import { allMcpTools } from "../lib/mcp";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_CAPABILITIES,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  acceptsModernMcp,
  isJsonContent,
  mcpError,
  mcpSuccess,
  parseModernMcpRequest,
  validateModernMcpHeaders,
  type JsonRpcError,
  type JsonRpcId,
  type McpRequestFailure,
  type ParsedMcpRequest,
} from "../lib/mcp/protocol";
import { isMcpToolFailure, type McpSession, type McpTool } from "../lib/mcp/types";
import { executionSetting } from "../lib/runtime-config";
import { setRequestTokenScopes } from "../lib/request-scope";
import { parseTokenScopes, scopeGrants, type TokenScopes, type WorkspacePermissionGrant } from "../lib/token-scopes";
import { requestBaseUrl } from "../lib/utils";

class McpAuthError extends Error {}

type McpToken = Readonly<{
  id: string;
  userId: string | null;
  orgId: string | null;
  teamId: string | null;
  scopes?: string | null;
}>;

type DispatchResult = Readonly<{ status: number; body: unknown }>;

function safeParseScopes(raw: string | null): TokenScopes | null {
  try {
    return parseTokenScopes(raw);
  } catch {
    throw new McpAuthError("Token scopes are malformed");
  }
}

async function authenticatedSession(token: McpToken | null, tokenError: string | null): Promise<McpSession | null> {
  if (token === null || tokenError !== null) return null;
  const team = token.teamId === null
    ? undefined
    : await db.query.teams.findFirst({ where: eq(teams.id, token.teamId), columns: { id: true, orgId: true } });
  if (token.teamId !== null && team === undefined) return null;
  return {
    userId: token.userId,
    orgId: token.orgId ?? team?.orgId ?? null,
    teamId: team?.id ?? null,
    tokenId: token.id,
    scopes: safeParseScopes(token.scopes ?? null),
  };
}

function toolPermittedTo(session: McpSession, tool: McpTool): boolean {
  const scopes = session.scopes;
  if (scopes === null || tool.requires.length === 0) return true;
  return tool.requires.every((grant: WorkspacePermissionGrant): boolean => scopeGrants(scopes, grant));
}

function setHttpStatus(set: unknown, status: number): void {
  (set as { status: number }).status = status;
}

function protocolFailure(set: unknown, failure: McpRequestFailure): JsonRpcError {
  setHttpStatus(set, failure.status);
  return failure.response;
}

function validOrigin(request: Request): boolean {
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin === null) return true;
  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin) return false;
    origin = parsed.origin;
  } catch {
    return false;
  }
  try {
    if (origin === new URL(requestBaseUrl(request)).origin) return true;
  } catch {
    return false;
  }
  const configured = executionSetting("CORS_ORIGIN");
  if (configured.includes(origin)) return true;
  return process.env.NODE_ENV !== "production"
    && (origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173");
}

function methodNotAllowed(set: unknown): JsonRpcError {
  setHttpStatus(set, 405);
  (set as { headers: Record<string, string | number> }).headers["Allow"] = "POST";
  return mcpError(null, -32600, "The MCP 2026-07-28 Streamable HTTP endpoint accepts POST only");
}

function transportValidation(request: Request, parsed: ParsedMcpRequest): McpRequestFailure | null {
  if (!isJsonContent(request.headers)) {
    return { status: 415, response: mcpError(parsed.id, -32600, "Content-Type must be application/json") };
  }
  if (!acceptsModernMcp(request.headers)) {
    return { status: 406, response: mcpError(parsed.id, -32600, "Accept must include application/json and text/event-stream") };
  }
  return validateModernMcpHeaders(request.headers, parsed);
}

export const mcpRoutes = new Elysia()
  .use(authPlugin)
  .get("/mcp", ({ set }): JsonRpcError => methodNotAllowed(set))
  .delete("/mcp", ({ set }): JsonRpcError => methodNotAllowed(set))
  .post("/mcp", async ({ request, token, tokenError, body, set }): Promise<unknown> => {
    if (!validOrigin(request)) {
      setHttpStatus(set, 403);
      return mcpError(null, -32001, "Forbidden: Origin is not allowed for this MCP endpoint");
    }

    let session: McpSession | null;
    try {
      session = await authenticatedSession(token, tokenError);
    } catch (error: unknown) {
      if (!(error instanceof McpAuthError)) throw error;
      setHttpStatus(set, 401);
      return mcpError(null, -32001, error.message);
    }
    if (session === null) {
      setHttpStatus(set, 401);
      return mcpError(null, -32001, "Unauthorized — provide Authorization: Bearer ***");
    }
    setRequestTokenScopes(session.scopes);

    const parsed = parseModernMcpRequest(body);
    if ("response" in parsed) return protocolFailure(set, parsed);
    const transportError = transportValidation(request, parsed);
    if (transportError !== null) return protocolFailure(set, transportError);

    const dispatched = await dispatchMcpRequest(session, parsed);
    setHttpStatus(set, dispatched.status);
    return dispatched.body;
  });

function discover(id: JsonRpcId): DispatchResult {
  return {
    status: 200,
    body: mcpSuccess(id, {
      supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: MCP_SERVER_CAPABILITIES,
      instructions: "Terrence exposes permission-scoped infrastructure workspace, run, state, project, and variable tools.",
      ttlMs: 300_000,
      cacheScope: "private",
    }),
  };
}

function listTools(id: JsonRpcId, session: McpSession, params: Readonly<Record<string, unknown>>): DispatchResult {
  if (params["cursor"] !== undefined) {
    return { status: 200, body: mcpError(id, -32602, "Terrence MCP does not paginate its tool catalog; cursor must be omitted") };
  }
  const tools = allMcpTools
    .filter((tool): boolean => toolPermittedTo(session, tool))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
  return {
    status: 200,
    body: mcpSuccess(id, { tools, ttlMs: 0, cacheScope: "private" }),
  };
}

async function callTool(id: JsonRpcId, session: McpSession, params: Readonly<Record<string, unknown>>): Promise<DispatchResult> {
  const toolName = typeof params["name"] === "string" ? params["name"] : "";
  const tool = allMcpTools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) return { status: 200, body: mcpError(id, -32602, `Unknown tool: ${toolName}`) };
  if (!toolPermittedTo(session, tool)) {
    return { status: 200, body: mcpError(id, -32001, `Not authorized to call tool: ${toolName}`) };
  }
  const rawArguments = params["arguments"] ?? {};
  if (rawArguments === null || typeof rawArguments !== "object" || Array.isArray(rawArguments)) {
    return { status: 200, body: mcpError(id, -32602, "tools/call arguments must be an object") };
  }
  try {
    const result = await tool.handler(session, rawArguments as Record<string, unknown>);
    if (isMcpToolFailure(result)) {
      return {
        status: 200,
        body: mcpSuccess(id, {
          content: [{ type: "text", text: result.message }],
          structuredContent: { error: { category: result.category, message: result.message } },
          isError: true,
        }),
      };
    }
    const serialized = JSON.stringify(result) ?? "null";
    return {
      status: 200,
      body: mcpSuccess(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "null" }],
        structuredContent: JSON.parse(serialized) as unknown,
        isError: false,
      }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 200, body: mcpError(id, -32603, `Tool error: ${message}`) };
  }
}

async function dispatchMcpRequest(session: McpSession, request: ParsedMcpRequest): Promise<DispatchResult> {
  switch (request.method) {
    case "server/discover":
      return discover(request.id);
    case "tools/list":
      return listTools(request.id, session, request.params);
    case "tools/call":
      return await callTool(request.id, session, request.params);
    default:
      return { status: 404, body: mcpError(request.id, -32601, `Method not found: ${request.method}`) };
  }
}

export { MCP_PROTOCOL_VERSION };
