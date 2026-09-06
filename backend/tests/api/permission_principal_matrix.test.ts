import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { agentPools, agentPoolTokens, apiTokens, organizationMemberships, runs, runTokens, stateVersions, teams, teamWorkspaces, users, workspaceVariables, workspaces } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { mintRunToken } from "../../src/lib/run-token";
import { deletePlanJsonArtifact, writePlanJsonArtifact } from "../../src/lib/plan-json";
import { cleanupSeed, jsonHeaders, persistSeed, request, seedOrg } from "./compat_contract_helpers";

const seed = seedOrg("principal-matrix");
const foreign = seedOrg("principal-matrix-foreign");
const id = (kind: string): string => `${kind}-${seed.suffix}`;
const canary = id("private-value");
const ws = id("ws");
const otherWs = id("other-ws");
const foreignWs = id("foreign-ws");
const runId = id("run");
const stateId = id("state");
const teamId = id("team");
const scopedId = id("scoped-token");
type Surface = "state" | "raw-plan" | "public-plan" | "state-link" | "variables";
type Principal = { name: string; token?: string; allows: readonly Surface[]; crossWorkspace?: boolean; crossOrganization?: boolean };
const principals: Principal[] = [];
const all: readonly Surface[] = ["state", "raw-plan", "public-plan", "state-link", "variables"];
const pathFor = (surface: Surface, workspace = ws): string => {
  const targetRun = workspace === ws ? runId : `${workspace}-run`;
  const targetState = workspace === ws ? stateId : `${workspace}-state`;
  switch (surface) {
    case "state": return `/api/v2/state-versions/${targetState}/download`;
    case "raw-plan": return `/api/v2/plans/plan-${targetRun}/json-output`;
    case "public-plan": return `/api/v2/plans/plan-${targetRun}/json-output-redacted`;
    case "state-link": return `/api/v2/runs/${targetRun}/input-state-version`;
    case "variables": return `/api/v2/workspaces/${workspace}/vars`;
  }
};

beforeAll(async () => {
  await persistSeed(seed);
  await persistSeed(foreign);
  for (const workspace of [ws, otherWs, foreignWs]) {
    const targetRun = workspace === ws ? runId : `${workspace}-run`;
    const targetState = workspace === ws ? stateId : `${workspace}-state`;
    await db.insert(workspaces).values({ id: workspace, orgId: workspace === foreignWs ? foreign.orgId : seed.orgId, name: workspace });
    await db.insert(runs).values({ id: targetRun, workspaceId: workspace, status: "planned", createdAt: Date.now(), statusTimestamps: { "input-state-version-id": targetState } });
    await db.insert(stateVersions).values({ id: targetState, workspaceId: workspace, runId: targetRun, serial: 1,
      statePayload: JSON.stringify({ version: 4, serial: 1, lineage: workspace, resources: [], outputs: { password: { value: canary, sensitive: true, type: "string" } } }),
      jsonState: JSON.stringify({ version: 4, serial: 1, lineage: workspace, resources: [], outputs: { password: { value: canary, sensitive: true, type: "string" } } }) });
    await db.insert(workspaceVariables).values({ id: `${workspace}-var`, workspaceId: workspace, key: "password", value: canary, sensitive: true });
    await writePlanJsonArtifact(targetRun, { format_version: "1.2", variables: { password: { value: canary } }, resource_changes: [{ address: "test.example", change: { actions: ["create"], after: { password: canary }, after_sensitive: { password: true } } }] });
  }
  for (const name of ["ordinary", "suspended", "site-admin"]) {
    await db.insert(users).values({ id: id(name), username: id(name), passwordHash: "unused", isSuspended: name === "suspended", isSiteAdmin: name === "site-admin" });
    await db.insert(organizationMemberships).values({ id: id(`${name}-membership`), userId: id(name), orgId: seed.orgId, role: name === "suspended" ? "owner" : "member" });
    await db.insert(apiTokens).values({ id: id(`${name}-token`), userId: id(name), token: hashAuthenticationToken(id(`${name}-credential`)) });
  }
  await db.insert(teams).values({ id: teamId, orgId: seed.orgId, name: teamId });
  await db.insert(teamWorkspaces).values({ id: id("team-access"), teamId, workspaceId: ws, access: "custom", permissions: { runs: "read", "state-versions": "none", variables: "none" } });
  await db.insert(apiTokens).values([
    { id: id("team-token"), teamId, token: hashAuthenticationToken(id("team-credential")) },
    { id: id("org-token"), orgId: seed.orgId, token: hashAuthenticationToken(id("org-credential")) },
    { id: scopedId, userId: seed.userId, token: hashAuthenticationToken(id("scoped-credential")), scopes: JSON.stringify({ version: 1, orgs: [seed.orgId], workspaces: [ws], permissions: { "workspaces:read": true, "runs:read": true } }) },
  ]);
  await db.insert(agentPools).values({ id: id("pool"), orgId: seed.orgId, name: id("pool") });
  await db.insert(agentPoolTokens).values({ id: id("pool-token"), agentPoolId: id("pool"), token: hashAuthenticationToken(id("agent-credential")) });
  principals.push(
    { name: "anonymous", allows: [] },
    { name: "ordinary member without workspace access", token: id("ordinary-credential"), allows: [] },
    { name: "suspended owner", token: id("suspended-credential"), allows: [] },
    { name: "limited custom team", token: id("team-credential"), allows: ["public-plan"] },
    { name: "organization token", token: id("org-credential"), allows: all, crossWorkspace: true },
    { name: "scoped personal token", token: id("scoped-credential"), allows: ["public-plan"] },
    { name: "run token", token: await mintRunToken(runId, ws, seed.orgId), allows: ["state", "raw-plan", "public-plan"] },
    { name: "agent pool token", token: id("agent-credential"), allows: [] },
    { name: "site administrator", token: id("site-admin-credential"), allows: all, crossWorkspace: true, crossOrganization: true },
    { name: "organization owner", token: seed.token, allows: all, crossWorkspace: true },
  );
});

