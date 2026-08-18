import type { McpTool } from "./types";
import { orgTools } from "./org";
import { projectTools } from "./projects";
import { runTools } from "./runs";
import { stateTools } from "./state";
import { workspaceTools } from "./workspaces";

/**
 * The complete modular MCP tool registry.
 *
 * Add a new capability by creating a module in this directory (exporting a
 * `readonly McpTool[]`) and listing it here. Each tool declaratively lists the
 * fine-grained grants it needs via `requires`; the MCP route filters
 * `tools/list` by the authenticating token's scopes so a fine-grained token
 * only sees tools its grants permit. Legacy tokens (`scopes === null`) see all.
 */
export const allMcpTools: readonly McpTool[] = [
  ...orgTools,
  ...projectTools,
  ...runTools,
  ...stateTools,
  ...workspaceTools,
];