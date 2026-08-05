import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, orgTokenTTLPolicies, type users } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrganizationPermission } from "../lib/utils";
import { authPlugin } from "../auth";

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: { status?: number | string; headers: Readonly<Record<string, string | number>> };
}>;

type TtlRow = typeof orgTokenTTLPolicies.$inferSelect;

function ttlResource(r: TtlRow): Record<string, unknown> {
  return {
    id: r.id,
    type: "organization-token-ttl-policies",
    attributes: {
      "token-type": r.tokenType,
      "max-ttl-ms": r.maxTtlMs,
      "created-at": new Date(r.createdAt).toISOString(),
      "updated-at": new Date(r.updatedAt).toISOString(),
    },
  };
}

function notFound(set: { status?: number | string }): { errors: { status: string; title: string }[] } {
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

export const tokenTtlRoutes = new Elysia({ name: "token-ttl" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/token-ttl-policies", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-organization-access"))) return notFound(set);
    const rows = await db.query.orgTokenTTLPolicies.findMany({ where: eq(orgTokenTTLPolicies.orgId, org.id) });
    return { data: rows.map((r: TtlRow): Record<string, unknown> => ttlResource(r)) };
  })
  .patch("/api/v2/organizations/:org_name/token-ttl-policies", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-organization-access"))) return notFound(set);
    const root = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = root.data !== null && typeof root.data === "object" ? root.data as Record<string, unknown> : {};
    const attributes = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : undefined;
    if (attributes === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "missing data.attributes" }] };
    }
    const rawList = attributes["token-ttl-policies"];
    if (!Array.isArray(rawList)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "token-ttl-policies must be an array" }] };
    }
    const now = Date.now();
    const upserts: typeof orgTokenTTLPolicies.$inferInsert[] = rawList
      .filter((item): boolean => item !== null && typeof item === "object")
      .map((item): typeof orgTokenTTLPolicies.$inferInsert => {
        const o = item as Record<string, unknown>;
        const tokenType = typeof o["token-type"] === "string" ? o["token-type"] : "";
        const maxTtlMs = typeof o["max-ttl-ms"] === "number" ? o["max-ttl-ms"] : 0;
        return { id: `ttl-${crypto.randomUUID()}`, orgId: org.id, tokenType, maxTtlMs, createdAt: now, updatedAt: now };
      });
    await db.transaction(async (tx): Promise<void> => {
      await tx.delete(orgTokenTTLPolicies).where(eq(orgTokenTTLPolicies.orgId, org.id));
      if (upserts.length > 0) await tx.insert(orgTokenTTLPolicies).values(upserts);
    });
    const saved = await db.query.orgTokenTTLPolicies.findMany({ where: eq(orgTokenTTLPolicies.orgId, org.id) });
    return { data: saved.map((r: TtlRow): Record<string, unknown> => ttlResource(r)) };
  });