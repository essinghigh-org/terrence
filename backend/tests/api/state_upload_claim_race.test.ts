import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  stateOutputIndex,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";

// State-version deferred-upload claim race (issue #578): two simultaneous
// PUTs against the same pending state-version must not both write. The
// per-version mutex gives the loser a fast 409 and the atomic conditional
// finalize is the backstop; the output index is rebuilt in the same
// transaction so it can never mix output names across writers.
describe("state-version deferred-upload claim race", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `svrace-org-${suffix}`;
  const auth = `user-token-${suffix}`;
  const workspaceId = `ws-svrace-${suffix}`;

  const request = (path: string, method = "GET", body?: BodyInit, headers: Record<string, string> = {}) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body ?? null,
    }));

  const statePayload = (tag: string): string => JSON.stringify({
    version: 4,
    terraform_version: "1.9.0",
    serial: 1,
    lineage: `lineage-${suffix}`,
    outputs: { [`out_${tag}`]: { value: tag, type: "string" } },
    resources: [],
  });

  const createPending = async (serial: number): Promise<string> => {
    const id = `sv-${suffix}-${serial}-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(stateVersions).values({ id, workspaceId, serial, status: "pending" });
    return id;
  };

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: hashAuthenticationToken(auth), userId });
    await db.insert(workspaces).values({ id: workspaceId, name: `svrace-${suffix}`, orgId });
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("only one of two simultaneous state uploads wins; the index matches the winner", async () => {
    const svId = await createPending(11);
    const [a, b] = await Promise.all([
      request(`/api/v2/state-versions/${svId}/upload`, "PUT", statePayload("a")),
      request(`/api/v2/state-versions/${svId}/upload`, "PUT", statePayload("b")),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, svId) });
    expect(row?.status).toBe("finalized");
    const winner = a.status === 200 ? "a" : "b";
    expect(row?.statePayload).not.toBeNull();

    const indexRows = await db.query.stateOutputIndex.findMany({ where: eq(stateOutputIndex.stateVersionId, svId) });
    expect(indexRows.map((indexRow) => indexRow.name).sort()).toEqual([`out_${winner}`]);
  });

  it("only one of two simultaneous json uploads wins", async () => {
    const svId = await createPending(12);
    const [a, b] = await Promise.all([
      request(`/api/v2/state-versions/${svId}/json-upload`, "PUT", JSON.stringify({ json: "a" })),
      request(`/api/v2/state-versions/${svId}/json-upload`, "PUT", JSON.stringify({ json: "b" })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("outputs upload is single-shot: second upload conflicts", async () => {
    const svId = await createPending(13);
    const first = await request(`/api/v2/state-versions/${svId}/json-outputs-upload`, "PUT", JSON.stringify({ x: 1 }));
    expect(first.status).toBe(200);
    const second = await request(`/api/v2/state-versions/${svId}/json-outputs-upload`, "PUT", JSON.stringify({ x: 2 }));
    expect(second.status).toBe(409);
  });

  it("outputs upload is rejected once the version is finalized", async () => {
    const svId = await createPending(14);
    const uploaded = await request(`/api/v2/state-versions/${svId}/upload`, "PUT", statePayload("final"));
    expect(uploaded.status).toBe(200);
    const outputs = await request(`/api/v2/state-versions/${svId}/json-outputs-upload`, "PUT", JSON.stringify({ x: 1 }));
    expect(outputs.status).toBe(409);
  });
});
