import type { TokenScopes, WorkspacePermissionGrant } from "../token-scopes";

/**
 * Shared types for the modular MCP tool registry.
 *
 * Each MCP tool declares the fine-grained grants it needs (`requires`). The
 * MCP route filters `tools/list` by the authenticating token's scopes, so a
 * fine-grained token only sees the tools its grants permit — agents are not
 * flooded with tools they cannot call. A legacy token (`scopes === null`)
 * always sees every tool.
 *
 * The declared grants are a visibility hint for discovery. Actual enforcement
 * happens inside each handler (and the shared permission helpers), which
 * already intersect fine-grained scopes via request-scoped storage, so a tool
 * can never exceed what the token's grants allow.
 */

export type McpSession = Readonly<{
  userId: string | null;
  orgId: string | null;
  teamId: string | null;
  tokenId: string;
  scopes: TokenScopes | null;
}>;

export type ToolHandler = (session: McpSession, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

export type McpTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Fine-grained grants required to see/call this tool. Empty means the tool
   * is membership-scoped (e.g. listing orgs the token belongs to) and is
   * always exposed. A tool with grants is exposed only when the token holds
   * every listed grant (honoring grant implications via scopeGrants).
   */
  requires: readonly WorkspacePermissionGrant[];
  handler: ToolHandler;
}>;

export type JsonRpcError = Readonly<{
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}>;

/** Tool-level authorization failure (JSON-RPC error, not a wrapped result). */
export function toolError(message: string): JsonRpcError {
  return { jsonrpc: "2.0", id: null, error: { code: -32001, message } };
}

/** Invalid arguments / resource-not-found style failure. */
export function toolBadRequest(message: string): JsonRpcError {
  return { jsonrpc: "2.0", id: null, error: { code: -32602, message } };
}

export function isJsonRpcError(value: unknown): value is JsonRpcError {
  return typeof value === "object" && value !== null && "jsonrpc" in value && "error" in value;
}
