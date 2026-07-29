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
    expect(createdData.relationships.organization.data).toEqual({ id: orgId, type: "organizations" });
    expect(createdData.relationships.parent.data).toEqual({ id: orgId, type: "organizations" });

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

    expect((await request(`/api/v2/varsets/${variableSetId}/relationships/vars`, "POST", {
      data: { type: "vars", attributes: { key: "HCL", value: "true", hcl: true } },
    })).status).toBe(422);

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
