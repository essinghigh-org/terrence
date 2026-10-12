import { test, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, organizations, organizationMemberships, apiTokens, registryComponents } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

test("component reads remain tenant-private and filter authorization before pagination", async () => {
  const id = crypto.randomUUID();
  const privateOrg = `private-${id}`;
  const memberOrg = `member-${id}`;
  const token = `user-${id}`;
  await db.insert(users).values({ id, username: id, passwordHash: "fixture" });
  await db.insert(organizations).values([
    { id: privateOrg, name: privateOrg, globalModuleSharing: true },
    { id: memberOrg, name: memberOrg },
  ]);
  await db
    .insert(organizationMemberships)
    .values({ id, orgId: memberOrg, userId: id, role: "member", status: "active" });
  await db.insert(apiTokens).values({ id, userId: id, token: hashAuthenticationToken(token) });
  await db.insert(registryComponents).values([
    { id, orgId: memberOrg, name: "visible", sourceIdentifier: "visible", createdAt: 1 },
    ...Array.from({ length: 51 }, (_, index) => ({
      id: `${id}-${index}`,
      orgId: privateOrg,
      name: `private-${index}`,
      sourceIdentifier: "private",
      createdAt: Date.now(),
    })),
  ]);
  const get = (path: string, authenticated: boolean) =>
    app.handle(
      new Request(`http://localhost/api/registry/v1/components${path}`, {
        headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
      }),
    );
  try {
    expect((await (await get("", false)).json()).data).toEqual([]);
    const list = await get("", true);
    expect(list.status).toBe(200);
    expect((await list.json()).data.map((row: { id: string }) => row.id)).toEqual([id]);
    for (const authenticated of [false, true]) {
      for (const path of [`?organization=${privateOrg}`, `?organization=missing-${id}`, `/${id}-0`]) {
        expect((await get(path, authenticated)).status).toBe(404);
      }
    }
    expect((await get(`/${id}`, false)).status).toBe(404);
    expect((await get(`/${id}`, true)).status).toBe(200);
    expect((await get(`?organization=${memberOrg}`, true)).status).toBe(200);
  } finally {
    await db.delete(organizations).where(inArray(organizations.id, [privateOrg, memberOrg]));
    await db.delete(users).where(eq(users.id, id));
  }
});
