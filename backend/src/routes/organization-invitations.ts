import { newResourceId } from "../lib/resource-id";
import { Elysia } from "elysia";
import { db } from "../db";
import { organizationInvitations, organizationMemberships, users } from "../db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { authPlugin } from "../auth";
import { checkOrganizationPermission, checkOrgPermission, auditLog } from "../lib/utils";
import { generateAuthenticationToken, hashAuthenticationToken, tokenHashCandidates } from "../lib/token-service";
import { normalizeEmail } from "../lib/identity";
import { cachedOrgByName } from "../lib/cached-lookups";
import { publish } from "../lib/event-bus";

class InvitationActivationConflict extends Error {}

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

type InviteFailure = { status: number; body: unknown };

function inviteFailure(status: number, title: string, detail?: string): InviteFailure {
  return { status, body: { errors: [{ status: String(status), title, ...(detail === undefined ? {} : { detail }) }] } };
}

function parseInviteAttributes(body: unknown): { email: string; role: string } | { failure: InviteFailure } {
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload["data"] as Record<string, unknown> | undefined;
  const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
  const email = normalizeEmail(typeof attrs["email"] === "string" ? attrs["email"] : "");
  if (email === null) return { failure: inviteFailure(422, "Unprocessable Entity", "A valid email is required for invitations") };
  if (attrs["role"] !== undefined && (typeof attrs["role"] !== "string" || !["owner", "member"].includes(attrs["role"]))) {
    return { failure: inviteFailure(422, "Unprocessable Entity", "role must be one of: owner, member") };
  }
  return { email, role: typeof attrs["role"] === "string" ? attrs["role"] : "member" };
}

async function checkInviteOwnerGrant(
  role: string,
  user: Ctx["user"],
  orgId: string,
  tokenOrgId: string | null,
): Promise<boolean> {
  // Team-delegated membership managers may invite members, but may not grant
  // the organization-owner role.
  return role !== "owner" || user?.isSiteAdmin === true || checkOrgPermission(user?.id, orgId, "owner", tokenOrgId, null);
}

async function checkInviteConflicts(orgId: string, email: string): Promise<{ ok: true } | { failure: InviteFailure }> {
  const existingMember = await db.query.users.findFirst({ where: sql`lower(${users.email}) = lower(${email})` });
  if (existingMember !== undefined) {
    const mem = await db.query.organizationMemberships.findFirst({ where: and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.userId, existingMember.id)) });
    if (mem !== undefined) return { failure: inviteFailure(409, "Conflict", "User is already a member") };
  }
  const pending = await db.query.organizationInvitations.findFirst({ where: and(eq(organizationInvitations.orgId, orgId), eq(organizationInvitations.emailNormalized, email), eq(organizationInvitations.status, "pending")) });
  if (pending !== undefined) return { failure: inviteFailure(409, "Conflict", "An invitation for this email is already pending") };
  return { ok: true };
}

async function insertInvitation(
  orgId: string,
  email: string,
  role: string,
  createdBy: string | null,
): Promise<{ row: typeof organizationInvitations.$inferSelect; rawToken: string } | { failure: InviteFailure }> {
  const rawToken = generateAuthenticationToken("invite");
  const tokenHash = hashAuthenticationToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);
  const now = Date.now();
  const id = newResourceId("orginv");
  await db.insert(organizationInvitations).values({
    id, orgId, email, emailNormalized: email, role, status: "pending",
    tokenHash, tokenPrefix, expiresAt: now + INVITE_TTL_MS, createdBy, acceptedBy: null, createdAt: now, updatedAt: now,
  });
  await auditLog("create", "organization-invitations", id, createdBy, orgId, { email, role });
  const row = await db.query.organizationInvitations.findFirst({ where: eq(organizationInvitations.id, id) });
  if (row === undefined) return { failure: inviteFailure(500, "Internal Server Error") };
  return { row, rawToken };
}

type InviteRow = typeof organizationInvitations.$inferSelect;
type MembershipRow = typeof organizationMemberships.$inferSelect;
type Acceptor = NonNullable<Ctx["user"]>;

async function loadInviteByToken(rawToken: string): Promise<{ invite: InviteRow } | { failure: InviteFailure }> {
  const [tokenHash, legacyTokenHash] = tokenHashCandidates(rawToken);
  const inviteRows = await db.query.organizationInvitations.findMany({ where: inArray(organizationInvitations.tokenHash, [tokenHash, legacyTokenHash]), limit: 2 });
  const invite = inviteRows.find((candidate) => candidate.tokenHash === tokenHash) ?? inviteRows[0];
  if (invite === undefined) return { failure: inviteFailure(404, "Not Found", "Invitation not found") };
  if (invite.tokenHash === legacyTokenHash) {
    await db.update(organizationInvitations).set({ tokenHash }).where(eq(organizationInvitations.id, invite.id));
  }
  return { invite };
}

