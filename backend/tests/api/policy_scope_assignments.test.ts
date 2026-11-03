import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  policies,
  policySets,
  users,
  workspaces,
  projects,
} from "../../src/db/schema";

describe("Policy-set scope assignment compatibility", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `polfilter-${suffix}`;
  const token = `token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const sentinelPolicyId = `pol-sentinel-${suffix}`;
  const opaPolicyId = `pol-opa-${suffix}`;
  const sentinelSetId = `polset-sentinel-${suffix}`;
  const opaSetId = `polset-opa-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`,
      userId,
      orgId,
      role: "owner",
      status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(policies).values({
      id: sentinelPolicyId,
      orgId,
      name: "Sentinel Policy Alpha",
      kind: "sentinel",
    });
    await db.insert(policies).values({
      id: opaPolicyId,
      orgId,
      name: "OPA Policy Beta",
      kind: "opa",
    });
    await db.insert(policySets).values({ id: sentinelSetId, orgId, name: "Sentinel Set", kind: "sentinel" });
    await db.insert(policySets).values({ id: opaSetId, orgId, name: "OPA Set", kind: "opa" });
  });

  afterAll(async () => {
    await db.delete(policies).where(eq(policies.orgId, orgId));
    await db.delete(policySets).where(eq(policySets.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("enforces mutually exclusive tag and explicit scopes in both directions", async () => {
    await db.insert(projects).values({ id: `scope-project-${suffix}`, orgId, name: `scope-project-${suffix}` });
    await db.insert(workspaces).values({ id: `scope-workspace-${suffix}`, orgId, name: `scope-workspace-${suffix}` });
    for (const name of ["workspaces", "projects", "workspace-exclusions", "project-exclusions"]) {
      const created = await request(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
        data: { type: "policy-sets", attributes: { name: `${name}-${suffix}` } },
      });
      expect(created.status).toBe(201);
      const id = (await created.json()).data.id;
      const path = `/api/v2/policy-sets/${id}`;
      const isWorkspace = name.startsWith("workspace");
      const explicit = {
        data: [
          {
            type: isWorkspace ? "workspaces" : "projects",
            id: `scope-${isWorkspace ? "workspace" : "project"}-${suffix}`,
          },
        ],
      };
      const selector = { data: [{ "tag-key": "env", "tag-value": "prod", "is-exclude": false }] };
      expect((await request(`${path}/relationships/${name}`, "POST", explicit)).status).toBe(204);
      expect((await request(`${path}/tag-selectors`, "POST", selector)).status).toBe(422);
      expect((await request(`${path}/relationships/${name}`, "DELETE", explicit)).status).toBe(204);
      expect((await request(`${path}/tag-selectors`, "POST", selector)).status).toBe(204);
      expect((await request(`${path}/relationships/${name}`, "POST", explicit)).status).toBe(422);
      expect((await request(`${path}/tag-selectors`, "DELETE", selector)).status).toBe(204);
      expect((await request(`${path}/relationships/${name}`, "POST", explicit)).status).toBe(204);
      await request(path, "DELETE");
    }
  });

  it("persists provider workspace relationships at creation and rejects unsupported initial scope", async () => {
    const workspaceId = `create-workspace-${suffix}`;
    await db.insert(workspaces).values({ id: workspaceId, orgId, name: workspaceId });
    const path = `/api/v2/organizations/${orgName}/policy-sets`;
    const payload = {
      data: {
        type: "policy-sets",
        attributes: { name: `initial-workspace-${suffix}` },
        relationships: { workspaces: { data: [{ id: workspaceId, type: "workspaces" }] } },
      },
    };
    const created = await request(path, "POST", payload);
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data.relationships.workspaces.data).toEqual([{ id: workspaceId, type: "workspaces" }]);
    const read = await request(`/api/v2/policy-sets/${body.data.id}`);
    expect((await read.json()).data.relationships.workspaces.data).toEqual([{ id: workspaceId, type: "workspaces" }]);
    expect(
      (await request(`/api/v2/policy-sets/${body.data.id}/tag-selectors`, "POST", { data: [{ "tag-key": "env" }] }))
        .status,
    ).toBe(422);
    await request(`/api/v2/policy-sets/${body.data.id}`, "DELETE");
    for (const field of ["projects", "stacks", "workspace-exclusions", "project-exclusions", "tag-selectors"]) {
      expect(
        (
          await request(path, "POST", {
            data: {
              type: "policy-sets",
              attributes: { name: `unsupported-${field}` },
              relationships: { [field]: { data: [{ id: workspaceId, type: "workspaces" }] } },
            },
          })
        ).status,
      ).toBe(422);
    }
    expect(
      (
        await request(path, "POST", {
          data: {
            type: "policy-sets",
            attributes: { name: "unsupported-tags", "tag-selectors": [{ "tag-key": "env" }] },
          },
        })
      ).status,
    ).toBe(422);
    payload.data.relationships.workspaces.data[0]!.id = "nonexistent-or-foreign-workspace";
    expect((await request(path, "POST", payload)).status).toBe(422);
  });
});
