import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";

describe("workspace run history and state metadata", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const otherWorkspaceId = `other-workspace-${suffix}`;
  const token = `token-${suffix}`;
  const runIds = {
    planned: `run-planned-${suffix}`,
    destroy: `run-destroy-${suffix}`,
    applied: `run-applied-${suffix}`,
    old: `run-old-${suffix}`,
    speculative: `run-speculative-${suffix}`,
  };
  const stateId = `state-${suffix}`;
  const now = Date.now();
  const currentYear = new Date(now).getUTCFullYear();
  const state = {
    version: 4,
    terraform_version: "1.8.5",
    serial: 7,
    lineage: suffix,
    outputs: {
      greeting: { value: "hello", type: "string", sensitive: false },
      secret: { value: "swordfish", type: "string", sensitive: true },
    },
    resources: [
      {
        mode: "managed",
        type: "null_resource",
        name: "example",
        provider: 'provider["registry.terraform.io/hashicorp/null"]',
        instances: [{}],
      },
      {
        mode: "data",
        type: "terraform_remote_state",
        name: "shared",
        module: "module.child",
        provider: 'provider["terraform.io/builtin/terraform"]',
        instances: [{}, {}],
      },
    ],
  };
  const statePayload = JSON.stringify(state);

  const request = (path: string, authenticated = true) => app.handle(new Request(
    `http://terrence.test${path}`,
    { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} },
  ));
  const runHistory = (query: Record<string, string>) => request(
    `/api/v2/workspaces/${workspaceId}/runs?${new URLSearchParams(query)}`,
  );

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username: `run-state-${suffix}`,
      passwordHash: "unused",
    });
    await db.insert(organizations).values({ id: orgId, name: `run-state-${suffix}` });
    await db.insert(organizationMemberships).values({
      id: `membership-${suffix}`,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({
      id: `token-${suffix}`,
      token: hashAuthenticationToken(token),
      userId,
      description: "run and state contract",
    });
    await db.insert(workspaces).values([
      { id: workspaceId, name: "history", orgId },
      { id: otherWorkspaceId, name: "other", orgId },
    ]);
    await db.insert(runs).values([
      {
        id: runIds.planned,
        workspaceId,
        status: "planned",
        message: "deploy the search-needle",
        isDestroy: false,
        createdAt: now - 1_000,
      },
      {
        id: runIds.destroy,
        workspaceId,
        status: "planning",
        message: "destroy obsolete resources",
        isDestroy: true,
        operation: "destroy",
        createdAt: now - 2_000,
      },
      {
        id: runIds.applied,
        workspaceId,
        status: "applied",
        message: "release complete",
        isDestroy: false,
        createdAt: now - 3_000,
      },
      {
        id: runIds.old,
        workspaceId,
        status: "errored",
        message: "historic failure",
        isDestroy: false,
        createdAt: Date.UTC(2019, 6, 1),
      },
      {
        id: `run-other-${suffix}`,
        workspaceId: otherWorkspaceId,
        status: "applied",
        message: "outside workspace scope",
        isDestroy: false,
        createdAt: now,
      },
      {
        id: runIds.speculative,
        workspaceId,
        status: "planned_and_finished",
        message: "speculative CLI plan",
        operation: "plan_and_apply",
        planOnly: true,
        createdAt: now,
      },
    ]);
    await db.insert(stateVersions).values({
      id: stateId,
      workspaceId,
      serial: state.serial,
      statePayload,
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("filters the workspace run query before pagination and count", async () => {
    const cases: [Record<string, string>, string[]][] = [
      [{ "filter[status]": "planned,applied" }, [runIds.planned, runIds.applied]],
      [{ "filter[operation]": "destroy" }, [runIds.destroy]],
      [{ "filter[source]": "tfe-ui" }, []],
      [{ "filter[status_group]": "non_final" }, [runIds.planned, runIds.destroy]],
      [{ "filter[status_group]": "discardable" }, [runIds.planned]],
      [{ "filter[timeframe]": String(currentYear) }, [runIds.planned, runIds.destroy, runIds.applied, runIds.speculative]],
      [{ "filter[timeframe]": "year" }, [runIds.planned, runIds.destroy, runIds.applied, runIds.speculative]],
      [{ "search[basic]": "search-needle" }, [runIds.planned]],
    ];

    for (const [query, expected] of cases) {
      const response = await runHistory(query);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.map((run: any) => run.id).sort()).toEqual(expected.sort());
      expect(body.meta.pagination["total-count"]).toBe(expected.length);
    }

    const filteredPage = await runHistory({
      "filter[status_group]": "final",
      "page[number]": "2",
      "page[size]": "1",
    });
    const page = await filteredPage.json();
    expect(page.data.map((run: any) => run.id)).toEqual([runIds.applied]);
    expect(page.meta.pagination).toMatchObject({
      "current-page": 2,
      "page-size": 1,
      "total-pages": 3,
      "total-count": 3,
    });
    expect(page.links.self).toContain("filter%5Bstatus_group%5D=final");
  });

  it("includes speculative/plan-only runs in the default workspace run history", async () => {
    const response = await runHistory({});
    expect(response.status).toBe(200);
    const body = await response.json();
    const ids = body.data.map((run: any) => run.id);
    expect(ids).toContain(runIds.speculative);
    expect(body.meta.pagination["total-count"]).toBe(ids.length);
    // The speculative run must also be reachable via the explicit operation filter.
    const opResponse = await runHistory({ "filter[operation]": "plan_and_apply" });
    expect(opResponse.status).toBe(200);
    expect((await opResponse.json()).data.map((run: any) => run.id)).toContain(runIds.speculative);
  });

  it("returns derived state metadata and authenticated paginated outputs", async () => {
    const listResponse = await request(`/api/v2/workspaces/${workspaceId}/state-versions`);
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()).data[0];
    expect(listed.attributes).toMatchObject({
      serial: 7,
      md5: createHash("md5").update(statePayload).digest("hex"),
      lineage: suffix,
      "terraform-version": "1.8.5",
      "resources-processed": true,
      "state-version": 4,
      status: "finalized",
    });
    expect(listed.attributes.resources).toContainEqual({
      name: "shared",
      type: "data.terraform_remote_state",
      count: 2,
      module: "module.child",
      provider: 'provider["terraform.io/builtin/terraform"]',
    });
    expect(listed.attributes.modules).toEqual({
      root: { "null-resource": 1 },
      "module.child": { "data.terraform-remote-state": 2 },
    });
    expect(listed.relationships.workspace.data.id).toBe(workspaceId);
    expect(listed.relationships.outputs.data).toHaveLength(2);
    expect(listed.links.self).toBe(`/api/v2/state-versions/${stateId}`);

    const resourcesResponse = await request(`/api/v2/workspaces/${workspaceId}/resources`);
    expect(resourcesResponse.status).toBe(200);
    expect((await resourcesResponse.json()).data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attributes: expect.objectContaining({
          provider: "registry.terraform.io/hashicorp/null",
        }),
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          provider: "terraform.io/builtin/terraform",
        }),
      }),
    ]));

    const showResponse = await request(`/api/v2/state-versions/${stateId}`);
    expect(showResponse.status).toBe(200);
    expect((await showResponse.json()).data.attributes.state).toBe(statePayload);

    const outputsResponse = await request(
      `/api/v2/state-versions/${stateId}/state-version-outputs?page[number]=2&page[size]=1`,
    );
    expect(outputsResponse.status).toBe(200);
    const outputs = await outputsResponse.json();
    expect(outputs.data).toHaveLength(1);
    expect(outputs.data[0]).toMatchObject({
      type: "state-version-outputs",
      attributes: {
        name: "secret",
        value: "swordfish",
        sensitive: true,
        type: "string",
      },
    });
    expect(outputs.meta.pagination).toMatchObject({
      "current-page": 2,
      "page-size": 1,
      "total-pages": 2,
      "total-count": 2,
    });
    expect(outputs.data[0].links.self).toBe(
      `/api/v2/state-version-outputs/${outputs.data[0].id}`,
    );

    const outputResponse = await request(`/api/v2/state-version-outputs/${outputs.data[0].id}`);
    expect(outputResponse.status).toBe(200);
    expect((await outputResponse.json()).data).toEqual(outputs.data[0]);
    expect((await request(
      "/api/v2/state-version-outputs/wsout-missing",
    )).status).toBe(404);
    const outsideUserId = `outside-user-${suffix}`;
    const outsideToken = `outside-token-${suffix}`;
    await db.insert(users).values({
      id: outsideUserId,
      username: `outside-${suffix}`,
      passwordHash: "unused",
    });
    await db.insert(apiTokens).values({
      id: `token-outside-${suffix}`,
      token: hashAuthenticationToken(outsideToken),
      userId: outsideUserId,
    });
    expect((await app.handle(new Request(
      `http://terrence.test/api/v2/state-version-outputs/${outputs.data[0].id}`,
      { headers: { Authorization: `Bearer ${outsideToken}` } },
    ))).status).toBe(404);
    await db.delete(apiTokens).where(eq(apiTokens.id, `token-outside-${suffix}`));
    await db.delete(users).where(eq(users.id, outsideUserId));
    expect((await request(
      `/api/v2/state-version-outputs/${outputs.data[0].id}`,
      false,
    )).status).toBe(401);

    const goTfeOutputs = await request(`/api/v2/state-versions/${stateId}/outputs`);
    expect(goTfeOutputs.status).toBe(200);
    expect((await goTfeOutputs.json()).data).toHaveLength(2);

    const currentOutputs = await request(
      `/api/v2/workspaces/${workspaceId}/current-state-version-outputs`,
    );
    expect(currentOutputs.status).toBe(200);
    expect((await currentOutputs.json()).data).toHaveLength(2);

    expect((await request(
      `/api/v2/state-versions/${stateId}/state-version-outputs`,
      false,
    )).status).toBe(401);
  });
});