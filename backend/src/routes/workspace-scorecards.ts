import { Elysia } from "elysia";
import { db } from "../db";
import { users, organizations, workspaces, workspaceTags, policySetWorkspaces } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { checkOrganizationPermission } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

const SUPPORTED_ENGINE_MAJOR_MINOR = new Set(["1.5", "1.6", "1.7", "1.8", "1.9", "1.10", "1.11", "1.12", "1.13", "1.14", "1.15", "1.16"]);

/** "1.9.8" -> "1.9", "latest" -> "latest". Patch versions match their major.minor. */
function engineMajorMinor(version: string | null | undefined): string {
  if (version === null || version === undefined || version === "") return "unknown";
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  const [major, minor] = normalized.split(".");
  if (major === undefined || minor === undefined) return normalized;
  return `${major}.${minor}`;
}

/**
 * Workspace compliance scorecards (kanban 21.12). Read-only aggregation over
 * existing workspace signals: VCS connection, policy attachment, health
 * assessments, an "owner"-keyed direct tag, and a supported engine version.
 * Deliberately advisory: it never gates runs or mutates anything.
 */
export const workspaceScorecardRoutes = new Elysia()
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/workspace-scorecards", async ({
    params,
    user,
    orgId,
    set,
  }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, orgId ?? null, null, "read-workspaces"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (orgId !== null && orgId !== undefined && orgId !== org.id) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Scoped tokens may only read scorecards within their organization" }] };
    }

    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, org.id) });
    if (orgWorkspaces.length === 0) return { data: [] };

    const workspaceIds = orgWorkspaces.map((w): string => w.id);

    // Direct owner tag rows + policy attachments for all org workspaces.
    const [tagRows, policyRows] = await Promise.all([
      db.query.workspaceTags.findMany({
        columns: { workspaceId: true, key: true },
        where: and(
          inArray(workspaceTags.workspaceId, workspaceIds),
          eq(workspaceTags.key, "owner"),
        ),
      }),
      db.query.policySetWorkspaces.findMany({
        columns: { workspaceId: true },
        where: inArray(policySetWorkspaces.workspaceId, workspaceIds),
      }),
    ]);
    const ownerTags = new Set(tagRows.map((tag): string => tag.workspaceId));
    const workspacesWithPolicies = new Set(policyRows.map((row): string => row.workspaceId));

    const data = orgWorkspaces.map((workspace): Record<string, unknown> => {
      const vcsConnected = workspace.vcsRepo?.identifier !== undefined && workspace.vcsRepo.identifier !== "";
      const policyAttached = workspacesWithPolicies.has(workspace.id);
      const assessmentEnabled = workspace.assessmentsEnabled === true;
      const hasOwnerTag = ownerTags.has(workspace.id);
      const supportedVersion = workspace.terraformVersion === "latest"
        || SUPPORTED_ENGINE_MAJOR_MINOR.has(engineMajorMinor(workspace.terraformVersion));
      const passed = [
        vcsConnected, policyAttached, assessmentEnabled, hasOwnerTag, supportedVersion,
      ].filter(Boolean).length;
      return {
        id: workspace.id,
        type: "workspace-scorecards",
        attributes: {
          "workspace-name": workspace.name,
          "vcs-connected": vcsConnected,
          "policy-attached": policyAttached,
          "assessment-enabled": assessmentEnabled,
          "owner-tag-present": hasOwnerTag,
          "engine-version-supported": supportedVersion,
          score: passed,
          "max-score": 5,
        },
      };
    });

    return { data };
  });