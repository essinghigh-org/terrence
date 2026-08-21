import { Elysia } from "elysia";
import { db } from "../db";
import { organizationInvitations, organizationMemberships, users } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { authPlugin } from "../auth";
import { checkOrganizationPermission, auditLog } from "../lib/utils";
import { generateAuthenticationToken, hashAuthenticationToken } from "../lib/token-service";
import { normalizeEmail } from "../lib/identity";
import { cachedOrgByName } from "../lib/cached-lookups";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
type Ctx = Readonly<{ params: Readonly<Record<string,string>>; body?: unknown; query: Readonly<Record<string,string>>; user?: Readonly<typeof users.$inferSelect> | null; orgId: string | null; teamId: string | null; request: Readonly<{ url: string }>; set: SetObj }>;

function invitationResource(row: typeof organizationInvitations.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    type: "organization-invitations",
    attributes: {
      email: row.email,
      role: row.role,
      status: row.status,
      "created-at": new Date(row.createdAt).toISOString(),
      "updated-at": new Date(row.updatedAt).toISOString(),
      "expires-at": new Date(row.expiresAt).toISOString(),
      "token-prefix": row.tokenPrefix ?? null,
    },
    relationships: {
      organization: { data: { id: row.orgId, type: "organizations" } },
      "created-by": row.createdBy === null ? { data: null } : { data: { id: row.createdBy, type: "users" } },
      "accepted-by": row.acceptedBy === null ? { data: null } : { data: { id: row.acceptedBy, type: "users" } },
    },
    links: { self: `/api/v2/organizations/${encodeURIComponent(row.orgId)}/organization-invitations/${row.id}` },
  };
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const organizationInvitationRoutes = new Elysia({ name: "organization-invitations" })
  .use(authPlugin)
  // List pending invitations for an org (admin/owner view)
  .get("/api/v2/organizations/:org_name/organization-invitations", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: Ctx): Promise<unknown> => {
    const org = await cachedOrgByName(params.org_name ?? "");
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rows = await db.query.organizationInvitations.findMany({ where: eq(organizationInvitations.orgId, org.id) });
    return { data: rows.map(invitationResource) };
  })
  // Create invitation - hashed token, email required, role optional
  .post("/api/v2/organizations/:org_name/organization-invitations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: Ctx): Promise<unknown> => {
    const org = await cachedOrgByName(params.org_name ?? "");
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const rawEmail = typeof attrs.email === "string" ? attrs.email : "";
    const email = normalizeEmail(rawEmail);
    if (email === null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A valid email is required for invitations" }] }; }
    const role = typeof attrs.role === "string" && ["owner","member"].includes(attrs.role) ? attrs.role : "member";
    const existingMember = await db.query.users.findFirst({ where: sql`lower(${users.email}) = lower(${email})` });
    if (existingMember !== undefined) {
      const mem = await db.query.organizationMemberships.findFirst({ where: and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, existingMember.id)) });
      if (mem !== undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "User is already a member" }] }; }
    }
    const pending = await db.query.organizationInvitations.findFirst({ where: and(eq(organizationInvitations.orgId, org.id), eq(organizationInvitations.emailNormalized, email), eq(organizationInvitations.status, "pending")) });
    if (pending !== undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "An invitation for this email is already pending" }] }; }
    const rawToken = generateAuthenticationToken("invite");
    const tokenHash = hashAuthenticationToken(rawToken);
    const tokenPrefix = rawToken.slice(0, 8);
    const now = Date.now();
    const id = `orginv-${crypto.randomUUID()}`;
    await db.insert(organizationInvitations).values({
      id, orgId: org.id, email, emailNormalized: email, role, status: "pending",
      tokenHash, tokenPrefix, expiresAt: now + INVITE_TTL_MS, createdBy: user?.id ?? null, acceptedBy: null, createdAt: now, updatedAt: now,
    });
    await auditLog("create", "organization-invitations", id, user?.id ?? null, org.id, { email, role });
    const row = await db.query.organizationInvitations.findFirst({ where: eq(organizationInvitations.id, id) });
    (set as { status: number }).status = 201;
    return { data: invitationResource(row!), meta: { token: rawToken } };
  })
  .delete("/api/v2/organizations/:org_name/organization-invitations/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: Ctx): Promise<unknown> => {
    const org = await cachedOrgByName(params.org_name ?? "");
    const id = params.id ?? "";
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const row = await db.query.organizationInvitations.findFirst({ where: and(eq(organizationInvitations.id, id), eq(organizationInvitations.orgId, org.id)) });
    if (row === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (row.status !== "pending") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only pending invitations can be cancelled" }] }; }
    await db.update(organizationInvitations).set({ status: "cancelled", updatedAt: Date.now() }).where(eq(organizationInvitations.id, id));
    await auditLog("cancel", "organization-invitations", id, user?.id ?? null, org.id, { email: row.email });
    (set as { status: number }).status = 204; return {};
  })
  // Accept invitation by token - materializes membership, converges identity
  .post("/api/v2/organization-invitations/:token/accept", async ({ params, user, set }: Ctx): Promise<unknown> => {
    const rawToken = params.token ?? "";
    if (rawToken.trim() === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invitation token is required" }] }; }
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const tokenHash = hashAuthenticationToken(rawToken);
    const invite = await db.query.organizationInvitations.findFirst({ where: eq(organizationInvitations.tokenHash, tokenHash) });
    if (invite === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found", detail: "Invitation not found" }] }; }
    if (invite.status !== "pending") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Invitation is ${invite.status}` }] }; }
    if (invite.expiresAt < Date.now()) {
      await db.update(organizationInvitations).set({ status: "expired", updatedAt: Date.now() }).where(eq(organizationInvitations.id, invite.id));
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invitation has expired" }] };
    }
    // Email convergence: invitation must match the acceptor's canonical email
    const acceptorEmail = normalizeEmail((user as unknown as Record<string,unknown>).email as string | null | undefined ?? null);
    if (acceptorEmail === null || acceptorEmail !== invite.emailNormalized) {
      (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Invitation email does not match your account" }] };
    }
    if ((user as unknown as Record<string,unknown>).isSuspended === true) {
      (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Suspended accounts cannot accept invitations" }] };
    }
    const existing = await db.query.organizationMemberships.findFirst({ where: and(eq(organizationMemberships.orgId, invite.orgId), eq(organizationMemberships.userId, user.id)) });
    if (existing !== undefined) {
      await db.update(organizationInvitations).set({ status: "accepted", acceptedBy: user.id, updatedAt: Date.now() }).where(eq(organizationInvitations.id, invite.id));
      (set as { status: number }).status = 200; return { data: invitationResource({ ...invite, status: "accepted", acceptedBy: user.id }) };
    }
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.insert(organizationMemberships).values({ id: `orgmem-${crypto.randomUUID()}`, orgId: invite.orgId, userId: user.id, role: invite.role, status: "active" }).onConflictDoNothing();
      await t.update(organizationInvitations).set({ status: "accepted", acceptedBy: user.id, updatedAt: Date.now() }).where(eq(organizationInvitations.id, invite.id));
      // Clear provisional if this invite resolves it
      if ((user as unknown as Record<string,unknown>).isProvisional === true) {
        await t.update(users).set({ isProvisional: false }).where(eq(users.id, user.id));
      }
    });
    await auditLog("accept", "organization-invitations", invite.id, user.id, invite.orgId, { email: invite.email });
    await auditLog("create", "organization-memberships", invite.id, user.id, invite.orgId, { email: invite.email, role: invite.role, via: "invitation" });
    const updated = await db.query.organizationInvitations.findFirst({ where: eq(organizationInvitations.id, invite.id) });
    return { data: invitationResource(updated!) };
  });