afterAll(async () => {
  for (const workspace of [ws, otherWs, foreignWs]) await deletePlanJsonArtifact(workspace === ws ? runId : `${workspace}-run`);
  await db.delete(agentPoolTokens).where(eq(agentPoolTokens.agentPoolId, id("pool")));
  await db.delete(agentPools).where(eq(agentPools.id, id("pool")));
  await db.delete(apiTokens).where(inArray(apiTokens.id, [id("team-token"), id("org-token"), scopedId, ...["ordinary", "suspended", "site-admin"].map((name) => id(`${name}-token`))]));
  await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, teamId));
  await db.delete(teams).where(eq(teams.id, teamId));
  await db.delete(runTokens).where(eq(runTokens.runId, runId));
  await db.delete(stateVersions).where(inArray(stateVersions.workspaceId, [ws, otherWs, foreignWs]));
  await db.delete(runs).where(inArray(runs.workspaceId, [ws, otherWs, foreignWs]));
  await db.delete(workspaces).where(inArray(workspaces.id, [ws, otherWs, foreignWs]));
  await db.delete(organizationMemberships).where(inArray(organizationMemberships.userId, [id("ordinary"), id("suspended"), id("site-admin")]));
  await db.delete(users).where(inArray(users.id, [id("ordinary"), id("suspended"), id("site-admin")]));
  await cleanupSeed(seed);
  await cleanupSeed(foreign);
});

test("credential classes cannot exchange run-read for state-read or escape their object scope", async () => {
  for (const principal of principals) {
    for (const workspace of [ws, otherWs, foreignWs]) {
      for (const surface of all) {
        const allowed = principal.allows.includes(surface) && (workspace === ws || (workspace === otherWs ? principal.crossWorkspace === true : principal.crossOrganization === true));
        const response = await request(pathFor(surface, workspace), { headers: principal.token === undefined ? {} : jsonHeaders(principal.token) });
        const text = await response.text();
        const context = `${principal.name} / ${surface} / ${workspace}`;
        if (allowed) {
          expect(response.status, context + text.slice(0, 100)).toBe(200);
          if (surface === "public-plan" || surface === "variables") expect(text, context).not.toContain(canary);
          if (surface === "state" || surface === "raw-plan") expect(text, context).toContain(canary);
        } else {
          expect([401, 403, 404], context + text.slice(0, 100)).toContain(response.status);
          expect(text, context).not.toContain(canary);
          expect(text, context).not.toContain("hosted-state-download-url");
          expect(response.headers.get("location"), context).toBeNull();
        }
      }
    }
  }
});

test("read-only and non-user credentials cannot plan, apply or write variables", async () => {
  for (const principal of principals.filter((entry) => entry.name !== "organization owner" && entry.name !== "site administrator")) {
    const headers = principal.token === undefined ? { "Content-Type": "application/vnd.api+json" } : jsonHeaders(principal.token);
    const operations = [
      { path: "/api/v2/runs", body: { data: { type: "runs", attributes: { "plan-only": true }, relationships: { workspace: { data: { type: "workspaces", id: ws } } } } } },
      { path: `/api/v2/runs/${runId}/actions/apply`, body: {} },
      ...(principal.name === "organization token" ? [] : [{ path: `/api/v2/workspaces/${ws}/vars`, body: { data: { type: "vars", attributes: { key: "unauthorized", value: canary, category: "terraform" } } } }]),
    ];
    for (const operation of operations) {
      const response = await request(operation.path, { method: "POST", headers, body: JSON.stringify(operation.body) });
      expect([401, 403, 404], `${principal.name}: ${operation.path}: ${await response.text()}`).toContain(response.status);
    }
  }
  expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))?.status).toBe("planned");
  expect((await db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, ws) })).map((variable) => variable.key)).toEqual(["password"]);
});

