import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../../src/db";
import { auditLogs, runs, stateVersions, workspaces } from "../../src/db/schema";
import {
  cleanupSeed,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedOrg,
} from "./compat_contract_helpers";

// Issues #690 (COR-03) and #703 (COR-04): the deferred-upload reservation
// lifecycle. Reservations bind serial, lineage and checksum at reserve time,
// record a SHA-256 artifact identity at finalize time, stay out of history
// listings while pending, and always leave the workspace recoverable through
// expiry, unlock or discard with an audit tombstone.
describe("state upload reservation lifecycle", () => {
  const seed = seedOrg("state-reservation");
  const workspaceId = `workspace-${seed.suffix}`;
  const importWorkspaceId = `workspace-import-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;
  const headers = jsonHeaders(seed.token);
  const lineage = "reservation-lineage";

  const stateForSerial = (serial: number, body = "resource"): string => JSON.stringify({
    version: 4,
    terraform_version: "1.5.0",
    serial,
    lineage,
    outputs: { sample: { value: body, type: "string" } },
    resources: [],
  });
  const sha256 = (raw: string): string => createHash("sha256").update(raw).digest("hex");

  const reserve = async (ws: string, serial: number, raw?: string): Promise<Response> => {
    const attributes: Record<string, unknown> = { serial, lineage };
    if (raw !== undefined) {
      attributes["state"] = raw;
      attributes["md5"] = createHash("md5").update(raw).digest("hex");
    }
    return request(`/api/v2/workspaces/${ws}/state-versions`, {
      method: "POST", headers, body: JSON.stringify({ data: { type: "state-versions", attributes } }),
    });
  };
  const put = async (id: string, body: string): Promise<Response> =>
    request(`/api/v2/state-versions/${id}/upload`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body,
    });

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: "state-reservation", orgId: seed.orgId });
    await db.insert(workspaces).values({ id: importWorkspaceId, name: "state-reservation-import", orgId: seed.orgId });
    await db.insert(runs).values({ id: runId, workspaceId, status: "planned", createdAt: Date.now() });
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${importWorkspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
  });

  afterAll(async () => {
    for (const ws of [workspaceId, importWorkspaceId]) {
      await db.delete(stateVersions).where(eq(stateVersions.workspaceId, ws));
      await db.delete(workspaces).where(eq(workspaces.id, ws));
    }
    await db.delete(runs).where(eq(runs.id, runId));
    await cleanupSeed(seed);
  });

  it("records the sha256 artifact identity on deferred, inline and import writes", async () => {
    const inlineRaw = stateForSerial(1);
    const inline = await expectSuccessResponse(await reserve(workspaceId, 1, inlineRaw), 201, "state-versions");
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, inline.id) }))?.uploadSha256).toBe(sha256(inlineRaw));

    const deferredRaw = stateForSerial(2);
    const deferred = await expectSuccessResponse(await reserve(workspaceId, 2), 201, "state-versions");
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, deferred.id) }))?.uploadSha256).toBeNull();
    expect((await put(deferred.id, deferredRaw)).status).toBe(200);
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, deferred.id) }))?.uploadSha256).toBe(sha256(deferredRaw));

    const importedRaw = stateForSerial(1);
    const imported = await request(`/api/v2/workspaces/${importWorkspaceId}/state-versions/upload`, {
      method: "POST", headers, body: importedRaw,
    });
    expect(imported.status).toBe(201);
    const importedId = (await imported.json()).data.id as string;
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, importedId) }))?.uploadSha256).toBe(sha256(importedRaw));
  });

  it("replays an identical upload from the stored digest, backfills legacy rows and rejects replacement bytes", async () => {
    const raw = stateForSerial(3);
    const reserved = await expectSuccessResponse(await reserve(workspaceId, 3), 201, "state-versions");
    expect((await put(reserved.id, raw)).status).toBe(200);

    // Legacy row simulation: the digest column did not exist at finalize time.
    await db.update(stateVersions).set({ uploadSha256: null }).where(eq(stateVersions.id, reserved.id));
    expect((await put(reserved.id, raw)).status).toBe(200);
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, reserved.id) }))?.uploadSha256).toBe(sha256(raw));

    expect((await put(reserved.id, `${raw} `)).status).toBe(409);
    expect((await put(reserved.id, stateForSerial(3, "different"))).status).toBe(409);
    const download = await request(`/api/v2/state-versions/${reserved.id}/download`, { headers });
    expect(await download.text()).toBe(raw);
    const serialThree = (await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId) }))
      .filter((row) => row.serial === 3 && row.status === "finalized");
    expect(serialThree).toHaveLength(1);
  });

  it("keeps pending reservations out of history listings but reachable for the uploader", async () => {
    const raw = stateForSerial(4);
    const reserved = await expectSuccessResponse(await reserve(workspaceId, 4), 201, "state-versions");
    for (const path of [`/api/v2/workspaces/${workspaceId}/state-versions`, `/api/v2/state-versions?filter[workspace][id]=${workspaceId}`]) {
      const listed = await request(path, { headers });
      expect(listed.status).toBe(200);
      const body = await listed.json() as { data: { id: string }[]; meta: { pagination: { "total-count": number } } };
      expect(body.data.map((entry) => entry.id)).not.toContain(reserved.id);
      expect(body.data.map((entry) => entry.id)).toHaveLength(body.meta.pagination["total-count"]);
    }
    expect((await request(`/api/v2/state-versions/${reserved.id}`, { headers })).status).toBe(200);
    expect((await put(reserved.id, raw)).status).toBe(200);
    const listed = await request(`/api/v2/workspaces/${workspaceId}/state-versions`, { headers });
    expect(((await listed.json()) as { data: { id: string }[] }).data.map((entry) => entry.id)).toContain(reserved.id);
  });

  it("recovers a killed client through unlock and re-reserve without moving the current serial", async () => {
    const raw = stateForSerial(5);
    const abandoned = await expectSuccessResponse(await reserve(workspaceId, 5), 201, "state-versions");
    // The client dies here: no PUT ever arrives for the reservation.
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/unlock`, { method: "POST", headers })).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
    const tombstone = await db.query.auditLogs.findFirst({ where: eq(auditLogs.resourceId, abandoned.id) });
    expect(tombstone?.details).toMatchObject({ workspaceId, serial: 5, reason: "lock-changed" });

    const retry = await expectSuccessResponse(await reserve(workspaceId, 5), 201, "state-versions");
    expect(retry.id).not.toBe(abandoned.id);
    expect((await put(retry.id, raw)).status).toBe(200);
    const finalized = await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId) });
    expect(finalized.filter((row) => row.serial === 5 && row.status === "finalized")).toHaveLength(1);
    const current = await request(`/api/v2/workspaces/${workspaceId}/current-state-version`, { headers });
    expect(((await current.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes["serial"]).toBe(5);
  });

  it("rejects a PUT that arrives after expiry and lets the serial be reserved fresh", async () => {
    const raw = stateForSerial(6);
    const stale = await expectSuccessResponse(await reserve(workspaceId, 6), 201, "state-versions");
    await db.update(stateVersions).set({ uploadExpiresAt: Date.now() - 1 }).where(eq(stateVersions.id, stale.id));
    expect((await put(stale.id, raw)).status).toBe(409);
    const fresh = await expectSuccessResponse(await reserve(workspaceId, 6), 201, "state-versions");
    expect((await put(fresh.id, raw)).status).toBe(200);
    expect((await put(stale.id, raw)).status).toBe(404);
    const latest = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspaceId), orderBy: [desc(stateVersions.serial)],
    });
    expect(latest?.serial).toBe(6);
    expect(latest?.status).toBe("finalized");
  });
});
