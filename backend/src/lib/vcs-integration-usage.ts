import { eq } from "drizzle-orm";
import { db } from "../db";
import { oauthTokens, policySets, workspaces } from "../db/schema";

/** Relational query surface shared by the global db and transaction objects. */
type Queryable = Pick<typeof db, "query">;

export type VcsIntegrationReference = Readonly<{
  kind: "github-app" | "oauth-client" | "oauth-token";
  id: string;
}>;

export type VcsIntegrationUsage = Readonly<{
  workspaces: readonly Readonly<{ id: string; name: string }>[];
  policySets: readonly Readonly<{ id: string; name: string }>[];
}>;

function referencesIntegration(
  vcsRepo: Readonly<NonNullable<typeof workspaces.$inferSelect.vcsRepo>> | null | undefined,
  reference: VcsIntegrationReference,
  oauthTokenIds: readonly string[],
): boolean {
  if (vcsRepo === null || vcsRepo === undefined) return false;
  if (reference.kind === "github-app") return vcsRepo.githubAppInstallationId === reference.id;
  return vcsRepo.oauthTokenId !== undefined && oauthTokenIds.includes(vcsRepo.oauthTokenId);
}

export async function findVcsIntegrationUsage(
  orgId: string,
  reference: VcsIntegrationReference,
  queryable: Queryable = db,
): Promise<VcsIntegrationUsage> {
  const [workspaceRows, policySetRows, tokenRows] = await Promise.all([
    queryable.query.workspaces.findMany({
      where: eq(workspaces.orgId, orgId),
      columns: { id: true, name: true, vcsRepo: true },
    }),
    queryable.query.policySets.findMany({
      where: eq(policySets.orgId, orgId),
      columns: { id: true, name: true, vcsRepo: true },
    }),
    reference.kind === "oauth-client"
      ? queryable.query.oauthTokens.findMany({
          where: eq(oauthTokens.oauthClientId, reference.id),
          columns: { id: true },
        })
      : Promise.resolve(reference.kind === "oauth-token" ? [{ id: reference.id }] : []),
  ]);
  const oauthTokenIds = tokenRows.map((token): string => token.id);
  return {
    workspaces: workspaceRows
      .filter((workspace): boolean => referencesIntegration(workspace.vcsRepo, reference, oauthTokenIds))
      .map(({ id, name }): { id: string; name: string } => ({ id, name })),
    policySets: policySetRows
      .filter((policySet): boolean => referencesIntegration(policySet.vcsRepo, reference, oauthTokenIds))
      .map(({ id, name }): { id: string; name: string } => ({ id, name })),
  };
}

function usageSummary(label: string, resources: readonly Readonly<{ name: string }>[]): string {
  const names = resources.slice(0, 5).map((resource): string => resource.name).join(", ");
  const remaining = resources.length > 5 ? ", …" : "";
  return `${String(resources.length)} ${label}${resources.length === 1 ? "" : "s"}${names === "" ? "" : ` (${names}${remaining})`}`;
}

export function vcsIntegrationUsageDetail(usage: VcsIntegrationUsage): string {
  const resources: string[] = [];
  if (usage.workspaces.length > 0) resources.push(usageSummary("workspace", usage.workspaces));
  if (usage.policySets.length > 0) resources.push(usageSummary("policy set", usage.policySets));
  return resources.length > 0
    ? `VCS integration is still in use by ${resources.join(" and ")}. Disconnect or reconfigure these resources before deleting it.`
    : "VCS integration is still in use. Disconnect or reconfigure its references before deleting it.";
}

export function isVcsIntegrationReferenceConflict(error: unknown): boolean {
  return String(error).includes("VCS integration reference is still in use");
}
