import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { organizationMemberships, organizations } from "../../db/schema";
import { checkOrgPermission } from "../utils";
import { toolBadRequest, toolError, type McpSession, type McpTool } from "./types";

/**
 * Organization-level MCP tools. `list_organizations` is membership-scoped (no
 * fine-grained grant required): it only ever returns orgs the token's scope
 * overlaps with AND the underlying user actually belongs to. Settings reads
 * require the `settings:read` grant, mirroring the API.
 */
export const orgTools: readonly McpTool[] = [
  {
    name: "list_organizations",
    description: "List organizations accessible by the authenticated token.",
    inputSchema: { type: "object", properties: {}, required: [] },
    requires: [],
    handler: async (session: McpSession): Promise<unknown> => {
      if (session.scopes !== null && session.scopes.orgs.length > 0) {
        const scopeOrgIds = [...session.scopes.orgs];
        let allowedOrgIds: string[] | null = null;
        if (session.orgId !== null) {
          allowedOrgIds = scopeOrgIds.includes(session.orgId) ? [session.orgId] : [];
        } else if (session.userId !== null) {
          const mems = await db.query.organizationMemberships.findMany({
            where: eq(organizationMemberships.userId, session.userId),
            columns: { orgId: true },
          });
          const memberSet = new Set(mems.map((m): string => m.orgId));
          allowedOrgIds = scopeOrgIds.filter((id): boolean => memberSet.has(id));
        }
        if (allowedOrgIds === null || allowedOrgIds.length === 0) return [];
        const orgRows = await db.query.organizations.findMany({
          where: inArray(organizations.id, allowedOrgIds),
          orderBy: [asc(organizations.name)],
          columns: { id: true, name: true },
        });
        return orgRows;
      }
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
    name: "get_org_settings",
    description: "Get an organization's settings by name.",
    inputSchema: {
      type: "object",
      properties: { org: { type: "string", description: "Organization name" } },
      required: ["org"],
    },
    requires: ["settings:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const orgName = typeof args["org"] === "string" ? args["org"] : "";
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, orgName),
      });
      if (org === undefined) return toolBadRequest(`Organization "${orgName}" not found`);
      if (!(await checkOrgPermission(session.userId ?? undefined, org.id, "member", session.orgId, session.teamId, "settings:read"))) {
        return toolError("Not authorized to access this organization's settings");
      }
      return {
        id: org.id,
        name: org.name,
        email: org.email,
        defaultIacBinary: org.defaultIacBinary,
        defaultTerraformVersion: org.defaultTerraformVersion,
        defaultExecutionMode: org.defaultExecutionMode,
        assessmentsEnforced: org.assessmentsEnforced,
        globalModuleSharing: org.globalModuleSharing,
        globalProviderSharing: org.globalProviderSharing,
        samlEnabled: org.samlEnabled,
        allowForceDeleteWorkspaces: org.allowForceDeleteWorkspaces,
        stacksEnabled: org.stacksEnabled,
        showPreReleases: org.showPreReleases,
        aggregatedCommitStatusEnabled: org.aggregatedCommitStatusEnabled,
        sendPassingStatusesForUntriggeredSpeculativePlans: org.sendPassingStatusesForUntriggeredSpeculativePlans,
      };
    },
  },
];