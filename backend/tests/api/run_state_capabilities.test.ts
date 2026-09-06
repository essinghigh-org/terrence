import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { apiTokens, logs, runComments, runs, stateVersions, teams, teamWorkspaces, workspaces } from "../../src/db/schema";
import { readPlanJsonArtifact, writePlanJsonArtifact } from "../../src/lib/plan-json";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { cleanupSeed, jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";

const seed = seedOrg("state-capability");
const workspaceId = `ws-${seed.suffix}`;
const runId = `run-${seed.suffix}`;
const stateId = `sv-${seed.suffix}`;
const teamId = `team-${seed.suffix}`;
const token = `team-token-${seed.suffix}`;

beforeAll(async () => {
  await persistSeed(seed);
  await db.insert(workspaces).values({ id: workspaceId, orgId: seed.orgId, name: "capability" });
  await db.insert(runs).values({ id: runId, workspaceId, createdAt: Date.now(), status: "errored", statusTimestamps: { "input-state-version-id": stateId } });
  await db.insert(stateVersions).values({ id: stateId, workspaceId, runId, serial: 1, statePayload: '{"version":4,"serial":1,"lineage":"test"}' });
  await db.insert(teams).values({ id: teamId, orgId: seed.orgId, name: "restricted" });
  await db.insert(teamWorkspaces).values({ id: `tw-${seed.suffix}`, teamId, workspaceId, access: "custom", permissions: { runs: "read", "state-versions": "none" } });
  await db.insert(apiTokens).values({ id: `tok-${seed.suffix}`, token: hashAuthenticationToken(token), teamId });
});
afterAll(async () => {
  await db.delete(apiTokens).where(eq(apiTokens.teamId, teamId));
  await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, teamId));
  await db.delete(teams).where(eq(teams.id, teamId));
  await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
  await db.delete(runs).where(eq(runs.id, runId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await cleanupSeed(seed);
});

test("run-read alone cannot mint state capabilities; granting and revoking state-read takes effect immediately", async () => {
  const paths = [`/api/v2/runs/${runId}/input-state-version`, `/api/v2/applies/apply-${runId}/errored-state`];
  expect((await request(`/api/v2/runs/${runId}`, { headers: jsonHeaders(token) })).status).toBe(200);
  for (const stateAccess of ["none", "read", "none"]) {
    await db.update(teamWorkspaces).set({ permissions: { runs: "read", "state-versions": stateAccess } }).where(eq(teamWorkspaces.teamId, teamId));
    for (const path of paths) {
      const response = await request(path, { headers: jsonHeaders(token) });
      if (stateAccess === "none") {
        expect(response.status).toBe(404);
        expect(response.headers.get("location")).toBeNull();
        expect(await response.text()).not.toContain("signature");
      } else {
        expect([200, 307]).toContain(response.status);
        if (response.status === 307) expect(response.headers.get("location")).toContain(`/state-versions/${stateId}/download`);
        else expect((await response.json()).data.attributes["hosted-state-download-url"]).toContain(`/state-versions/${stateId}/download`);
      }
    }
  }
});


test("run-read cannot create comments or delete another author's comment", async () => {
  const comment = { data: { type: "comments", attributes: { body: "Review note" } } };
  expect((await request(`/api/v2/runs/${runId}/comments`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(comment) })).status).toBe(404);
  const created = await request(`/api/v2/runs/${runId}/comments`, { method: "POST", headers: jsonHeaders(seed.token), body: JSON.stringify(comment) });
  expect(created.status).toBe(201);
  const id = (await created.json()).data.id;
  expect((await request(`/api/v2/comments/${id}`, { method: "DELETE", headers: jsonHeaders(token) })).status).toBe(403);
  expect(await db.query.runComments.findFirst({ where: eq(runComments.id, id) })).toBeDefined();
  expect((await request(`/api/v2/comments/${id}`, { method: "DELETE", headers: jsonHeaders(seed.token) })).status).toBe(204);
});

test("run deletion revalidates status and preserves logs and artifacts on database failure", async () => {
  await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
  await db.insert(logs).values({ id: `log-${seed.suffix}`, runId, phase: "plan", outputText: "keep this log", createdAt: Date.now() });
  await writePlanJsonArtifact(runId, { marker: "keep this artifact" });
  const transaction = db.transaction.bind(db);
  const handoff = spyOn(db, "transaction").mockImplementationOnce((async (callback, ...options) => {
    await db.update(runs).set({ status: "planning" }).where(eq(runs.id, runId));
    return transaction(callback, ...options);
  }) as typeof db.transaction);
  try {
    expect((await request(`/api/v2/runs/${runId}`, { method: "DELETE", headers: jsonHeaders(seed.token) })).status).toBe(409);
  } finally { handoff.mockRestore(); }
  expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))?.status).toBe("planning");
  expect(await readPlanJsonArtifact(runId)).toEqual({ marker: "keep this artifact" });
  await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
  const failCommit = spyOn(db, "transaction").mockImplementationOnce((async (callback, ...options) => transaction(async (tx) => {
    await callback(tx);
    throw new Error("synthetic failed delete commit");
  }, ...options)) as typeof db.transaction);
  try {
    expect((await request(`/api/v2/runs/${runId}`, { method: "DELETE", headers: jsonHeaders(seed.token) })).status).toBe(500);
  } finally { failCommit.mockRestore(); }
  expect(await db.query.runs.findFirst({ where: eq(runs.id, runId) })).toBeDefined();
  expect((await db.query.logs.findFirst({ where: eq(logs.runId, runId) }))?.outputText).toBe("keep this log");
  expect(await readPlanJsonArtifact(runId)).toEqual({ marker: "keep this artifact" });
});

test("run deletion waits for a local execution before it has spawned a CLI", async () => {
  const { executeRun, hasActiveRunExecution } = await import("../../src/worker");
  const find = db.query.runs.findFirst.bind(db.query.runs);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pause = spyOn(db.query.runs, "findFirst").mockImplementationOnce((async (...args) => {
    entered();
    await held;
    return find(...args);
  }) as typeof db.query.runs.findFirst);
  const execution = executeRun(runId);
  try {
    await waiting;
    expect(hasActiveRunExecution(runId)).toBe(true);
    expect((await request(`/api/v2/runs/${runId}`, { method: "DELETE", headers: jsonHeaders(seed.token) })).status).toBe(409);
  } finally {
    release();
    await execution;
    pause.mockRestore();
  }
  expect(hasActiveRunExecution(runId)).toBe(false);
  expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))?.status).toBe("errored");
});

test("run deletion rejects every non-final status and preserves its tracking record", async () => {
  const { RUN_STATUSES } = await import("../../src/lib/run-status");
  const { FINAL_RUN_STATUSES } = await import("../../src/lib/utils");
  for (const status of RUN_STATUSES.filter((status) => !FINAL_RUN_STATUSES.includes(status))) {
    await db.update(runs).set({ status }).where(eq(runs.id, runId));
    expect((await request(`/api/v2/runs/${runId}`, { method: "DELETE", headers: jsonHeaders(seed.token) })).status).toBe(409);
    expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))?.status).toBe(status);
  }
  await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
  expect((await request(`/api/v2/runs/${runId}`, { method: "DELETE", headers: jsonHeaders(seed.token) })).status).toBe(204);
  expect(await db.query.logs.findFirst({ where: eq(logs.runId, runId) })).toBeUndefined();
  expect(await readPlanJsonArtifact(runId)).toBeUndefined();
});
