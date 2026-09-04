import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { apiTokens, organizationMemberships, organizations, stackRecords, stacks, users } from "../../src/db/schema";

const suffix = crypto.randomUUID();
const userId = `stack-state-user-${suffix}`;
const orgId = `stack-state-org-${suffix}`;
const stackId = `stack-state-stack-${suffix}`;
const token = `stack-state-token-${suffix}`;
const legacyStateId = `sst-legacy-${suffix}`;
const currentStateId = `sst-current-${suffix}`;
const stackStorageDir = join(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"), "stacks");
const descriptionDir = join(stackStorageDir, "api-history", suffix);
const legacyDescriptionPath = join(descriptionDir, "legacy.tfstate");
const currentDescriptionPath = join(descriptionDir, "current.tfstate");

function request(path: string): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

describe("Stack state history API", () => {
  beforeAll(async () => {
    const now = Date.now();
    await mkdir(descriptionDir, { recursive: true, mode: 0o700 });
    await writeFile(legacyDescriptionPath, JSON.stringify({ serial: 1 }), { mode: 0o600 });
    await writeFile(currentDescriptionPath, JSON.stringify({ serial: 2 }), { mode: 0o600 });
    await db.insert(users).values({ id: userId, username: `stack-state-user-${suffix}@test`, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: `stack-state-org-${suffix}` });
    await db.insert(organizationMemberships).values({ id: `stack-state-membership-${suffix}`, userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: `stack-state-token-row-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(stacks).values({ id: stackId, orgId, projectId: null, executionMode: "remote", name: "stack-state-history", createdAt: now, updatedAt: now });
    await db.insert(stackRecords).values([
      {
        id: legacyStateId,
        stackId,
        parentId: null,
        recordType: "stack-states",
        name: "default",
        status: "current",
        payload: { generation: 1, "is-current": false, descriptionPath: legacyDescriptionPath, components: [] },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: currentStateId,
        stackId,
        parentId: null,
        recordType: "stack-states",
        name: "default",
        status: "current",
        payload: { generation: 2, "is-current": true, descriptionPath: currentDescriptionPath, components: [] },
        createdAt: now + 1,
        updatedAt: now + 1,
      },
    ]);
  });

  afterAll(async () => {
    await rm(descriptionDir, { recursive: true, force: true });
    await db.delete(stackRecords).where(inArray(stackRecords.id, [legacyStateId, currentStateId]));
    await db.delete(stacks).where(eq(stacks.id, stackId));
    await db.delete(apiTokens).where(eq(apiTokens.token, hashAuthenticationToken(token)));
    await db.delete(organizationMemberships).where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.orgId, orgId)));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("normalizes legacy state status/current fields in the list resource", async () => {
    const response = await request(`/api/v2/stacks/${stackId}/stack-states`);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { id: string; attributes: { status: string; "is-current": boolean } }[] };
    expect(body.data).toHaveLength(2);
    const legacy = body.data.find((resource) => resource.id === legacyStateId);
    const current = body.data.find((resource) => resource.id === currentStateId);
    expect(legacy?.attributes.status).toBe("superseded");
    expect(legacy?.attributes["is-current"]).toBe(false);
    expect(current?.attributes.status).toBe("current");
    expect(current?.attributes["is-current"]).toBe(true);
    expect(body.data.filter((resource) => resource.attributes["is-current"])).toHaveLength(1);
  });

  test("uses the same normalized fields for a historical detail resource", async () => {
    const response = await request(`/api/v2/stack-states/${legacyStateId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { attributes: { status: string; "is-current": boolean } } };
    expect(body.data.attributes.status).toBe("superseded");
    expect(body.data.attributes["is-current"]).toBe(false);
  });

  test("downloads the immutable payload for each state generation", async () => {
    const historicalResponse = await request(`/api/v2/stack-states/${legacyStateId}/description/download`);
    expect(historicalResponse.status).toBe(200);
    expect((await historicalResponse.json() as { serial: number }).serial).toBe(1);

    const currentResponse = await request(`/api/v2/stack-states/${currentStateId}/description/download`);
    expect(currentResponse.status).toBe(200);
    expect((await currentResponse.json() as { serial: number }).serial).toBe(2);
  });
});
