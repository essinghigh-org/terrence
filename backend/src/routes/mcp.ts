import { Elysia } from "elysia";
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import { db } from "../db";
import {
  apiTokens,
  assessmentResults,
  organizationMemberships,
  organizations,
  projects,
  runs,
  stateVersions,
  workspaces,
} from "../db/schema";
import { checkOrgPermission, findAuthorizedWorkspace, workspaceIdsForPermission } from "../lib/utils";
import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Auth — Bearer token only (no ?token= query param)
// ---------------------------------------------------------------------------
type McpSession = Readonly<{
  userId: string | null;
  orgId: string | null;
  teamId: string | null;
  tokenId: string;
}>;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function resolveToken(raw: string): Promise<McpSession | null> {
  const tokenHash = hashToken(raw);
  const tok = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.token, tokenHash),
  });
  if (tok === undefined) {
    const legacy = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.token, raw),
    });
    if (legacy === undefined) return null;
    if (legacy.expiresAt !== null && legacy.expiresAt < Date.now()) return null;
    return { userId: legacy.userId, orgId: legacy.orgId, teamId: null, tokenId: legacy.id };
  }
  if (tok.expiresAt !== null && tok.expiresAt < Date.now()) return null;
  return { userId: tok.userId, orgId: tok.orgId, teamId: null, tokenId: tok.id };
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
type JsonRpcSuccess = Readonly<{ jsonrpc: "2.0"; id: number | string; result: unknown }>;
type JsonRpcError = Readonly<{ jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } }>;

function success(id: number | string, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}
function errorRes(id: number | string | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
type ToolHandler = (session: McpSession, args: Record<string, unknown>) => Promise<unknown>;

const TOOLS: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}> = [
  {
    name: "list_organizations",
    description: "List organizations accessible by the authenticated token.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (session: McpSession): Promise<unknown> => {
      if (session.orgId !== null) {
        const org = await db.query.organizations.findFirst({
          where: eq(organizations.id, session.orgId),
          columns: { id: true, name: true },
        });
        return org !== undefined ? [org] : [];
      }
      if (session.userId === null) return [];
      const mems = await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, session.userId),
        columns: { orgId: true },
      });
      if (mems.length === 0) return [];
      const orgRows = await db.query.organizations.findMany({
        where: inArray(organizations.id, mems.map((m): string => m.orgId)),
        orderBy: [asc(organizations.name)],
        columns: { id: true, name: true },
      });
      return orgRows;
    },
  },
  {
    name: "get_projects",
    description: "List projects within an organization, with optional name search and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
        search: { type: "string", description: "Optional substring match on project name" },
        limit: { type: "number", description: "Max results (default 50)", default: 50 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
      },
      required: ["org"],
    },
    handler: async (session: McpSession, args: Record<string, unknown>): Promise<unknown> => {
      const orgName = String(args.org);
      const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
      if (org === undefined) return errorRes(null, -32602, `Organization "${orgName}" not found`);
      if (!(await checkOrgPermission(session.userId ?? undefined, org.id, "member", session.orgId, session.teamId))) {
        return errorRes(null, -32001, "Not authorized to access this organization");
      }
      const search = typeof args.search === "string" ? args.search : undefined;
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      const where = search !== undefined
        ? and(eq(projects.orgId, org.id), like(projects.name, `%${search}%`))
        : eq(projects.orgId, org.id);
      const rows = await db.query.projects.findMany({
        where,
        orderBy: [asc(projects.name)],
        limit,
        offset,
        columns: { id: true, name: true, createdAt: true },
      });
      return rows;
    },
  },
  {
    name: "get_workspace",
    description: "Look up workspace(s) within an organization, by exact name or search.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Organization name" },
        name: { type: "string", description: "Exact workspace name (if absent, returns list)" },
        search: { type: "string", description: "Substring match on workspace name" },
        limit: { type: "number", description: "Max results (default 50)", default: 50 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
      },
      required: ["org"],
    },
    handler: async (session: McpSession, args: Record<string, unknown>): Promise<unknown> => {
      const orgName = String(args.org);
      const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
      if (org === undefined) return errorRes(null, -32602, `Organization "${orgName}" not found`);
      if (!(await checkOrgPermission(session.userId ?? undefined, org.id, "member", session.orgId, session.teamId))) {
        return errorRes(null, -32001, "Not authorized to access this organization");
      }
      const exactName = typeof args.name === "string" ? args.name : undefined;
      const search = typeof args.search === "string" ? args.search : undefined;
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      if (exactName !== undefined) {
        // Fetch by name+org, then authorize via findAuthorizedWorkspace
        const ws = await db.query.workspaces.findFirst({
          where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, exactName)),
          columns: { id: true, name: true, orgId: true, locked: true, createdAt: true },
        });
        if (ws === undefined) return errorRes(null, -32602, `Workspace "${exactName}" not found in org "${orgName}"`);
        // Re-authorize with findAuthorizedWorkspace for workspace-level visibility
        const authorized = await findAuthorizedWorkspace(ws.id, session.userId ?? undefined, session.orgId, session.teamId, "read");
        if (authorized === undefined) return errorRes(null, -32001, "Not authorized to access this workspace");
        return { ...ws, id: authorized.id, name: authorized.name };
      }
      // List/search: filter by workspaceIdsForPermission(org.id, ..., "read")
      const authorizedIds = await workspaceIdsForPermission(org.id, session.userId ?? undefined, session.orgId, session.teamId, "read");
      if (authorizedIds === null || authorizedIds.length === 0) return [];
      const where = search !== undefined
        ? and(inArray(workspaces.id, authorizedIds as string[]), like(workspaces.name, `%${search}%`))
        : inArray(workspaces.id, authorizedIds as string[]);
      const rows = await db.query.workspaces.findMany({
        where,
        orderBy: [asc(workspaces.name)],
        limit,
        offset,
        columns: { id: true, name: true, orgId: true, locked: true, createdAt: true },
      });
      return rows;
    },
  },
  {
    name: "get_run",
    description: "Get details for a specific run, or list recent runs for a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        run_id: { type: "string", description: "Specific run ID (if absent, returns list)" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
      },
      required: ["workspace_id"],
    },
    handler: async (session: McpSession, args: Record<string, unknown>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "read");
      if (ws === undefined) return errorRes(null, -32001, "Workspace not found or not authorized");
      const runId = typeof args.run_id === "string" ? args.run_id : undefined;
      if (runId !== undefined) {
        const run = await db.query.runs.findFirst({
          where: eq(runs.id, runId),
          columns: { id: true, workspaceId: true, status: true, message: true, createdAt: true },
        });
        if (run === undefined) return errorRes(null, -32602, `Run "${runId}" not found`);
        if (run.workspaceId !== wsId) return errorRes(null, -32001, "Run does not belong to the specified workspace");
        return run;
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
      const offset = Math.max(Number(args.offset ?? 0), 0);
      const rows = await db.query.runs.findMany({
        where: eq(runs.workspaceId, wsId),
        orderBy: [desc(runs.createdAt)],
        limit,
        offset,
        columns: { id: true, workspaceId: true, status: true, message: true, createdAt: true },
      });
      return rows;
    },
  },
  {
    name: "get_workspace_state",
    description: "Return the latest Terraform state for a workspace as parsed JSON.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
      },
      required: ["workspace_id"],
    },
    handler: async (session: McpSession, args: Record<string, unknown>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "state-read");
      if (ws === undefined) return errorRes(null, -32001, "Workspace not found or not authorized");
      const sv = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, wsId),
        orderBy: [desc(stateVersions.createdAt)],
      });
      if (sv === undefined) return errorRes(null, -32602, `No state versions found for workspace "${wsId}"`);
      const result: Record<string, unknown> = {
        id: sv.id,
        serial: sv.serial,
        createdAt: sv.createdAt,
        terraformVersion: sv.terraformVersion,
      };
      if (sv.jsonState !== null) {
        try {
          const parsed = JSON.parse(sv.jsonState) as Record<string, unknown>;
          result.resources = parsed.resources ?? [];
          result.outputs = parsed.outputs ?? {};
        } catch {
          // not parseable
        }
      }
      if (sv.jsonStateOutputs !== null) {
        try {
          result.outputs = JSON.parse(sv.jsonStateOutputs);
        } catch {
          // not parseable
        }
      }
      return result;
    },
  },
  {
    name: "get_workspace_drift_status",
    description: "Return the latest drift assessment results for a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
      },
      required: ["workspace_id"],
    },
    handler: async (session: McpSession, args: Record<string, unknown>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "state-read");
      if (ws === undefined) return errorRes(null, -32001, "Workspace not found or not authorized");
      const ar = await db.query.assessmentResults.findMany({
        where: eq(assessmentResults.workspaceId, wsId),
        orderBy: [desc(assessmentResults.createdAt)],
        limit: 1,
        columns: {
          id: true,
          status: true,
          resourcesDrifted: true,
          resourcesUndrifted: true,
          checksPassed: true,
          checksFailed: true,
          allChecksSucceeded: true,
          createdAt: true,
          completedAt: true,
        },
      });
      if (ar.length === 0) return { status: "no_assessment", message: "No drift assessment has been run for this workspace" };
      return ar[0];
    },
  },
];