async function checkInviteAcceptable(invite: InviteRow): Promise<{ ok: true } | { failure: InviteFailure }> {
  if (invite.status !== "pending") return { failure: inviteFailure(422, "Unprocessable Entity", `Invitation is ${invite.status}`) };
  if (invite.expiresAt < Date.now()) {
    await db.update(organizationInvitations).set({ status: "expired", updatedAt: Date.now() }).where(eq(organizationInvitations.id, invite.id));
    return { failure: inviteFailure(422, "Unprocessable Entity", "Invitation has expired") };
  }
  return { ok: true };
}

function checkAcceptorEligibility(user: Acceptor, invite: InviteRow): { ok: true } | { failure: InviteFailure } {
  // Email convergence: invitation must match the acceptor's canonical email
  const acceptorEmail = normalizeEmail((user as unknown as Record<string, unknown>)["email"] as string | null | undefined ?? null);
  if (acceptorEmail === null || acceptorEmail !== invite.emailNormalized) {
    return { failure: inviteFailure(403, "Forbidden", "Invitation email does not match your account") };
  }
  if ((user as unknown as Record<string, unknown>)["isSuspended"] === true) {
    return { failure: inviteFailure(403, "Forbidden", "Suspended accounts cannot accept invitations") };
  }
  if (user.emailVerifiedAt === null || user.emailVerifiedAt === undefined) {
    return { failure: inviteFailure(403, "Forbidden", "Verify your email address before accepting an invitation") };
  }
  return { ok: true };
}

async function acceptWithExistingMembership(
  invite: InviteRow,
  existing: MembershipRow,
  user: Acceptor,
): Promise<{ invite: InviteRow } | { failure: InviteFailure }> {
  let activated = false;
  try {
    activated = await db.transaction(async (tx: unknown): Promise<boolean> => {
      const t = tx as typeof db;
      const claimed = await t.update(organizationInvitations).set({ status: "accepted", acceptedBy: user.id, updatedAt: Date.now() }).where(and(eq(organizationInvitations.id, invite.id), eq(organizationInvitations.status, "pending"))).returning();
      if (claimed.length === 0) return false;
      if (existing.status === "invited") {
        const activation = await t.update(organizationMemberships).set({ status: "active" }).where(and(eq(organizationMemberships.id, existing.id), eq(organizationMemberships.status, "invited"))).returning({ id: organizationMemberships.id });
        if (activation.length === 0) throw new InvitationActivationConflict();
      }
      return true;
    });
  } catch (error: unknown) {
    if (!(error instanceof InvitationActivationConflict)) throw error;
  }
  if (!activated) return { failure: inviteFailure(409, "Conflict", "Invitation is no longer pending") };
  const resultInvite = { ...invite, status: "accepted" as const, acceptedBy: user.id };
  await auditLog("accept", "organization-invitations", resultInvite.id, user.id, resultInvite.orgId, { email: resultInvite.email });
  if (existing.status === "invited") {
    await auditLog("update", "organization-memberships", existing.id, user.id, resultInvite.orgId, { status: "active", via: "invitation" });
    publish("authz.changed", { "user-id": user.id, "org-id": resultInvite.orgId });
  }
  return { invite: resultInvite };
}

async function acceptWithNewMembership(invite: InviteRow, user: Acceptor): Promise<void> {
  await db.transaction(async (tx: unknown): Promise<void> => {
    const t = tx as typeof db;
    const claim = await t.update(organizationInvitations).set({ status: "accepted", acceptedBy: user.id, updatedAt: Date.now() }).where(and(eq(organizationInvitations.id, invite.id), eq(organizationInvitations.status, "pending"))).returning();
    if (claim.length === 0) throw new Error("invitation no longer pending");
    await t.insert(organizationMemberships).values({ id: newResourceId("orgmem"), orgId: invite.orgId, userId: user.id, role: invite.role, status: "active" }).onConflictDoNothing();
    // Clear provisional if this invite resolves it
    if ((user as unknown as Record<string, unknown>)["isProvisional"] === true) {
      await t.update(users).set({ isProvisional: false }).where(eq(users.id, user.id));
    }
  });
}

