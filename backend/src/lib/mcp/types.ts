import type { TokenScopes, WorkspacePermissionGrant } from "../token-scopes";

/** Shared request authorization context for Terrence MCP tools. */
export type McpSession = Readonly<{
  userId: string | null;
  orgId: string | null;
  teamId: string | null;
  tokenId: string;
  scopes: TokenScopes | null;
}>;

type ToolHandler = (session: McpSession, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

export type McpToolAnnotations = Readonly<{
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}>;

export const READ_ONLY_TOOL = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}) satisfies McpToolAnnotations;

export const ADDITIVE_TOOL = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}) satisfies McpToolAnnotations;

export const IDEMPOTENT_MUTATION_TOOL = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}) satisfies McpToolAnnotations;

export const DESTRUCTIVE_TOOL = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}) satisfies McpToolAnnotations;

export const IDEMPOTENT_DESTRUCTIVE_TOOL = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
}) satisfies McpToolAnnotations;

export const OPEN_WORLD_ADDITIVE_TOOL = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
}) satisfies McpToolAnnotations;

export const OPEN_WORLD_DESTRUCTIVE_TOOL = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}) satisfies McpToolAnnotations;

/**
 * A modular MCP tool definition. `requires` controls discovery visibility and
 * is re-checked before execution; handlers still perform resource-level
 * authorization for the concrete object they access.
 */
export type McpTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  requires: readonly WorkspacePermissionGrant[];
  handler: ToolHandler;
}>;

export type McpToolFailure = Readonly<{
  kind: "mcp-tool-failure";
  category: "forbidden" | "invalid_request";
  message: string;
}>;

export function isMcpToolFailure(value: unknown): value is McpToolFailure {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "mcp-tool-failure" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Tool-level authorization failure, returned as a normal CallToolResult error. */
export function toolError(message: string): McpToolFailure {
  return { kind: "mcp-tool-failure", category: "forbidden", message };
}

/** Invalid tool input/resource state, returned as a normal CallToolResult error. */
export function toolBadRequest(message: string): McpToolFailure {
  return { kind: "mcp-tool-failure", category: "invalid_request", message };
}