test("only a site administrator can use the administration surface", async () => {
  for (const principal of principals) {
    const response = await request("/api/v2/admin/users", { headers: principal.token === undefined ? {} : jsonHeaders(principal.token) });
    if (principal.name === "site administrator") expect(response.status).toBe(200);
    else expect([401, 403, 404], principal.name).toContain(response.status);
  }
});

test("adding and removing state:read changes direct and indirect access without changing run-read", async () => {
  const token = id("scoped-credential");
  for (const granted of [false, true, false]) {
    await db.update(apiTokens).set({ scopes: JSON.stringify({ version: 1, orgs: [seed.orgId], workspaces: [ws], permissions: { "workspaces:read": true, "runs:read": true, ...(granted ? { "state:read": true } : {}) } }) }).where(eq(apiTokens.id, scopedId));
    for (const surface of ["state", "raw-plan", "state-link", "public-plan"] as const) {
      const response = await request(pathFor(surface), { headers: jsonHeaders(token) });
      expect(response.status, `${surface}, grant=${granted}`).toBe(granted || surface === "public-plan" ? 200 : 404);
    }
    const mcp = await request("/mcp", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_plan_json", arguments: { workspace_id: ws, run_id: runId } } }),
    });
    expect(mcp.status).toBe(200);
    const body = await mcp.text();
    expect(body).not.toContain(canary);
    expect(body).toContain("test.example");
  }
});


test("MCP state reads enforce the same principal and organization boundaries", async () => {
  for (const principal of principals) {
    for (const workspace of [ws, foreignWs]) {
      const response = await request("/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", ...(principal.token === undefined ? {} : { Authorization: `Bearer ${principal.token}` }) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_workspace_state", arguments: { workspace_id: workspace } } }),
      });
      const text = await response.text();
      const allowed = principal.name !== "run token" && principal.allows.includes("state") && (workspace === ws || principal.crossOrganization === true);
      if (allowed) {
        expect(response.status, principal.name).toBe(200);
        expect(text, principal.name).toContain(canary);
      } else {
        expect(text, principal.name).not.toContain(canary);
        const body = JSON.parse(text);
        expect(body.error, principal.name + text).toBeDefined();
      }
    }
  }
});

test("MCP rechecks suspension, expiry and revoked browser families on every request", async () => {
  const call = (): Promise<Response> => request("/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${seed.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_workspace_state", arguments: { workspace_id: ws } } }),
  });
  expect(await (await call()).text()).toContain(canary);
  try {
    for (const condition of ["suspended", "expired", "revoked-family"] as const) {
      await db.update(users).set({ isSuspended: condition === "suspended" }).where(eq(users.id, seed.userId));
      await db.update(apiTokens).set({ expiresAt: condition === "expired" ? Date.now() - 1 : null, refreshFamilyId: condition === "revoked-family" ? id("revoked-family") : null }).where(eq(apiTokens.id, seed.tokenId));
      const response = await call();
      expect(response.status, condition).toBe(401);
      expect(await response.text(), condition).not.toContain(canary);
      const stream = await request("/mcp", { headers: jsonHeaders(seed.token) });
      expect(stream.status, condition + " stream").toBe(401);
      await stream.body?.cancel();
    }
  } finally {
    await db.update(users).set({ isSuspended: false }).where(eq(users.id, seed.userId));
    await db.update(apiTokens).set({ expiresAt: null, refreshFamilyId: null }).where(eq(apiTokens.id, seed.tokenId));
  }
  expect(await (await call()).text()).toContain(canary);
});

test("MCP current state ignores newer pending, discarded and intermediate versions", async () => {
  const extraIds = [id("pending-state"), id("discarded-state"), id("intermediate-state")] as const;
  try {
    await db.insert(stateVersions).values([
      { id: extraIds[0], workspaceId: ws, serial: 2, status: "pending", createdAt: Date.now() + 1 },
      { id: extraIds[1], workspaceId: ws, serial: 3, status: "discarded", createdAt: Date.now() + 2 },
      { id: extraIds[2], workspaceId: ws, serial: 4, status: "finalized", intermediate: true, createdAt: Date.now() + 3 },
    ]);
    const response = await request("/mcp", {
      method: "POST", headers: { Authorization: `Bearer ${seed.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_workspace_state", arguments: { workspace_id: ws } } }),
    });
    const body = await response.json();
    expect(JSON.parse(body.result.content[0].text).id).toBe(stateId);
  } finally {
    await db.delete(stateVersions).where(inArray(stateVersions.id, extraIds));
  }
});
