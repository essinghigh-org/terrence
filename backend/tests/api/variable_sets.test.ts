import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
  variableSets,
  variableSetVariables,
  variableSetWorkspaces,
  workspaces,
} from "../../src/db/schema";

describe("organization variable set API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const unrelatedUserId = `other-user-${suffix}`;
  const orgId = `org-${suffix}`;
  const unrelatedOrgId = `other-org-${suffix}`;
  const orgName = `varsets-${suffix}`;
  const token = `user-token-${suffix}`;
  const unrelatedToken = `other-token-${suffix}`;
  const orgToken = `org-token-${suffix}`;
  const workspaceIds = [`workspace-a-${suffix}`, `workspace-b-${suffix}`];
  const unrelatedWorkspaceId = `other-workspace-${suffix}`;
  const detachedWorkspaceId = `detached-workspace-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: userId, passwordHash: "unused" },
      { id: unrelatedUserId, username: unrelatedUserId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: unrelatedOrgId, name: `other-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: unrelatedUserId, orgId: unrelatedOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token, userId },
      { id: crypto.randomUUID(), token: unrelatedToken, userId: unrelatedUserId },
      { id: crypto.randomUUID(), token: orgToken, orgId },
    ]);
    await db.insert(workspaces).values([
      { id: workspaceIds[0]!, name: `alpha-${suffix}`, orgId },
      { id: workspaceIds[1]!, name: `beta-${suffix}`, orgId },
      { id: detachedWorkspaceId, name: `gamma-${suffix}`, orgId },
      { id: unrelatedWorkspaceId, name: `other-${suffix}`, orgId: unrelatedOrgId },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, unrelatedOrgId]));
    await db.delete(users).where(inArray(users.id, [userId, unrelatedUserId]));
  });

  it("creates, manages, scopes, and deletes organization variable sets", async () => {
    expect((await request(`/api/v2/organizations/${orgName}/varsets`, "POST", {
      data: { type: "varsets", attributes: { name: "unsupported", foobar: true } },
    })).status).toBe(422);

    const created = await request(`/api/v2/organizations/${orgName}/varsets`, "POST", {
      data: {
        type: "varsets",
        attributes: { name: "shared-config", description: "shared values", global: true },
      },
    });
    expect(created.status).toBe(201);
    const createdData = (await created.json()).data;
    const variableSetId = createdData.id as string;
    expect(createdData.attributes).toMatchObject({
      name: "shared-config",
      description: "shared values",
      global: true,
      "var-count": 0,
      "workspace-count": 0,
    });
    expect(createdData.relationships.organization.data).toEqual({ id: orgName, type: "organizations" });
    expect(createdData.relationships.parent.data).toEqual({ id: orgName, type: "organizations" });

    const listed = await request(`/api/v2/organizations/${orgName}/varsets?q=shared&page[size]=1`);
    expect(listed.status).toBe(200);
    const listData = await listed.json();
    expect(listData.data.map((item: any) => item.id)).toEqual([variableSetId]);
    expect(listData.meta.pagination["total-count"]).toBe(1);

    expect((await request(`/api/v2/varsets/${variableSetId}`, "GET", undefined, orgToken)).status).toBe(200);
    expect((await request(`/api/v2/varsets/${variableSetId}`, "GET", undefined, unrelatedToken)).status).toBe(404);

    const updated = await request(`/api/v2/varsets/${variableSetId}`, "PATCH", {
      data: {
        type: "varsets",
        attributes: { name: "shared-renamed", description: null, global: false },
      },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.attributes).toMatchObject({
      name: "shared-renamed",
      description: null,
      global: false,
    });

    const workspaceRelationships = {
      data: workspaceIds.map(id => ({ id, type: "workspaces" })),
    };
    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/workspaces`,
      "POST",
      workspaceRelationships,
    )).status).toBe(204);
    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/workspaces`,
      "POST",
      { data: [{ id: workspaceIds[0], type: "workspaces" }] },
    )).status).toBe(204);
    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/workspaces`,
      "POST",
      { data: [{ id: unrelatedWorkspaceId, type: "workspaces" }] },
    )).status).toBe(422);
    expect(await db.query.variableSetWorkspaces.findMany({
      where: eq(variableSetWorkspaces.variableSetId, variableSetId),
    })).toHaveLength(2);

    const related = await request(`/api/v2/varsets/${variableSetId}/relationships/workspaces`, "GET");
    expect(related.status).toBe(200);
    expect(((await related.json()).data as Array<{ id: string; type: string }>))
      .toEqual([...workspaceIds].sort().map(id => ({ id, type: "workspaces" })));
    expect((await request(`/api/v2/varsets/${variableSetId}/relationships/workspaces`, "GET", undefined, unrelatedToken)).status).toBe(404);

    // Workspace side: attached variable sets are listed per workspace. Inherited
    // variables are never flattened into the workspace-variable collection.
    const workspaceSets = await request(`/api/v2/workspaces/${workspaceIds[0]}/varsets`);
    expect(workspaceSets.status).toBe(200);
    const workspaceSetsData = (await workspaceSets.json()).data as Array<{ id: string }>;
    expect(workspaceSetsData).toHaveLength(1);
    expect(workspaceSetsData[0]!.id).toBe(variableSetId);
    expect((await request(`/api/v2/workspaces/${workspaceIds[0]}/varsets`, "GET", undefined, unrelatedToken)).status).toBe(404);
    expect((await request(`/api/v2/workspaces/${unrelatedWorkspaceId}/varsets`)).status).toBe(404);
    const noSetWorkspace = await request(`/api/v2/workspaces/${detachedWorkspaceId}/varsets`);
    expect(noSetWorkspace.status).toBe(200);
    expect(((await noSetWorkspace.json()).data as Array<unknown>)).toEqual([]);

    const shown = await request(`/api/v2/varsets/${variableSetId}`);
    const shownData = (await shown.json()).data;
    expect(shownData.attributes["workspace-count"]).toBe(2);
    expect(shownData.relationships.workspaces.data.map((item: any) => item.id).sort())
      .toEqual([...workspaceIds].sort());

    const addedVariable = await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "POST", {
      data: {
        type: "vars",
        attributes: {
          key: "TF_TOKEN",
          value: "do-not-leak",
          category: "env",
          sensitive: true,
          hcl: false,
          description: "API token",
        },
      },
    });
    expect(addedVariable.status).toBe(200);
    const variableData = (await addedVariable.json()).data;
    const variableId = variableData.id as string;
    expect(variableData.attributes.value).toBeNull();
    expect(variableData.attributes.sensitive).toBe(true);
    expect((await db.query.variableSetVariables.findFirst({
      where: eq(variableSetVariables.id, variableId),
    }))?.value).toBe("do-not-leak");
    const listedVariables = await request(
      `/api/v2/varsets/${variableSetId}/relationships/vars?page[size]=1`,
    );
    expect(listedVariables.status).toBe(200);
    expect((await listedVariables.json()).data[0].attributes.value).toBeNull();
    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/vars/${variableId}`,
    )).status).toBe(200);
    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/vars/${variableId}`,
      "GET",
      undefined,
      unrelatedToken,
    )).status).toBe(404);

    const hclVariable = await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "POST", {
      data: { type: "vars", attributes: { key: "HCL", value: "true", hcl: true } },
    });
    expect(hclVariable.status).toBe(200);
    const hclData = (await hclVariable.json()).data;
    expect(hclData.attributes.hcl).toBe(true);

    // Regression: PATCH must persist hcl (previously dropped by variableSetVariableUpdate).
    const hclToggle = await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "PATCH", {
      data: { id: hclData.id, type: "vars", attributes: { hcl: false } },
    });
    expect(hclToggle.status).toBe(200);
    expect((await hclToggle.json()).data.attributes.hcl).toBe(false);

    const stillSensitive = await request(
      `/api/v2/varsets/${variableSetId}/relationships/vars`,
      "PATCH",
      { data: { id: variableId, type: "vars", attributes: { sensitive: false, description: "renamed" } } },
    );
    expect(stillSensitive.status).toBe(200);
    expect((await stillSensitive.json()).data.attributes).toMatchObject({
      value: null,
      sensitive: true,
      description: "renamed",
    });

    const revealed = await request(
      `/api/v2/varsets/${variableSetId}/relationships/vars`,
      "PATCH",
      { data: [{ id: variableId, type: "vars", attributes: { value: "replacement", sensitive: false } }] },
    );
    expect(revealed.status).toBe(200);
    expect((await revealed.json()).data[0].attributes).toMatchObject({
      value: "replacement",
      sensitive: false,
    });

    const duplicate = await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "POST", {
      data: { type: "vars", attributes: { key: "TF_TOKEN", value: "duplicate" } },
    });
    expect(duplicate.status, await duplicate.clone().text()).toBe(422);
    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/vars`,
      "PATCH",
      { data: { id: variableId, type: "vars", attributes: { value: "cross-org" } } },
      unrelatedToken,
    )).status).toBe(404);

    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/workspaces`,
      "DELETE",
      { data: [{ id: workspaceIds[1], type: "workspaces" }] },
    )).status).toBe(204);
    expect(await db.query.variableSetWorkspaces.findMany({
      where: eq(variableSetWorkspaces.variableSetId, variableSetId),
    })).toHaveLength(1);

    expect((await request(
      `/api/v2/varsets/${variableSetId}/relationships/vars`,
      "DELETE",
      { data: [{ id: variableId, type: "vars" }] },
    )).status).toBe(204);
    expect(await db.query.variableSetVariables.findFirst({
      where: eq(variableSetVariables.id, variableId),
    })).toBeUndefined();

    expect((await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "POST", {
      data: { type: "vars", attributes: { key: "CASCADE", value: "yes" } },
    })).status).toBe(200);

    // VAR-007: JSON:API empty bulk relationship arrays are no-ops, not 422s
    // (the reference format parity). Only endpoints that exist for each relation type are
    // exercised; the property under test is the empty-array handling.
    const emptyWorkspacePost = await request(`/api/v2/varsets/${variableSetId}/relationships/workspaces`, "POST", { data: [] });
    expect(emptyWorkspacePost.status, await emptyWorkspacePost.clone().text()).toBe(204);
    const emptyDeleteVars = await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "DELETE", { data: [] });
    expect(emptyDeleteVars.status, await emptyDeleteVars.clone().text()).toBe(204);
    const emptyDeleteProjects = await request(`/api/v2/varsets/${variableSetId}/relationships/projects`, "DELETE", { data: [] });
    expect(emptyDeleteProjects.status, await emptyDeleteProjects.clone().text()).toBe(204);
    const emptyDeleteStacks = await request(`/api/v2/varsets/${variableSetId}/relationships/stacks`, "DELETE", { data: [] });
    expect(emptyDeleteStacks.status, await emptyDeleteStacks.clone().text()).toBe(204);

    // Missing data field (not an empty array) is still rejected.
    const missingData = await request(`/api/v2/varsets/${variableSetId}/relationships/workspaces`, "POST", {});
    expect(missingData.status).toBe(422);

    // VAR-007: duplicate resource ids in a bulk PATCH body are rejected (422).
    const duplicateBulk = await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "PATCH", {
      data: [
        { id: variableId, type: "vars", attributes: { value: "first" } },
        { id: variableId, type: "vars", attributes: { value: "second" } },
      ],
    });
    expect(duplicateBulk.status).toBe(422);

    expect((await request(`/api/v2/varsets/${variableSetId}`, "DELETE")).status).toBe(204);
    expect(await db.query.variableSets.findFirst({ where: eq(variableSets.id, variableSetId) })).toBeUndefined();
    expect(await db.query.variableSetVariables.findMany({
      where: eq(variableSetVariables.variableSetId, variableSetId),
    })).toHaveLength(0);
    expect(await db.query.variableSetWorkspaces.findMany({
      where: eq(variableSetWorkspaces.variableSetId, variableSetId),
    })).toHaveLength(0);
  });
});
