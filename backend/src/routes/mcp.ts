import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";
import { authPlugin } from "../auth";
import { db } from "../db";
import { teams } from "../db/schema";
import { eq } from "drizzle-orm";
import { parseTokenScopes, scopeGrants, type TokenScopes, type WorkspacePermissionGrant } from "../lib/token-scopes";
import { setRequestTokenScopes } from "../lib/request-scope";
import { allMcpTools } from "../lib/mcp";
import type { McpSession, McpTool } from "../lib/mcp/types";

// ---------------------------------------------------------------------------
// Auth — Bearer token only (no ?token= query param)
// ---------------------------------------------------------------------------
class McpAuthError extends Error {}

async function authenticatedSession(token: Readonly<{ id: string; userId: string | null; orgId: string | null; teamId: string | null; scopes?: string | null }> | null, tokenError: string | null): Promise<McpSession | null> {
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

/**
 * Parse a token's scopes column. A malformed scopes field is an auth failure:
 * fail closed (401) rather than silently granting the token full permissions.
 */
function safeParseScopes(raw: string | null): TokenScopes | null {
  try {
    return parseTokenScopes(raw);
  } catch {
    throw new McpAuthError("Token scopes are malformed");
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------
type JsonRpcSuccess = Readonly<{ jsonrpc: "2.0"; id: number | string | null; result: unknown }>;
type JsonRpcError = Readonly<{ jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } }>;

function success(id: number | string | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}
function errorRes(id: number | string | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isJsonRpcError(val: unknown): val is JsonRpcError {
  return typeof val === "object" && val !== null && "jsonrpc" in val && "error" in val;
}

/**
 * True when the session's scopes permit every grant a tool requires.
 * A legacy token (`scopes === null`) is implicitly granted everything. This is
 * the discovery-time gate: enforced both during `tools/list` (so agents don't
 * see tools they cannot call) and defensively during `tools/call`.
 */
function toolPermittedTo(session: McpSession, tool: McpTool): boolean {
  if (session.scopes === null) return true;
  if (tool.requires.length === 0) return true;
  const scopes = session.scopes;
  return tool.requires.every((grant: WorkspacePermissionGrant): boolean => scopeGrants(scopes, grant));
}

// ---------------------------------------------------------------------------
// MCP route (POST authenticates each request)
// ---------------------------------------------------------------------------
export const mcpRoutes = new Elysia()
  .use(authPlugin)
  .get("/mcp", async ({ token, tokenError, set }): Promise<Response> => {
    let session: McpSession | null = null;
    try {
      session = await authenticatedSession(token, tokenError);
    } catch (error: unknown) {
      if (error instanceof McpAuthError) {
        (set as Record<string, unknown>)["status"] = 401;
        return new Response(JSON.stringify(errorRes(null, -32001, error.message)));
      }
      throw error;
    }
    if (session === null) {
      (set as Record<string, unknown>)["status"] = 401;
      return new Response(JSON.stringify(errorRes(null, -32001, "Unauthorized — provide Authorization: Bearer ***")));
    }

    setRequestTokenScopes(session.scopes);

    const sessionId = randomUUID();
    const endpoint = `/mcp?session_id=${sessionId}`;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`));
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  })

  .post("/mcp", async ({ token, tokenError, body, set }): Promise<unknown> => {
    let session: McpSession | null = null;
    try {
      session = await authenticatedSession(token, tokenError);
    } catch (error: unknown) {
      if (error instanceof McpAuthError) {
        (set as Record<string, unknown>)["status"] = 401;
        return errorRes(null, -32001, error.message);
      }
      throw error;
    }
    if (session === null) {
      (set as Record<string, unknown>)["status"] = 401;
      return errorRes(null, -32001, "Unauthorized — provide Authorization: Bearer ***");
    }
    setRequestTokenScopes(session.scopes);
    return handleJsonRpc(session, body);
  });

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------
function parseJsonRpcRequest(rawBody: unknown): { id: string | null; method: string; params: Record<string, unknown> } | { error: unknown } {
  if (rawBody === null || typeof rawBody !== "object") {
    return { error: errorRes(null, -32700, "Parse error: body must be a JSON object") };
  }
  const req = rawBody as Record<string, unknown>;
  if (req["jsonrpc"] !== "2.0" || typeof req["method"] !== "string") {
    return { error: errorRes(null, -32600, "Invalid Request: must have jsonrpc='2.0' and method") };
  }
  const id = req["id"] !== undefined && (typeof req["id"] === "string" || typeof req["id"] === "number") ? String(req["id"]) : null;
  const params = typeof req["params"] === "object" && req["params"] !== null
    ? req["params"] as Record<string, unknown>
    : {};
  return { id, method: req["method"], params };
}

async function handleJsonRpc(session: McpSession, rawBody: unknown): Promise<unknown> {
  const parsed = parseJsonRpcRequest(rawBody);
  if ("error" in parsed) return parsed.error;
  const { id, method, params } = parsed;
  try {
    switch (method) {
      case "initialize":
        return handleInitialize(id, params);
      case "notifications/initialized":
        return null;
      case "tools/list":
        return handleToolsList(id, session);
      case "tools/call":
        return await handleToolsCall(session, id, params);
      default:
        return errorRes(id, -32601, `Method not found: ${method}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorRes(id, -32603, `Internal error: ${msg}`);
  }
}

function handleInitialize(id: string | null, _params: Record<string, unknown>): unknown {
  return success(id ?? "init", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "terrence-mcp", version: "1.0.0" },
  });
}

/** Expose only the tools the token's grants permit (a legacy token sees all). */
function handleToolsList(id: string | null, session: McpSession): unknown {
  const tools = allMcpTools
    .filter((t): boolean => toolPermittedTo(session, t))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  return success(id ?? "tools", { tools });
}

async function handleToolsCall(session: McpSession, id: string | null, params: Record<string, unknown>): Promise<unknown> {
  const toolName = typeof params["name"] === "string" ? params["name"] : "";
  const tool = allMcpTools.find((t) => t.name === toolName);
  if (tool === undefined) {
    return errorRes(id, -32602, `Unknown tool: ${toolName}`);
  }
  // Defense in depth: even if an agent fabricates a tool name, the handler
  // only runs when the token's grants permit it.
  if (!toolPermittedTo(session, tool)) {
    return errorRes(id, -32001, `Not authorized to call tool: ${toolName}`);
  }
  const args = typeof params["arguments"] === "object" && params["arguments"] !== null
    ? params["arguments"] as Record<string, unknown>
    : {};
  try {
    const result = await tool.handler(session, args);
    if (isJsonRpcError(result)) return result;
    return success(id ?? toolName, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorRes(id, -32603, `Tool error: ${msg}`);
  }
}
