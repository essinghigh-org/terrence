import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  identityLinks,
  organizationInvitations,
  organizationMemberships,
  organizations,
  scimSettings,
  scimTokens,
  scimUserIdentities,
  users,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("organization invitation expiry", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-invite-expiry-${suffix}`;
  const orgName = `invite-expiry-${suffix}`;
  const ownerId = `user-invite-owner-${suffix}`;
  const ownerToken = `invite-owner-${suffix}`;
  const scimToken = `invite-scim-${suffix}`;
  const invitees = ["replacement", "pending", "scim-expired", "scim-live"].map((kind) => ({
    id: `user-invite-${kind}-${suffix}`,
    username: `invite-${kind}-${suffix}`,
    email: `invite-${kind}-${suffix}@example.test`,
    kind,
  }));
  const userIds = [ownerId, ...invitees.map((invitee) => invitee.id)];
  let previousScimSettings: typeof scimSettings.$inferSelect | undefined;

  function request(path: string, token: string, body: unknown, scim = false): Promise<Response> {
    return app.handle(
      new Request(`http://terrence.test${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": scim ? "application/scim+json" : "application/vnd.api+json",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  function invite(email: string): Promise<Response> {
    return request(`/api/v2/organizations/${orgName}/organization-invitations`, ownerToken, {
      data: { type: "organization-invitations", attributes: { email } },
    });
  }

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      ...invitees.map(({ id, username, email }) => ({
        id,
        username,
        email,
        passwordHash: "unused",
        emailVerifiedAt: Date.now(),
      })),
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `orgmem-invite-owner-${suffix}`,
      orgId,
      userId: ownerId,
      role: "owner",
    });
    await db
      .insert(apiTokens)
      .values([
        { id: `token-invite-owner-${suffix}`, token: hashAuthenticationToken(ownerToken), userId: ownerId },
        ...invitees.map(({ id }) => ({ id: `token-${id}`, token: hashAuthenticationToken(id), userId: id })),
      ]);
    previousScimSettings = await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") });
    const now = Date.now();
    await db
      .insert(scimSettings)
      .values({ id: "scim", enabled: true, paused: false, updatedAt: now })
      .onConflictDoUpdate({ target: scimSettings.id, set: { enabled: true, paused: false, updatedAt: now } });
    await db.insert(scimTokens).values({
      id: `scim-token-invite-${suffix}`,
      tokenHash: hashAuthenticationToken(scimToken),
      description: "invitation expiry regression",
      expiresAt: now + 86_400_000,
    });
  });

  afterAll(async () => {
    await db.delete(scimTokens).where(eq(scimTokens.id, `scim-token-invite-${suffix}`));
    await db.delete(identityLinks).where(inArray(identityLinks.userId, userIds));
    await db.delete(scimUserIdentities).where(inArray(scimUserIdentities.userId, userIds));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, userIds));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, userIds));
    if (previousScimSettings === undefined) {
      await db.delete(scimSettings).where(eq(scimSettings.id, "scim"));
    } else {
      await db.update(scimSettings).set(previousScimSettings).where(eq(scimSettings.id, previousScimSettings.id));
    }
  });

  it("replaces an expired pending invitation and only accepts the replacement token", async () => {
    const invitee = invitees.find(({ kind }) => kind === "replacement")!;
    const original = await invite(invitee.email);
    expect(original.status).toBe(201);
    const originalBody = await original.json();
    await db
      .update(organizationInvitations)
      .set({ expiresAt: Date.now() - 60_000 })
      .where(eq(organizationInvitations.id, originalBody.data.id));

    const replacement = await invite(invitee.email);
    expect(replacement.status).toBe(201);
    const replacementBody = await replacement.json();
    expect(replacementBody.data.id).not.toBe(originalBody.data.id);
    expect(
      (
        await db.query.organizationInvitations.findFirst({
          where: eq(organizationInvitations.id, originalBody.data.id),
        })
      )?.status,
    ).toBe("expired");
    const staleAccept = await request(
      `/api/v2/organization-invitations/${originalBody.meta.token}/accept`,
      invitee.id,
      {},
    );
    expect(staleAccept.status).toBe(422);
    const accept = await request(
      `/api/v2/organization-invitations/${replacementBody.meta.token}/accept`,
      invitee.id,
      {},
    );
    expect(accept.status).toBe(200);
    expect((await accept.json()).data.attributes.status).toBe("accepted");
  });

  it("still rejects a second unexpired invitation", async () => {
    const invitee = invitees.find(({ kind }) => kind === "pending")!;
    expect((await invite(invitee.email)).status).toBe(201);
    expect((await invite(invitee.email)).status).toBe(409);
  });

  for (const expired of [true, false]) {
    it(`SCIM provisioning ${expired ? "does not accept an expired" : "accepts a live"} invitation`, async () => {
      const invitee = invitees.find(({ kind }) => kind === (expired ? "scim-expired" : "scim-live"))!;
      const invitationId = `invitation-${invitee.id}`;
      await db.insert(organizationInvitations).values({
        id: invitationId,
        orgId,
        email: invitee.email,
        emailNormalized: invitee.email,
        tokenHash: hashAuthenticationToken(invitationId),
        expiresAt: Date.now() + (expired ? -60_000 : 60_000),
      });
      const provision = await request(
        "/scim/v2/Users",
        scimToken,
        { userName: invitee.username, emails: [{ value: invitee.email, primary: true }], active: true },
        true,
      );
      expect(provision.status).toBe(201);
      const membership = await db.query.organizationMemberships.findFirst({
        where: eq(organizationMemberships.userId, invitee.id),
      });
      const stored = await db.query.organizationInvitations.findFirst({
        where: eq(organizationInvitations.id, invitationId),
      });
      if (expired) {
        expect(membership).toBeUndefined();
        expect(stored?.status).not.toBe("accepted");
      } else {
        expect(membership?.status).toBe("active");
        expect(stored?.status).toBe("accepted");
      }
    });
  }
});
