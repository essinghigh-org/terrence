import { Elysia } from "elysia";
import { db } from "../db";
import { orgTokenTTLPolicies, type users } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrganizationPermission, notFound } from "../lib/utils";
import { isTtlPolicyTokenType } from "../lib/token-ttl-policy";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";

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

export const tokenTtlRoutes = new Elysia({ name: "token-ttl" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/token-ttl-policies", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-organization-access"))) return notFound(set);
    const rows = await db.query.orgTokenTTLPolicies.findMany({ where: eq(orgTokenTTLPolicies.orgId, org.id) });
    return { data: rows.map((r: TtlRow): Record<string, unknown> => ttlResource(r)) };
  })
  .patch("/api/v2/organizations/:org_name/token-ttl-policies", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
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
    // Validate every entry BEFORE replacing stored policies — a malformed
    // payload must be rejected outright, never silently dropped (which would
    // otherwise delete the whole existing set and write garbage).
    const cleaned: typeof orgTokenTTLPolicies.$inferInsert[] = [];
    for (const item of rawList as unknown[]) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "each token-ttl-policies entry must be an object" }] };
      }
      const o = item as Record<string, unknown>;
      const tokenType = typeof o["token-type"] === "string" ? o["token-type"].trim() : "";
      const maxTtlMs = o["max-ttl-ms"];
      // The empty string is the org-token slot (see schema.ts apiTokens.tokenType).
      // Only an *absent or non-string* token-type is malformed here. Token
      // types are whitelisted (todo 76): a policy can only govern token kinds
      // the mint path actually enforces.
      if (typeof o["token-type"] !== "string" || tokenType.length > 100 || !isTtlPolicyTokenType(tokenType) || typeof maxTtlMs !== "number" || !Number.isFinite(maxTtlMs) || maxTtlMs < 0) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "each policy requires a whitelisted token-type string (\"\" (empty, organization token slot) | user | team | team-legacy | audit-trails; empty = org token slot) and a non-negative max-ttl-ms number" }] };
      }
      cleaned.push({ id: `ttl-${crypto.randomUUID()}`, orgId: org.id, tokenType, maxTtlMs, createdAt: now, updatedAt: now });
    }
    await db.transaction(async (tx): Promise<void> => {
      await tx.delete(orgTokenTTLPolicies).where(eq(orgTokenTTLPolicies.orgId, org.id));
      if (cleaned.length > 0) await tx.insert(orgTokenTTLPolicies).values(cleaned);
    });
    const saved = await db.query.orgTokenTTLPolicies.findMany({ where: eq(orgTokenTTLPolicies.orgId, org.id) });
    return { data: saved.map((r: TtlRow): Record<string, unknown> => ttlResource(r)) };
  });