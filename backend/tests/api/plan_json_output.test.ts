import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { runs, workspaces } from "../../src/db/schema";
import { deletePlanJsonArtifact, writePlanJsonArtifact } from "../../src/lib/plan-json";
import {
  cleanupSeed,
  persistSeed,
  seedOrg,
} from "./compat_contract_helpers";

/**
 * /api/v2/plans/:plan_id/json-output must follow the the reference format contract:
 * 204 while the plan is still running, 200 once the artifact exists, and
 * 404 when it will never exist (terminal run without plan JSON).
 */
describe("plan JSON output availability semantics", () => {
  const seed = seedOrg("planjson");
  const workspaceId = `ws-${seed.suffix}`;
  const runId = `run-${seed.suffix}`;

  beforeAll(async () => {
    await persistSeed(seed);
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "plan-json-ws",
      orgId: seed.orgId,
      autoApply: false,
      terraformVersion: "latest",
    });
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "pending",
      message: "plan json semantics",
      createdAt: Date.now(),
    });
  });

  afterAll(async () => {
    await deletePlanJsonArtifact(runId).catch((): void => {});
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await cleanupSeed(seed);
  });

  const getJsonOutput = async (token: string): Promise<Response> =>
    app.handle(new Request(`http://localhost/api/v2/plans/plan-${runId}/json-output`, {
      headers: { Authorization: `Bearer ${token}` },
    }));

  const setRunStatus = (status: string): Promise<unknown> =>
    db.update(runs).set({ status }).where(eq(runs.id, runId));

  it("returns 204 while the plan has not completed", async () => {
    await setRunStatus("pending");
    const response = await getJsonOutput(seed.token);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("returns 404 once the run is past planning without an artifact", async () => {
    await setRunStatus("planned");
    const response = await getJsonOutput(seed.token);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect((body as { errors?: { status?: string }[] }).errors?.[0]?.status).toBe("404");
  });

  it("returns the plan JSON once the artifact exists", async () => {
    await setRunStatus("planned");
    await writePlanJsonArtifact(runId, {
      format_version: "1.2",
      terraform_version: "1.9.8",
      resource_changes: [{ address: "terraform_data.example", type: "terraform_data", change: { actions: ["create"], before: null, after: {} } }],
    });
    const response = await getJsonOutput(seed.token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect((body as { terraform_version?: string }).terraform_version).toBe("1.9.8");
  });

  it("hides the artifact from users outside the organization", async () => {
    await setRunStatus("planned");
    const foreign = seedOrg("planjson-foreign");
    await persistSeed(foreign);
    try {
      const response = await getJsonOutput(foreign.token);
      expect(response.status).toBe(404);
    } finally {
      await cleanupSeed(foreign);
    }
  });
});
