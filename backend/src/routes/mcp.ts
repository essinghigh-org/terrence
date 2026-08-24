import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";
import { tokenHashCandidates } from "../lib/token-service";
import { db } from "../db";
import { apiTokens, teams } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { parseTokenScopes, scopeGrants, type TokenScopes, type WorkspacePermissionGrant } from "../lib/token-scopes";
import { setRequestTokenScopes } from "../lib/request-scope";
import { allMcpTools } from "../lib/mcp";
import type { McpSession, McpTool } from "../lib/mcp/types";

// ---------------------------------------------------------------------------
// Auth — Bearer token only (no ?token= query param)
// ---------------------------------------------------------------------------
class McpAuthError extends Error {}

async function resolveToken(raw: string): Promise<McpSession | null> {
  const [tokenHash, legacyTokenHash] = tokenHashCandidates(raw);
  const rows = await db.query.apiTokens.findMany({
    where: inArray(apiTokens.token, [tokenHash, legacyTokenHash]),
    limit: 2,
  });
  const tok = rows.find((candidate) => candidate.token === tokenHash) ?? rows[0];
  if (tok === undefined) return null;
  if (tok.token === legacyTokenHash) {
    await db.update(apiTokens).set({ token: tokenHash }).where(eq(apiTokens.id, tok.id));
  }
  if (tok.expiresAt !== null && tok.expiresAt < Date.now()) return null;
  const team = tok.teamId === null
    ? undefined
    : await db.query.teams.findFirst({ where: eq(teams.id, tok.teamId), columns: { id: true, orgId: true } });
  if (tok.teamId !== null && team === undefined) return null;
  return {
    userId: tok.userId,
    orgId: tok.orgId ?? team?.orgId ?? null,
    teamId: team?.id ?? null,
    tokenId: tok.id,
    scopes: safeParseScopes(tok.scopes),
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

async function bearerSession(request: { headers: Headers }): Promise<McpSession | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token !== "" ? resolveToken(token) : null;
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
  .get("/mcp", async ({ request, set }): Promise<Response> => {
    let session: McpSession | null = null;
    try {
      session = await bearerSession({ headers: request.headers });
    } catch (error: unknown) {
      if (error instanceof McpAuthError) {
        (set as Record<string, unknown>).status = 401;
        return new Response(JSON.stringify(errorRes(null, -32001, error.message)));
      }
      throw error;
    }
    if (session === null) {
      (set as Record<string, unknown>).status = 401;
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

  .post("/mcp", async ({ request, body, set }): Promise<unknown> => {
    let session: McpSession | null = null;
    try {
      session = await bearerSession({ headers: request.headers });
    } catch (error: unknown) {
      if (error instanceof McpAuthError) {
        (set as Record<string, unknown>).status = 401;
        return errorRes(null, -32001, error.message);
      }
      throw error;
    }
    if (session === null) {
      (set as Record<string, unknown>).status = 401;
      return errorRes(null, -32001, "Unauthorized — provide Authorization: Bearer ***");
    }
    setRequestTokenScopes(session.scopes);
    return handleJsonRpc(session, body);
  });

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------
async function handleJsonRpc(session: McpSession, rawBody: unknown): Promise<unknown> {
  if (rawBody === null || typeof rawBody !== "object") {
    return errorRes(null, -32700, "Parse error: body must be a JSON object");
  }
  const req = rawBody as Record<string, unknown>;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return errorRes(null, -32600, "Invalid Request: must have jsonrpc='2.0' and method");
  }
  const id = req.id !== undefined && (typeof req.id === "string" || typeof req.id === "number") ? String(req.id) : null;
  const params = typeof req.params === "object" && req.params !== null
    ? req.params as Record<string, unknown>
    : {};

  try {
    switch (req.method) {
      case "initialize":
        return handleInitialize(id, params);
      case "notifications/initialized":
        return null;
      case "tools/list":
        return handleToolsList(id, session);
      case "tools/call":
        return await handleToolsCall(session, id, params);
      default:
        return errorRes(id, -32601, `Method not found: ${req.method}`);
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
  const toolName = typeof params.name === "string" ? params.name : "";
  const tool = allMcpTools.find((t) => t.name === toolName);
  if (tool === undefined) {
    return errorRes(id, -32602, `Unknown tool: ${toolName}`);
  }
  // Defense in depth: even if an agent fabricates a tool name, the handler
  // only runs when the token's grants permit it.
  if (!toolPermittedTo(session, tool)) {
    return errorRes(id, -32001, `Not authorized to call tool: ${toolName}`);
  }
  const args = typeof params.arguments === "object" && params.arguments !== null
    ? params.arguments as Record<string, unknown>
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
