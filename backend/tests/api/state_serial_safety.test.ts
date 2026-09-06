import { buildStateSummary } from "../../src/lib/state-summary";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../../src/db";
import { auditLogs, runs, stateOutputIndex, stateVersions, workspaces } from "../../src/db/schema";
import { stateOutputIndexRows } from "../../src/lib/state-output-index";
import {
  cleanupSeed,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedOrg,
} from "./compat_contract_helpers";

describe("state-version serial safety", () => {
  const seed = seedOrg("state-serial-safety");
  const workspaceId = `workspace-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;
  const headers = jsonHeaders(seed.token);

  const stateForSerial = (serial: number): string => JSON.stringify({
    version: 4,
    serial,
    lineage: "serial-safety-lineage",
    resources: [],
    outputs: { restored: { value: serial, type: "number", sensitive: false } },
    large_number: "9007199254740993",
  }).replace('"9007199254740993"', "9007199254740993");

  const createStateVersion = async (
    serial: number,
    options: Readonly<{ runId?: string; state?: string }> = {},
  ): Promise<Response> => {
    const attributes: Record<string, unknown> = { serial };
    if (options.state !== undefined) {
      attributes["state"] = options.state;
      attributes["md5"] = createHash("md5").update(options.state).digest("hex").toUpperCase();
    }
    const data: Record<string, unknown> = { type: "state-versions", attributes };
    if (options.runId !== undefined) {
      data["relationships"] = { run: { data: { type: "runs", id: options.runId } } };
    }
    return request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data }),
    });
  };

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: "state-serial", orgId: seed.orgId });
    await db.insert(runs).values({ id: runId, workspaceId, status: "planned", createdAt: Date.now() });
    const lock = await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers });
    expect(lock.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("rejects a lower serial even when a run relationship is supplied", async () => {
    const initial = stateForSerial(1);
    expect((await expectSuccessResponse(await createStateVersion(1, { state: initial }), 201, "state-versions")).attributes["serial"]).toBe(1);

    const stale = await createStateVersion(0, { runId });
    expect(stale.status).toBe(409);
    expect((await stale.json()).errors[0].detail).toContain("serial must advance");
  });

  it("maps a duplicate serial hidden by a pending row to 409", async () => {
    expect((await expectSuccessResponse(await createStateVersion(2), 201, "state-versions")).attributes["serial"]).toBe(2);

    const duplicate = await createStateVersion(2, { runId });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).errors[0].detail).toContain("serial must advance");
  });

  it("rejects invalid inline envelopes and unsafe reservation serials without advancing history", async () => {
    for (const serial of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await createStateVersion(serial)).status).toBe(422);
    }
    for (const state of ['{"foo":"bar"}', '{"version":4,"serial":3,"resources":[]}', '[]']) {
      expect((await createStateVersion(3, { state })).status).toBe(400);
    }
    expect(await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [stateVersions.id] })).toHaveLength(2);
  });

  it("binds deferred upload bytes to the reserved serial", async () => {
    const pending = await createStateVersion(3);
    const id = (await pending.json()).data.id;
    const upload = await request(`/api/v2/state-versions/${id}/upload`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: stateForSerial(4),
    });
    expect(upload.status).toBe(422);
    expect((await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) }))?.status).toBe("pending");
  });

  it("both rollback routes keep row serial, raw bytes and derived state consistent", async () => {
    const source = (await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [stateVersions.id] })).find((row) => row.serial === 1)!;
    for (const path of [`/api/v2/state-versions/${source.id}/actions/rollback`, `/api/v2/workspaces/${workspaceId}/state-versions`]) {
      const response = await request(path, {
        method: path.endsWith("/rollback") ? "POST" : "PATCH", headers,
        body: JSON.stringify({ data: { relationships: { "rollback-state-version": { data: { id: source.id, type: "state-versions" } } } } }),
      });
      expect(response.status).toBe(201);
      const resource = (await response.json()).data;
      const downloaded = await request(`/api/v2/state-versions/${resource.id}/download`, { headers });
      const downloadedText = await downloaded.text();
      expect(downloadedText).toContain('"large_number":9007199254740993');
      const committed = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, resource.id) });
      expect(JSON.parse(committed!.stateSummary!)).toEqual(buildStateSummary(downloadedText));
      expect(committed!.uploadSha256).toBe(buildStateSummary(downloadedText).digest);
      const index = await db.query.stateOutputIndex.findMany({ where: eq(stateOutputIndex.stateVersionId, resource.id) });
      expect(index.map(({ createdAt: _, ...row }) => row)).toEqual(stateOutputIndexRows(resource.id, workspaceId, null, downloadedText).map(({ createdAt: _, ...row }) => row));
      const raw = JSON.parse(downloadedText);
      expect(raw.serial).toBe(resource.attributes.serial);
      expect(raw.serial).toBeGreaterThan(3);
      expect(raw.lineage).toBe("serial-safety-lineage");
      const json = await request(`/api/v2/state-versions/${resource.id}/json-download`, { headers });
      expect((await json.json()).serial).toBe(raw.serial);
    }
  });


  it("rejects checksum and lineage substitutions then accepts the originally reserved bytes", async () => {
    const raw = stateForSerial(6);
    const reserve = await request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
      method: "POST", headers,
      body: JSON.stringify({ data: { type: "state-versions", attributes: { serial: 6, lineage: "serial-safety-lineage", md5: createHash("md5").update(raw).digest("hex") } } }),
    });
    expect(reserve.status).toBe(201);
    const id = (await reserve.json()).data.id;
    for (const body of [raw + " ", raw.replace("serial-safety-lineage", "wrong-lineage"), raw]) {
      const response = await request(`/api/v2/state-versions/${id}/upload`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body });
      expect(response.status).toBe(body === raw ? 200 : 422);
    }
    const committed = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) });
    expect((await request(`/api/v2/state-versions/${id}/upload`, { method: "PUT", headers, body: raw })).status).toBe(200);
    expect((await request(`/api/v2/state-versions/${id}/upload`, { method: "PUT", headers, body: raw + " " })).status).toBe(409);
    expect(await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) })).toEqual(committed);
  });


  it("recovery promotes the captured bytes to the new serial", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { storageDir } = await import("../../src/db/driver");
    const capture = join(storageDir, "recovery", runId);
    await mkdir(capture, { recursive: true });
    // Recovery candidates must not be stale relative to the committed state;
    // the promotion itself assigns the next serial.
    await writeFile(join(capture, "terraform.tfstate"), stateForSerial(6));
    await writeFile(join(capture, ".recovered"), "complete");
    const response = await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers });
    expect(response.status).toBe(201);
    const resource = (await response.json()).data;
    expect(resource.attributes.serial).toBe(7);
    const download = await request(`/api/v2/state-versions/${resource.id}/download`, { headers });
    const text = await download.text();
    const committed = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, resource.id) });
    expect(JSON.parse(committed!.stateSummary!)).toEqual(buildStateSummary(text));
    expect(committed!.uploadSha256).toBe(buildStateSummary(text).digest);
    const index = await db.query.stateOutputIndex.findMany({ where: eq(stateOutputIndex.stateVersionId, resource.id) });
    expect(index.map(({ createdAt: _, ...row }) => row)).toEqual(stateOutputIndexRows(resource.id, workspaceId, null, text).map(({ createdAt: _, ...row }) => row));
    expect(JSON.parse(text).serial).toBe(7);
    expect(text).toContain('"large_number":9007199254740993');
  });

  it("expires pending uploads and reuses the serial without changing committed state", async () => {
    const old = await expectSuccessResponse(await createStateVersion(8), 201, "state-versions");
    await db.update(stateVersions).set({ uploadExpiresAt: Date.now() - 1 }).where(eq(stateVersions.id, old.id));
    for (const endpoint of ["upload", "json-upload", "json-outputs-upload"]) {
      expect((await request(`/api/v2/state-versions/${old.id}/${endpoint}`, { method: "PUT", headers, body: stateForSerial(8) })).status).toBe(409);
    }
    const replacement = await expectSuccessResponse(await createStateVersion(8), 201, "state-versions");
    expect(replacement.id).not.toBe(old.id);
    expect((await request(`/api/v2/state-versions/${old.id}/upload`, { method: "PUT", headers, body: stateForSerial(8) })).status).toBe(404);
    expect((await request(`/api/v2/state-versions/${replacement.id}/upload`, { method: "PUT", headers, body: stateForSerial(8) })).status).toBe(200);
  });

  it("unlock abandons only pending reservations and old signed URLs cannot cross a lock handoff", async () => {
    const pending = await expectSuccessResponse(await createStateVersion(9), 201, "state-versions");
    const oldUrl = pending.attributes["hosted-state-upload-url"] as string;
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/unlock`, { method: "POST", headers })).status).toBe(200);
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
    expect((await request(oldUrl, { method: "PUT", body: stateForSerial(9) })).status).toBe(404);
    expect((await createStateVersion(9, { state: stateForSerial(9) })).status).toBe(201);
    const existing = await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [stateVersions.id] });
    expect(existing.some((row) => row.serial === 8 && row.status === "finalized")).toBe(true);
  });

  it("discard frees a pending serial and retains an audit tombstone", async () => {
    const pending = await expectSuccessResponse(await createStateVersion(10), 201, "state-versions");
    expect((await request(`/api/v2/state-versions/${pending.id}`, { method: "DELETE", headers })).status).toBe(204);
    const audit = await db.query.auditLogs.findFirst({ where: eq(auditLogs.resourceId, pending.id), orderBy: [desc(auditLogs.createdAt), desc(auditLogs.id)] });
    expect(audit?.details).toMatchObject({ workspaceId, serial: 10, reason: "discarded" });
    expect((await createStateVersion(10, { state: stateForSerial(10) })).status).toBe(201);
  });

  it("rejects a signed PUT when lock metadata changed before finalization", async () => {
    const pending = await expectSuccessResponse(await createStateVersion(11), 201, "state-versions");
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    await db.update(workspaces).set({ lockedAt: (workspace?.lockedAt ?? Date.now()) + 1 }).where(eq(workspaces.id, workspaceId));
    const oldUrl = pending.attributes["hosted-state-upload-url"] as string;
    expect((await request(oldUrl, { method: "PUT", body: stateForSerial(11) })).status).toBe(409);
    expect((await createStateVersion(11, { state: stateForSerial(11) })).status).toBe(201);
    const audit = await db.query.auditLogs.findFirst({ where: eq(auditLogs.resourceId, pending.id), orderBy: [desc(auditLogs.createdAt), desc(auditLogs.id)] });
    expect(audit?.details).toMatchObject({ workspaceId, serial: 11, reason: "lock-changed" });
  });

  it("prunes expired reservations before each rollback and recovery serial allocation", async () => {
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { storageDir } = await import("../../src/db/driver");
    const source = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [stateVersions.serial] });
    for (const mode of ["workspace", "version", "recovery"]) {
      const latest = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [desc(stateVersions.serial)] });
      const next = latest!.serial + 1;
      const pending = await expectSuccessResponse(await createStateVersion(next), 201, "state-versions");
      await db.update(stateVersions).set({ uploadExpiresAt: Date.now() - 1 }).where(eq(stateVersions.id, pending.id));
      const capture = join(storageDir, "recovery", runId);
      if (mode === "recovery") {
        await rm(capture, { recursive: true, force: true });
        await mkdir(capture, { recursive: true });
        await writeFile(join(capture, "terraform.tfstate"), stateForSerial(next));
        await writeFile(join(capture, ".recovered"), "complete");
      }
      const response = await request(mode === "workspace" ? `/api/v2/workspaces/${workspaceId}/state-versions` : mode === "version" ? `/api/v2/state-versions/${source!.id}/actions/rollback` : `/api/v2/runs/${runId}/actions/recover-state`, {
        method: mode === "workspace" ? "PATCH" : "POST", headers,
        ...(mode === "workspace" ? { body: JSON.stringify({ data: { relationships: { "rollback-state-version": { data: { id: source!.id } } } } }) } : {}),
      });
      expect(response.status).toBe(201);
      expect((await response.json()).data.attributes.serial).toBe(next);
      expect(await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, pending.id) })).toBeUndefined();
      expect((await db.query.auditLogs.findFirst({ where: eq(auditLogs.resourceId, pending.id), orderBy: [desc(auditLogs.createdAt), desc(auditLogs.id)] }))?.details).toMatchObject({ reason: "upload-expired" });
    }
  });

  it("rejects every promotion if lock ownership changes after authorization", async () => {
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { storageDir } = await import("../../src/db/driver");
    const source = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [stateVersions.serial] });
    for (const mode of ["workspace", "version", "recovery"]) {
      const before = await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [stateVersions.id] });
      const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
      const capture = join(storageDir, "recovery", runId);
      if (mode === "recovery") {
        await rm(capture, { recursive: true, force: true });
        await mkdir(capture, { recursive: true });
        const latest = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [desc(stateVersions.serial)] });
        await writeFile(join(capture, "terraform.tfstate"), stateForSerial((latest?.serial ?? 0) + 1));
        await writeFile(join(capture, ".recovered"), "complete");
      }
      const transaction = db.transaction.bind(db);
      // Promotion routes await transactions on both database drivers.
      const handoff = spyOn(db, "transaction").mockImplementationOnce((async (callback, ...options) => {
        await db.update(workspaces).set({ lockedAt: workspace!.lockedAt! + 1 }).where(eq(workspaces.id, workspaceId));
        return transaction(callback, ...options);
      }) as typeof db.transaction);
      try {
        const response = await request(mode === "workspace" ? `/api/v2/workspaces/${workspaceId}/state-versions` : mode === "version" ? `/api/v2/state-versions/${source!.id}/actions/rollback` : `/api/v2/runs/${runId}/actions/recover-state`, {
          method: mode === "workspace" ? "PATCH" : "POST", headers,
          ...(mode === "workspace" ? { body: JSON.stringify({ data: { relationships: { "rollback-state-version": { data: { id: source!.id } } } } }) } : {}),
        });
        expect(response.status).toBe(409);
        expect((await response.json()).errors[0].detail).toContain("before promotion");
        expect(await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [stateVersions.id] })).toEqual(before);
        if (mode === "recovery") expect(await Bun.file(join(capture, "terraform.tfstate")).exists()).toBe(true);
      } finally { handoff.mockRestore(); }
    }
  });

});