// ---------------------------------------------------------------------------
// SSE session store (kept for endpoint handshake; auth enforced per POST)
// ---------------------------------------------------------------------------
const sessions = new Map<string, { session: McpSession }>();

// ---------------------------------------------------------------------------
// MCP route
// ---------------------------------------------------------------------------
export const mcpRoutes = new Elysia()
  .get("/mcp", async ({ request, set }): Promise<Response> => {
    const session = await bearerSession({ headers: request.headers });
    if (session === null) {
      (set as Record<string, unknown>).status = 401;
      return new Response(JSON.stringify(errorRes(null, -32001, "Unauthorized — provide Authorization: Bearer <token>")));
    }

    const sessionId = randomUUID();
    const endpoint = `/mcp?session_id=${sessionId}`;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`));
      },
    });

    sessions.set(sessionId, { session });

    request.signal.addEventListener("abort", () => {
      sessions.delete(sessionId);
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
    const session = await bearerSession({ headers: request.headers });
    if (session === null) {
      (set as Record<string, unknown>).status = 401;
      return errorRes(null, -32001, "Unauthorized — provide Authorization: Bearer <token>");
    }
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
  const id = req.id !== undefined ? String(req.id) : null;
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
        return handleToolsList(id);
      case "tools/call":
        return handleToolsCall(session, id, params);
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

function handleToolsList(id: string | null): unknown {
  return success(id ?? "tools", {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
}

async function handleToolsCall(session: McpSession, id: string | null, params: Record<string, unknown>): Promise<unknown> {
  const toolName = typeof params.name === "string" ? params.name : "";
  const tool = TOOLS.find((t) => t.name === toolName);
  if (tool === undefined) {
    return errorRes(id, -32602, `Unknown tool: ${toolName}`);
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

function isJsonRpcError(val: unknown): val is JsonRpcError {
  return typeof val === "object" && val !== null && "jsonrpc" in val && "error" in val;
}