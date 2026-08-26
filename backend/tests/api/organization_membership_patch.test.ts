import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, users } from "../../src/db/schema";

/**
 * PATCH /api/v2/organization-memberships/:id — the activation path for
 * provisioned members and the owner promotion/demotion path. Before this
 * endpoint existed, an "invited" membership could never become active (no
 * accept flow, no update route), so invited users had a permanent dead-end.
 */
describe("organization membership PATCH", () => {
  const suffix = crypto.randomUUID();
  const orgId = `org-mempatch-${suffix}`;
  const orgName = `mempatch-${suffix}`;
  const ownerId = `usr-mempatch-owner-${suffix}`;
  const ownerToken = `token-mempatch-owner-${suffix}`;
  const ownerMemId = `orgmem-mempatch-owner-${suffix}`;
  const memberId = `usr-mempatch-member-${suffix}`;
  const memberToken = `token-mempatch-member-${suffix}`;
  const memberMemId = `orgmem-mempatch-member-${suffix}`;

  const request = (path: string, method: string, token: string, body?: unknown): Promise<Response> =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      { id: memberId, username: memberId, passwordHash: "$disabled$unused", isProvisional: true },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values([
      { id: ownerMemId, userId: ownerId, orgId, role: "owner" },
      // The exact shape the old invite form produced: existing user stuck invited.
      { id: memberMemId, userId: memberId, orgId, role: "member", status: "invited" },
    ]);
    await db.insert(apiTokens).values([
      { id: `token-row-o-${suffix}`, token: createHash("sha256").update(ownerToken).digest("hex"), userId: ownerId },
      { id: `token-row-m-${suffix}`, token: createHash("sha256").update(memberToken).digest("hex"), userId: memberId },
    ]);
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(inArray(apiTokens.id, [`token-row-o-${suffix}`, `token-row-m-${suffix}`]));
    await db.delete(users).where(inArray(users.id, [ownerId, memberId]));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("activates an invited membership (the provisioned-user dead end)", async () => {
    const res = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", ownerToken, {
      data: { type: "organization-memberships", attributes: { status: "active" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { attributes: { status: string } } };
    expect(body.data.attributes.status).toBe("active");
  });

  it("promotes to owner and enforces last-owner demotion protection", async () => {
    const promote = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", ownerToken, {
      data: { type: "organization-memberships", attributes: { role: "owner" } },
    });
    expect(promote.status).toBe(200);

    // Two owners now; demoting one must still work while >1 active owner exists.
    const demote = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", ownerToken, {
      data: { type: "organization-memberships", attributes: { role: "member" } },
    });
    expect(demote.status).toBe(200);

    // Promote the member to owner (two owners now), then demote the ORIGINAL
    // owner using the NEW owner's token — allowed with >1 active owner.
    await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", ownerToken, {
      data: { type: "organization-memberships", attributes: { role: "owner" } },
    });
    const demoteOriginal = await request(`/api/v2/organization-memberships/${ownerMemId}`, "PATCH", memberToken, {
      data: { type: "organization-memberships", attributes: { role: "member" } },
    });
    expect(demoteOriginal.status).toBe(200);

    // Only ONE active owner remains (the member); demoting them must be refused.
    const demoteLast = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", memberToken, {
      data: { type: "organization-memberships", attributes: { role: "member" } },
    });
    expect(demoteLast.status).toBe(422);
    const errBody = (await demoteLast.json()) as { errors?: { detail?: string }[] };
    expect(errBody.errors?.[0]?.detail).toContain("last active owner");

    // Restore the clean shape for later tests: promote the original owner
    // back FIRST (the current sole owner may do this), then step down. Order
    // matters — the last-owner guard would refuse stepping down first.
    const restoreOwner = await request(`/api/v2/organization-memberships/${ownerMemId}`, "PATCH", memberToken, {
      data: { type: "organization-memberships", attributes: { role: "owner" } },
    });
    expect(restoreOwner.status).toBe(200);
    const stepDown = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", memberToken, {
      data: { type: "organization-memberships", attributes: { role: "member" } },
    });
    expect(stepDown.status).toBe(200);
  });

  it("rejects invalid status and role values", async () => {
    const badStatus = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", ownerToken, {
      data: { type: "organization-memberships", attributes: { status: "bogus" } },
    });
    expect(badStatus.status).toBe(422);
    const badRole = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", ownerToken, {
      data: { type: "organization-memberships", attributes: { role: "superadmin" } },
    });
    expect(badRole.status).toBe(422);
  });

  it("returns 422 when no changes are requested", async () => {
    const empty = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", ownerToken, {
      data: { type: "organization-memberships", attributes: {} },
    });
    expect(empty.status).toBe(422);
  });

  it("hides the endpoint from non-managing callers (404, not 403)", async () => {
    const outsiderRes = await request(`/api/v2/organization-memberships/${memberMemId}`, "PATCH", memberToken, {
      data: { type: "organization-memberships", attributes: { role: "owner" } },
    });
    expect(outsiderRes.status).toBe(404);
  });
});
