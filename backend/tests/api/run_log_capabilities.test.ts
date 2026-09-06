import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { apiTokens, auditLogs, logs, organizationMemberships, runs, teams, teamWorkspaces, users, workspaces } from "../../src/db/schema";
import { archiveRunLogs, deleteRunLogArchive } from "../../src/lib/run-logs";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { cleanupSeed, expectSuccessResponse, jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";

const seed = seedOrg("log-capability");
const workspaceId = `ws-${seed.suffix}`;
const runId = `run-${seed.suffix}`;
const otherRunId = `other-${seed.suffix}`;
const teamId = `team-${seed.suffix}`;
const teamToken = `reader-${seed.suffix}`;
const logToken = crypto.randomUUID();
const owner = jsonHeaders(seed.token);
const reader = jsonHeaders(teamToken);
const canary = "SYNTHETIC_LOG_CANARY";
const link = async (phase: "plan" | "apply", headers = owner): Promise<string> => {
  const type = phase === "plan" ? "plans" : "applies";
  const resource = await expectSuccessResponse(await request(`/api/v2/${type}/${phase}-${runId}`, { headers }), 200, type);
  return resource.attributes["log-read-url"] as string;
};

beforeAll(async () => {
  await persistSeed(seed);
  await db.insert(workspaces).values({ id: workspaceId, orgId: seed.orgId, name: "log-capability" });
  await db.insert(runs).values([runId, otherRunId].map((id) => ({ id, workspaceId, status: "applying", logToken, createdAt: Date.now() })));
  await db.insert(logs).values(["plan", "apply"].map((phase) => ({ id: crypto.randomUUID(), runId, phase, outputText: canary, createdAt: Date.now() })));
  await db.insert(teams).values({ id: teamId, orgId: seed.orgId, name: "reader" });
  await db.insert(teamWorkspaces).values({ id: `tw-${seed.suffix}`, teamId, workspaceId, access: "read" });
  await db.insert(apiTokens).values({ id: `tk-${seed.suffix}`, teamId, token: hashAuthenticationToken(teamToken) });
});

afterAll(async () => {
  await deleteRunLogArchive(runId);
  await db.delete(apiTokens).where(eq(apiTokens.teamId, teamId));
  await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, teamId));
  await db.delete(teams).where(eq(teams.id, teamId));
  await db.delete(logs).where(eq(logs.runId, runId));
  await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await cleanupSeed(seed);
});

test("phase/run-bound links survive go-tfe query replacement and long polling, then expire", async () => {
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const previousTtl = process.env["LOG_CAPABILITY_TTL_SECONDS"];
  delete process.env["LOG_CAPABILITY_TTL_SECONDS"];
  try {
    for (const phase of ["plan", "apply"] as const) {
      const issued = await link(phase);
      expect(issued).not.toContain(logToken);
      const url = new URL(issued);
      url.search = "offset=0&limit=256"; // go-tfe discards any original query.
      for (const status of ["pending", "applying", "applied"]) {
        await db.update(runs).set({ status }).where(eq(runs.id, runId));
        clock.mockReturnValue(now + 25 * 3600_000);
        const response = await request(url.toString());
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(canary);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      }
      expect((await request(issued.replace(`/${phase}/log/`, phase === "plan" ? "/apply/log/" : "/plan/log/"))).status).toBe(404);
      expect((await request(issued.replace(runId, otherRunId))).status).toBe(404);
      expect((await request(issued + "0")).status).toBe(404);
      // Old URLs disclosed logToken. It must never become the signing secret.
      const forgedExpiry = Math.floor(now / 1000) + 999999;
      const forgedSignature = createHmac("sha256", logToken).update(`${runId}\n${phase}\n${forgedExpiry}`).digest("hex");
      expect((await request(`/api/v2/runs/${runId}/${phase}/log/${forgedExpiry}.${forgedSignature}`)).status).toBe(404);
      expect((await request(`/api/v2/runs/${runId}/${phase}/log/${logToken}`)).status).toBe(404);
      clock.mockReturnValue(now + 49 * 3600_000);
      expect((await request(issued)).status).toBe(404);
      expect((await request(await link(phase))).status).toBe(200);
      clock.mockReturnValue(now);
    }
  } finally {
    clock.mockRestore();
    if (previousTtl === undefined) delete process.env["LOG_CAPABILITY_TTL_SECONDS"];
    else process.env["LOG_CAPABILITY_TTL_SECONDS"] = previousTtl;
  }
});

test("only an administrator can revoke; removed readers cannot renew; rotation invalidates both phases", async () => {
  const plan = await link("plan", reader);
  const apply = await link("apply", reader);
  const revoke = `/api/v2/runs/${runId}/actions/revoke-log-links`;
  for (const headers of [{}, reader]) expect((await request(revoke, { method: "POST", headers })).status).toBe(404);
  await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, teamId));
  expect((await request(`/api/v2/plans/plan-${runId}`, { headers: reader })).status).toBe(404);
  // Deliberate bearer contract: losing team-workspace access alone does not
  // revoke an already issued link (organization membership removal does —
  // see the next test).
  expect((await request(plan)).status).toBe(200);
  expect((await request(revoke, { method: "POST", headers: owner })).status).toBe(204);
  expect((await request(plan)).status).toBe(404);
  expect((await request(apply)).status).toBe(404);
  expect((await request(await link("plan"))).status).toBe(200);
  expect((await request(await link("apply"))).status).toBe(200);
  expect(await db.query.auditLogs.findFirst({ where: eq(auditLogs.resourceId, runId) })).toBeDefined();
});

