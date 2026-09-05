import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, runs, teams, teamWorkspaces, workspaces } from "../../src/db/schema";
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

  const getJsonOutput = async (token: string, accept = "*/*"): Promise<Response> =>
    app.handle(new Request(`http://localhost/api/v2/plans/plan-${runId}/json-output`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
    }));

  const getRedactedJsonOutput = async (token: string, accept = "*/*"): Promise<Response> =>
    app.handle(new Request(`http://localhost/api/v2/plans/plan-${runId}/json-output-redacted`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
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
      values: { secret: "sensitive-value", secret_sensitive: true },
      resource_changes: [{ address: "terraform_data.example", type: "terraform_data", change: { actions: ["create"], before: null, after: {} } }],
    });
    const response = await getJsonOutput(seed.token, "application/json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json(?:;|$)/);
    const body = await response.json();
    expect((body as { terraform_version?: string }).terraform_version).toBe("1.9.8");
  });

  it("serves Terraform's redacted plan endpoint as sanitized JSON", async () => {
    await setRunStatus("planned");
    const response = await getRedactedJsonOutput(seed.token, "application/json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json(?:;|$)/);
    const body = await response.json() as { values?: { secret?: unknown } };
    expect(body.values?.secret).toBeNull();
  });

  it("serves the redacted artifact even while the run status is still incomplete", async () => {
    await setRunStatus("pending");
    const response = await getRedactedJsonOutput(seed.token, "application/json");
    expect(response.status).toBe(200);
    const body = await response.json() as { values?: { secret?: unknown } };
    expect(body.values?.secret).toBeNull();
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

  // Issue #577: raw plan JSON carries secrets in cleartext, so teams
  // without state access must not read it, while the redacted endpoint
  // stays available at read.
  describe("raw plan JSON requires the state-read class or admin", () => {
    const teamSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const readTeamId = `team-planjson-read-${teamSuffix}`;
    const noStateTeamId = `team-planjson-nostate-${teamSuffix}`;
    const adminTeamId = `team-planjson-admin-${teamSuffix}`;
    const readToken = `planjson-read-token-${teamSuffix}`;
    const noStateToken = `planjson-nostate-token-${teamSuffix}`;
    const adminToken = `planjson-admin-token-${teamSuffix}`;

    const teamGet = (token: string, redacted: boolean): Promise<Response> =>
      app.handle(new Request(
        `http://localhost/api/v2/plans/plan-${runId}/${redacted ? "json-output-redacted" : "json-output"}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      ));

    beforeAll(async () => {
      await db.insert(teams).values([
        { id: readTeamId, orgId: seed.orgId, name: `planjson-read-${teamSuffix}` },
        { id: noStateTeamId, orgId: seed.orgId, name: `planjson-nostate-${teamSuffix}` },
        { id: adminTeamId, orgId: seed.orgId, name: `planjson-admin-${teamSuffix}` },
      ]);
      await db.insert(teamWorkspaces).values([
        { id: `tw-planjson-read-${teamSuffix}`, teamId: readTeamId, workspaceId, access: "read" },
        {
          id: `tw-planjson-nostate-${teamSuffix}`, teamId: noStateTeamId, workspaceId,
          access: "custom",
          permissions: { runs: "read", variables: "none", "state-versions": "none" },
        },
        { id: `tw-planjson-admin-${teamSuffix}`, teamId: adminTeamId, workspaceId, access: "admin" },
      ]);
      await db.insert(apiTokens).values([
        { id: `tok-planjson-read-${teamSuffix}`, token: createHash("sha256").update(readToken).digest("hex"), teamId: readTeamId },
        { id: `tok-planjson-nostate-${teamSuffix}`, token: createHash("sha256").update(noStateToken).digest("hex"), teamId: noStateTeamId },
        { id: `tok-planjson-admin-${teamSuffix}`, token: createHash("sha256").update(adminToken).digest("hex"), teamId: adminTeamId },
      ]);
      await setRunStatus("planned");
      await writePlanJsonArtifact(runId, {
        format_version: "1.2",
        terraform_version: "1.9.8",
        values: { secret: "sensitive-value", secret_sensitive: true },
      });
    });

    afterAll(async () => {
      // Scope teardown to this suite's three teams (CodeRabbit P1-sweep
      // review): sibling suites share seed.orgId, so filtering by org or
      // workspace would delete their fixtures.
      const suiteTeamIds = [readTeamId, noStateTeamId, adminTeamId];
      await db.delete(apiTokens).where(eq(apiTokens.teamId, readTeamId)).catch((): void => {});
      await db.delete(apiTokens).where(eq(apiTokens.teamId, noStateTeamId)).catch((): void => {});
      await db.delete(apiTokens).where(eq(apiTokens.teamId, adminTeamId)).catch((): void => {});
      await db.delete(teamWorkspaces).where(inArray(teamWorkspaces.teamId, suiteTeamIds)).catch((): void => {});
      await db.delete(teams).where(inArray(teams.id, suiteTeamIds)).catch((): void => {});
    });

    it("serves raw plan JSON to read teams (read includes state-read)", async () => {
      expect((await teamGet(readToken, false)).status).toBe(200);
    });

    it("serves raw plan JSON to admin teams", async () => {
      expect((await teamGet(adminToken, false)).status).toBe(200);
    });

    it("hides raw plan JSON from teams without state access", async () => {
      expect((await teamGet(noStateToken, false)).status).toBe(404);
    });

    it("keeps the redacted endpoint available to teams without state access", async () => {
      const response = await teamGet(noStateToken, true);
      expect(response.status).toBe(200);
      const body = await response.json() as { values?: { secret?: unknown } };
      expect(body.values?.secret).toBeNull();
    });
  });
});
