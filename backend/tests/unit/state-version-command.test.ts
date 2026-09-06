import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, stateOutputIndex, stateVersions, workspaces } from "../../src/db/schema";
import { decodeStatePayload } from "../../src/lib/validation";
import { commitStateVersion } from "../../src/lib/commands/state-version";

const orgId = `command-org-${crypto.randomUUID()}`;
const workspaceId = `command-workspace-${crypto.randomUUID()}`;

function state(serial: number, lineage = "command-lineage"): string {
  return JSON.stringify({
    version: 4,
    serial,
    lineage,
    terraform_version: "1.9.0",
    resources: [],
    outputs: {
      answer: { value: 42, type: "number", sensitive: false },
    },
  });
}

describe("commitStateVersion", () => {
  beforeAll(async () => {
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId });
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("commits a reservation atomically and rebuilds its output index", async () => {
    const stateVersionId = `state-version-${crypto.randomUUID()}`;
    const rawState = state(1);
    await db.insert(stateVersions).values({
      id: stateVersionId,
      workspaceId,
      serial: 1,
      status: "pending",
      uploadExpiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });

    const result = await commitStateVersion({ stateVersionId, rawState });

    expect(result).toEqual({ kind: "committed", stateVersionId });
    const committed = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    expect(committed?.status).toBe("finalized");
    expect(committed?.uploadSha256).toBe(createHash("sha256").update(rawState).digest("hex"));
    expect(decodeStatePayload(committed?.statePayload ?? "")).toBe(rawState);
    expect(await db.select({ name: stateOutputIndex.name }).from(stateOutputIndex).where(eq(stateOutputIndex.stateVersionId, stateVersionId))).toEqual([
      { name: "answer" },
    ]);
  });

  it("treats an identical retry as already committed and rejects different bytes", async () => {
    const stateVersionId = `state-version-${crypto.randomUUID()}`;
    const rawState = state(2);
    await db.insert(stateVersions).values({
      id: stateVersionId,
      workspaceId,
      serial: 2,
      status: "pending",
      uploadExpiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    expect((await commitStateVersion({ stateVersionId, rawState })).kind).toBe("committed");

    expect(await commitStateVersion({ stateVersionId, rawState })).toEqual({ kind: "already-committed", stateVersionId });
    expect(await commitStateVersion({ stateVersionId, rawState: state(2, "other-lineage") })).toEqual({
      kind: "conflict",
      reason: "content-already-uploaded",
      detail: "State content was already uploaded",
    });
  });

  it("returns typed validation and lifecycle failures without changing the reservation", async () => {
    const malformedId = `state-version-${crypto.randomUUID()}`;
    await db.insert(stateVersions).values({
      id: malformedId,
      workspaceId,
      serial: 3,
      status: "pending",
      uploadExpiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    expect(await commitStateVersion({ stateVersionId: malformedId, rawState: "not-json" })).toEqual({
      kind: "invalid",
      reason: "state-payload",
      detail: "State content must be a valid plaintext Terraform/OpenTofu v4 state file",
    });
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, malformedId) }))?.status).toBe("pending");

    const expiredId = `state-version-${crypto.randomUUID()}`;
    await db.insert(stateVersions).values({
      id: expiredId,
      workspaceId,
      serial: 4,
      status: "pending",
      uploadExpiresAt: 1,
      createdAt: 1,
    });
    expect(await commitStateVersion({ stateVersionId: expiredId, rawState: state(4), now: 2 })).toEqual({
      kind: "conflict",
      reason: "reservation-obsolete",
      detail: "State upload reservation expired or its workspace lock changed",
    });
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, expiredId) }))?.status).toBe("pending");
  });
});
