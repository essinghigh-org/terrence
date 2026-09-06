import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { assessmentResults, stateVersions } from "../../db/schema";
import { findAuthorizedWorkspace } from "../authorized-resources";
import { CLIENT_ENCRYPTED_STATE_ERROR, decodeStatePayload, isClientEncryptedState } from "../validation";
import { toolBadRequest, toolError, type McpSession, type McpTool } from "./types";

/**
 * State tools. All reads require the `state:read` grant (the `state-read`
 * workspace permission maps to it). Workspaces are re-authorized via
 * findAuthorizedWorkspace so fine-grained scopes are enforced.
 */
export const stateTools: readonly McpTool[] = [
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
    requires: ["state:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args["workspace_id"]);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "state-read");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      const sv = await db.query.stateVersions.findFirst({
        where: and(eq(stateVersions.workspaceId, wsId), eq(stateVersions.status, "finalized"), eq(stateVersions.intermediate, false)),
        orderBy: [desc(stateVersions.serial)],
      });
      if (sv === undefined) return toolBadRequest(`No state versions found for workspace "${wsId}"`);
      const result: Record<string, unknown> = {
        id: sv.id,
        serial: sv.serial,
        createdAt: sv.createdAt,
        terraformVersion: sv.terraformVersion,
      };
      const payload = sv.statePayload ?? sv.jsonState;
      if (isClientEncryptedState(payload)) return toolBadRequest(CLIENT_ENCRYPTED_STATE_ERROR);
      if (payload !== null) {
        try {
          const parsed = JSON.parse(decodeStatePayload(payload)) as Record<string, unknown>;
          result["resources"] = parsed["resources"] ?? [];
          result["outputs"] = parsed["outputs"] ?? {};
        } catch {
          // not parseable
        }
      }
      if (sv.jsonStateOutputs !== null) {
        try {
          result["outputs"] = JSON.parse(decodeStatePayload(sv.jsonStateOutputs));
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
    requires: ["state:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args["workspace_id"]);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "state-read");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
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
