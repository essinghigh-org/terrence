import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { runs, stateVersions, workspaces } from "../../src/db/schema";
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
  });

  const createStateVersion = async (
    serial: number,
    options: Readonly<{ runId?: string; state?: string }> = {},
  ): Promise<Response> => {
    const attributes: Record<string, unknown> = { serial };
    if (options.state !== undefined) {
      attributes["state"] = options.state;
      attributes["md5"] = createHash("md5").update(options.state).digest("base64");
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
});
