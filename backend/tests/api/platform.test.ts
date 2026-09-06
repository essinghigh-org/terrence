import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, durableJobs, organizationMemberships, organizations, runs, users, workspaces } from "../../src/db/schema";
import { createPlatformArtifact, getPlatformArtifact, listPlatformArtifacts } from "../../src/lib/platform-artifacts";
import { hashAuthenticationToken } from "../../src/lib/token-service";

const suffix = crypto.randomUUID();
const orgId = `platform-org-${suffix}`;
const otherOrgId = `platform-other-${suffix}`;
const userId = `platform-user-${suffix}`;
const workspaceId = `platform-ws-${suffix}`;
const token = `platform-token-${suffix}`;
const artifacts: string[] = [];
const request = (path: string, method = "GET", attributes?: Record<string, unknown>): Promise<Response> => app.handle(new Request(`http://terrence.test/api/v2${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.api+json" },
  ...(attributes === undefined ? {} : { body: JSON.stringify({ data: { attributes } }) }),
}));

beforeAll(async () => {
  await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
  await db.insert(organizations).values([{ id: orgId, name: orgId }, { id: otherOrgId, name: otherOrgId }]);
  await db.insert(organizationMemberships).values({ id: `membership-${suffix}`, userId, orgId, role: "owner", status: "active" });
  await db.insert(apiTokens).values({ id: `token-${suffix}`, userId, token: hashAuthenticationToken(token) });
  await db.insert(workspaces).values({ id: workspaceId, orgId, name: "platform" });
});

afterAll(async () => {
  if (artifacts.length > 0) await db.delete(durableJobs).where(inArray(durableJobs.id, artifacts));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(apiTokens).where(eq(apiTokens.id, `token-${suffix}`));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `membership-${suffix}`));
  await db.delete(organizations).where(inArray(organizations.id, [orgId, otherOrgId]));
  await db.delete(users).where(eq(users.id, userId));
});

test("artifact limits and deduplication are scoped before selecting tenant records", async () => {
  const first = await createPlatformArtifact({ kind: "import-workbench", organizationId: orgId, workspaceId, dedupeKey: suffix, payload: {} });
  artifacts.push(first.id);
  const otherWorkspace = await createPlatformArtifact({ kind: "import-workbench", organizationId: orgId, workspaceId: "another-workspace", dedupeKey: suffix, payload: {} });
  artifacts.push(otherWorkspace.id);
  const otherTenant = await createPlatformArtifact({ kind: "import-workbench", organizationId: otherOrgId, workspaceId, dedupeKey: suffix, payload: {} });
  artifacts.push(otherTenant.id);
  expect(new Set(artifacts).size).toBe(3);
  await db.update(durableJobs).set({ createdAt: Date.now() + 1000 }).where(inArray(durableJobs.id, [otherWorkspace.id, otherTenant.id]));
  expect((await listPlatformArtifacts({ kind: "import-workbench", organizationId: orgId, workspaceId, limit: 1 })).map((row) => row.id)).toEqual([first.id]);
  expect(await getPlatformArtifact(otherTenant.id, "import-workbench", orgId)).toBeUndefined();
});

test("user tokens can read and export their workbench but cannot read another tenant", async () => {
  const response = await request(`/workspaces/${workspaceId}/import-workbench`, "POST", { mappings: [{ address: "example_resource.web", "provider-id": "id-123" }] });
  expect(response.status).toBe(201);
  const body = await response.json() as { data: { id: string } };
  artifacts.push(body.data.id);
  expect((await request(`/import-workbenches/${body.data.id}`)).status).toBe(200);
  const exported = await request(`/import-workbenches/${body.data.id}/export`, "POST");
  expect(exported.status).toBe(200);
  expect(await exported.text()).toContain('id = "id-123"');
  const foreign = await createPlatformArtifact({ kind: "import-workbench", organizationId: otherOrgId, workspaceId, payload: {} });
  artifacts.push(foreign.id);
  expect((await request(`/import-workbenches/${foreign.id}`)).status).toBe(404);
  expect((await request(`/import-workbenches/${foreign.id}/export`, "POST")).status).toBe(404);
});

test("unimplemented fleet execution leaves the preview intact and creates no runs", async () => {
  const preview = await createPlatformArtifact({ kind: "fleet-operation", organizationId: orgId, status: "preview", payload: { manifest: { "target-ids": [workspaceId], action: "queue-plan", "selection-digest": "digest" } } });
  artifacts.push(preview.id);
  const response = await request(`/organizations/${orgId}/fleet-operations`, "POST", { "preview-id": preview.id, "selection-digest": "digest" });
  expect(response.status).toBe(501);
  expect((await getPlatformArtifact(preview.id, "fleet-operation", orgId))?.status).toBe("preview");
  expect(await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) })).toBeUndefined();
});

test("promotion advance cannot queue unverified release content", async () => {
  const response = await request(`/organizations/${orgId}/promotions`, "POST", { "configuration-digest": "unverified", "target-workspace-ids": [workspaceId] });
  expect(response.status).toBe(201);
  const body = await response.json() as { data: { id: string } };
  artifacts.push(body.data.id);
  expect((await request(`/organizations/${orgId}/promotions/${body.data.id}/advance`, "POST")).status).toBe(501);
  expect(await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) })).toBeUndefined();
});