test("removing an organization membership immediately invalidates issued links (issue #699)", async () => {
  const targetRunId = `rot-${seed.suffix}`;
  await db.insert(runs).values({ id: targetRunId, workspaceId, status: "applying", logToken: crypto.randomUUID(), createdAt: Date.now() });
  await db.insert(logs).values({ id: crypto.randomUUID(), runId: targetRunId, phase: "plan", outputText: canary, createdAt: Date.now() });
  try {
    const leaverId = `leaver-${seed.suffix}`;
    const leaverMemId = `leaver-mem-${seed.suffix}`;
    await db.insert(users).values({ id: leaverId, username: `leaver-${seed.suffix}`, passwordHash: "unused" });
    await db.insert(organizationMemberships).values({ id: leaverMemId, userId: leaverId, orgId: seed.orgId, role: "member" });

    const resource = await expectSuccessResponse(await request(`/api/v2/plans/plan-${targetRunId}`, { headers: owner }), 200, "plans");
    const before = resource.attributes["log-read-url"] as string;
    expect((await request(before)).status).toBe(200);

    const removed = await request(`/api/v2/organization-memberships/${leaverMemId}`, { method: "DELETE", headers: owner });
    expect(removed.status).toBe(204);
    // The removed member's captured link dies with the rotation, while the
    // remaining owner fetches a fresh working link (active polling survives).
    expect((await request(before)).status).toBe(404);
    const fresh = await expectSuccessResponse(await request(`/api/v2/plans/plan-${targetRunId}`, { headers: owner }), 200, "plans");
    expect((await request(fresh.attributes["log-read-url"] as string)).status).toBe(200);
  } finally {
    await db.delete(logs).where(eq(logs.runId, targetRunId));
    await db.delete(runs).where(eq(runs.id, targetRunId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, `leaver-${seed.suffix}`));
    await db.delete(users).where(eq(users.id, `leaver-${seed.suffix}`));
  }
});

test("demoting a membership from active also invalidates issued links (issue #699)", async () => {
  const targetRunId = `dem-${seed.suffix}`;
  await db.insert(runs).values({ id: targetRunId, workspaceId, status: "applying", logToken: crypto.randomUUID(), createdAt: Date.now() });
  await db.insert(logs).values({ id: crypto.randomUUID(), runId: targetRunId, phase: "plan", outputText: canary, createdAt: Date.now() });
  try {
    const demoteeId = `demotee-${seed.suffix}`;
    const demoteeMemId = `demotee-mem-${seed.suffix}`;
    await db.insert(users).values({ id: demoteeId, username: `demotee-${seed.suffix}`, passwordHash: "unused" });
    await db.insert(organizationMemberships).values({ id: demoteeMemId, userId: demoteeId, orgId: seed.orgId, role: "member" });

    const resource = await expectSuccessResponse(await request(`/api/v2/plans/plan-${targetRunId}`, { headers: owner }), 200, "plans");
    const before = resource.attributes["log-read-url"] as string;
    expect((await request(before)).status).toBe(200);

    const demoted = await request(`/api/v2/organization-memberships/${demoteeMemId}`, {
      method: "PATCH",
      headers: owner,
      body: JSON.stringify({ data: { type: "organization-memberships", attributes: { status: "invited" } } }),
    });
    expect(demoted.status).toBe(200);
    expect((await request(before)).status).toBe(404);
    expect((await request((await expectSuccessResponse(await request(`/api/v2/plans/plan-${targetRunId}`, { headers: owner }), 200, "plans")).attributes["log-read-url"] as string)).status).toBe(200);
  } finally {
    await db.delete(logs).where(eq(logs.runId, targetRunId));
    await db.delete(runs).where(eq(runs.id, targetRunId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, `demotee-${seed.suffix}`));
    await db.delete(users).where(eq(users.id, `demotee-${seed.suffix}`));
  }
});

test("retained archives remain readable until revocation; soft-deleted runs cannot issue or use capabilities", async () => {
  const issued = await link("plan");
  await archiveRunLogs(runId);
  await db.delete(logs).where(eq(logs.runId, runId));
  expect(await (await request(issued)).text()).toBe(canary);
  await db.update(runs).set({ softDeletedAt: Date.now() }).where(eq(runs.id, runId));
  expect((await request(issued)).status).toBe(404);
  const resource = await expectSuccessResponse(await request(`/api/v2/plans/plan-${runId}`, { headers: owner }), 200, "plans");
  expect(resource.attributes["log-read-url"]).toBeNull();
  expect((await request(`/api/v2/runs/${runId}/actions/revoke-log-links`, { method: "POST", headers: owner })).status).toBe(404);
  // The existing authorized archive endpoint keeps its retention contract.
  expect(await (await request(`/api/v2/runs/${runId}/plan/log`, { headers: owner })).text()).toBe(canary);
});
