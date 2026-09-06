import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { runs, stateVersions, workspaces } from "../../src/db/schema";
import { storageDir } from "../../src/db/driver";
import {
  cleanupSeed,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedOrg,
} from "./compat_contract_helpers";

describe("recovery workbench (FEAT-18)", () => {
  const seed = seedOrg("recovery-workbench");
  const workspaceId = `workspace-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;
  const captureDir = join(storageDir, "recovery", runId);
  const headers = jsonHeaders(seed.token);

  const stateForSerial = (serial: number): string => JSON.stringify({
    version: 4,
    terraform_version: "1.9.3",
    serial,
    lineage: "recovery-workbench-lineage",
    outputs: { recovered: { value: serial, type: "number", sensitive: false } },
    resources: [],
  });

  async function writeCapture(serial: number): Promise<void> {
    await mkdir(captureDir, { recursive: true });
    await writeFile(join(captureDir, "terraform.tfstate"), stateForSerial(serial));
    await writeFile(join(captureDir, ".recovered"), new Date().toISOString());
    await rm(join(captureDir, ".evidence.json"), { force: true });
    await rm(join(captureDir, ".promoted"), { force: true });
  }

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({ id: workspaceId, name: "recovery-workbench", orgId: seed.orgId });
    await db.insert(runs).values({ id: runId, workspaceId, status: "errored", createdAt: Date.now() });
    expect((await request(`/api/v2/workspaces/${workspaceId}/actions/lock`, { method: "POST", headers })).status).toBe(200);
    const baseline = stateForSerial(1);
    await expectSuccessResponse(await request(`/api/v2/workspaces/${workspaceId}/state-versions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ data: { type: "state-versions", attributes: { serial: 1, state: baseline, md5: createHash("md5").update(baseline).digest("hex") } } }),
    }), 201, "state-versions");
  });

  afterAll(async () => {
    await rm(captureDir, { recursive: true, force: true });
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  it("returns bounded evidence and explicit promotion checks", async () => {
    await writeCapture(2);
    const response = await request(`/api/v2/runs/${runId}/recovery`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes["candidate-state"]).toMatchObject({ serial: 2, lineage: "recovery-workbench-lineage" });
    expect(body.data.attributes["last-committed-state"]).toMatchObject({ serial: 1 });
    expect(body.data.attributes["secret-warning"]).toBeTypeOf("string");
    expect((body.data.attributes["checks"] as unknown[]).map((check) => (check as Record<string, unknown>)["id"])).toContain("owner-terminated");
    expect(JSON.stringify(body)).not.toContain(stateForSerial(2));
  });

  it("blocks stale candidates before state promotion", async () => {
    await writeCapture(0);
    const response = await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers });
    expect(response.status).toBe(409);
    expect((await response.json()).errors[0].detail).toContain("stale");
  });

  it("blocks promotion while the interrupted owner is still active", async () => {
    await writeCapture(2);
    await db.update(runs).set({ status: "applying" }).where(eq(runs.id, runId));
    try {
      const response = await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers });
      expect(response.status).toBe(409);
      expect((await response.json()).errors[0].detail).toContain("still active");
    } finally {
      await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
    }
  });

  it("retains the capture and makes repeated promotion idempotent", async () => {
    await writeCapture(2);
    const first = await expectSuccessResponse(await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers }), 201, "state-versions");
    const downloaded = await request(`/api/v2/runs/${runId}/recovery-state`, { headers });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(stateForSerial(2));
    const evidence = JSON.parse(await readFile(join(captureDir, ".evidence.json"), "utf8")) as Record<string, unknown>;
    expect(evidence).toMatchObject({ status: "promoted", promotedStateVersionId: first.id, promotedSerial: 2 });
    expect(await Bun.file(join(captureDir, ".promoted")).exists()).toBe(true);

    const repeated = await request(`/api/v2/runs/${runId}/actions/recover-state`, { method: "POST", headers });
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).meta).toMatchObject({ idempotent: true, evidenceRetained: true });
  });
});
