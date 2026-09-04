import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizationMemberships, organizations, stateVersions, users, workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { desc, eq } from "drizzle-orm";

// Issue #569: migrating an existing state file into an empty workspace must
// accept its serial as-is instead of demanding serial 1.
describe("state import accepts migrated serials (#569)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const userId = `usr-stimport-${suffix}`;
  const orgId = `org-stimport-${suffix}`;
  const orgName = `stimport-${suffix}`;
  const token = `token-stimport-${suffix}`;
  const wsId = `ws-stimport-${suffix}`;
  const lineage = `lineage-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const upload = (serial: unknown) => request(
    `/api/v2/workspaces/${wsId}/state-versions/upload`, "POST",
    { version: 4, serial, lineage, outputs: {}, resources: [] },
  );

  const latestSerial = async (): Promise<number | null> => {
    const row = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, wsId),
      orderBy: [desc(stateVersions.serial)],
      columns: { serial: true },
    });
    return row?.serial ?? null;
  };

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(workspaces).values([
      { id: wsId, name: `stimport-ws-${suffix}`, orgId, executionMode: "remote" },
    ]);
    const lockRes = await request(`/api/v2/workspaces/${wsId}/actions/lock`, "POST", {
      data: { attributes: { reason: "migration" } },
    });
    expect(lockRes.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, wsId)).catch((): void => {});
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.id, `tok-${suffix}`)).catch((): void => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, userId)).catch((): void => {});
  });

  it("accepts a migrated serial on an empty workspace and stores it", async () => {
    const res = await upload(45);
    expect(res.status).toBe(201);
    expect(await latestSerial()).toBe(45);
  });

  it("rejects a repeated serial once history exists", async () => {
    const res = await upload(45);
    expect([409, 422]).toContain(res.status);
  });

  it("accepts the next serial after a migrated import", async () => {
    const res = await upload(46);
    expect(res.status).toBe(201);
    expect(await latestSerial()).toBe(46);
  });

  it("rejects non-positive serials", async () => {
    const res = await upload(0);
    expect(res.status).toBe(422);
    const body = await res.json() as { errors?: { detail?: string }[] };
    expect(body.errors?.[0]?.detail).toContain("positive integer");
  });
});