async function finalizeNewAcceptance(invite: InviteRow, user: Acceptor, set: SetObj): Promise<unknown> {
  await auditLog("accept", "organization-invitations", invite.id, user.id, invite.orgId, { email: invite.email });
  await auditLog("create", "organization-memberships", invite.id, user.id, invite.orgId, { email: invite.email, role: invite.role, via: "invitation" });
  publish("authz.changed", { "user-id": user.id, "org-id": invite.orgId });
  const updated = await db.query.organizationInvitations.findFirst({ where: eq(organizationInvitations.id, invite.id) });
  if (updated === undefined) {
    const failure = inviteFailure(500, "Internal Server Error");
    (set as { status: number }).status = failure.status;
    return failure.body;
  }
  return { data: invitationResource(updated) };
}

export const organizationInvitationRoutes = new Elysia({ name: "organization-invitations" })
  .use(authPlugin)
  // List pending invitations for an org (admin/owner view)
  .get("/api/v2/organizations/:org_name/organization-invitations", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: Ctx): Promise<unknown> => {
    const org = await cachedOrgByName(params["org_name"] ?? "");
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rows = await db.query.organizationInvitations.findMany({ where: eq(organizationInvitations.orgId, org.id) });
    return { data: rows.map(invitationResource) };
  })
  // Create invitation - hashed token, email required, role optional
  .post("/api/v2/organizations/:org_name/organization-invitations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: Ctx): Promise<unknown> => {
    const org = await cachedOrgByName(params["org_name"] ?? "");
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      const failure = inviteFailure(404, "Not Found");
      (set as { status: number }).status = failure.status; return failure.body;
    }
    const parsed = parseInviteAttributes(body);
    if ("failure" in parsed) {
      (set as { status: number }).status = parsed.failure.status; return parsed.failure.body;
    }
    if (!(await checkInviteOwnerGrant(parsed.role, user, org.id, tokenOrgId))) {
      const failure = inviteFailure(404, "Not Found");
      (set as { status: number }).status = failure.status; return failure.body;
    }
    const conflicts = await checkInviteConflicts(org.id, parsed.email);
    if ("failure" in conflicts) {
      (set as { status: number }).status = conflicts.failure.status; return conflicts.failure.body;
    }
    const created = await insertInvitation(org.id, parsed.email, parsed.role, user?.id ?? null);
    if ("failure" in created) {
      (set as { status: number }).status = created.failure.status; return created.failure.body;
    }
    (set as { status: number }).status = 201;
    return { data: invitationResource(created.row), meta: { token: created.rawToken } };
  })
  .delete("/api/v2/organizations/:org_name/organization-invitations/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: Ctx): Promise<unknown> => {
    const org = await cachedOrgByName(params["org_name"] ?? "");
    const id = params["id"] ?? "";
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
    const rawToken = params["token"] ?? "";
    if (rawToken.trim() === "") {
      const failure = inviteFailure(422, "Unprocessable Entity", "Invitation token is required");
      (set as { status: number }).status = failure.status; return failure.body;
    }
    if (user === null || user === undefined) {
      const failure = inviteFailure(401, "Unauthorized");
      (set as { status: number }).status = failure.status; return failure.body;
    }
    const loaded = await loadInviteByToken(rawToken);
    if ("failure" in loaded) {
      (set as { status: number }).status = loaded.failure.status; return loaded.failure.body;
    }
    const acceptable = await checkInviteAcceptable(loaded.invite);
    if ("failure" in acceptable) {
      (set as { status: number }).status = acceptable.failure.status; return acceptable.failure.body;
    }
    const eligible = checkAcceptorEligibility(user, loaded.invite);
    if ("failure" in eligible) {
      (set as { status: number }).status = eligible.failure.status; return eligible.failure.body;
    }
    const existing = await db.query.organizationMemberships.findFirst({ where: and(eq(organizationMemberships.orgId, loaded.invite.orgId), eq(organizationMemberships.userId, user.id)) });
    if (existing !== undefined) {
      const accepted = await acceptWithExistingMembership(loaded.invite, existing, user);
      if ("failure" in accepted) {
        (set as { status: number }).status = accepted.failure.status; return accepted.failure.body;
      }
      (set as { status: number }).status = 200;
      return { data: invitationResource({ ...accepted.invite, status: "accepted", acceptedBy: user.id }) };
    }
    await acceptWithNewMembership(loaded.invite, user);
    return finalizeNewAcceptance(loaded.invite, user, set);
  });
