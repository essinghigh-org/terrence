import { describe, expect, it, beforeEach } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, organizations, organizationMemberships, projects, workspaces, workspaceVariables, variableSets, variableSetProjects, stateVersions, configurationVersions, runs, apiTokens } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("Epics 6, 7 & 8 API Features: Global Vars, Variable Sets, State & CV Enhancements", () => {
  let userToken: string;
  let userId: string;
  let orgName: string;
  let orgId: string;
  let projectId: string;
  let workspaceId: string;

  beforeEach(async () => {
    await db.delete(apiTokens);
    await db.delete(variableSetProjects);
    await db.delete(variableSets);
    await db.delete(workspaceVariables);
    await db.delete(stateVersions);
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(workspaces);
    await db.delete(projects);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(users);

    userId = `usr-${crypto.randomUUID()}`;
    userToken = `test-user-token-${crypto.randomUUID()}`;
    orgName = `epic678-org-${crypto.randomUUID().substring(0, 8)}`;
    orgId = `org-${crypto.randomUUID()}`;
    projectId = `proj-${crypto.randomUUID()}`;
    workspaceId = `ws-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: "epic678_admin",
      email: "admin@epic678.local",
      passwordHash: "hashed",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: hashAuthenticationToken(userToken),
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
    });

    await db.insert(organizationMemberships).values({
      id: `orgmem-admin`,
      orgId,
      userId,
      role: "owner",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Platform Infra",
    });

    await db.insert(workspaces).values({
      id: workspaceId,
      name: "prod-db",
      orgId,
      projectId,
      autoApply: false,
      terraformVersion: "latest",
    });
  });

  it("supports deprecated global /vars API endpoints", async () => {
    const postRes = await app.handle(
      new Request("http://localhost/api/v2/vars", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: {
              key: "DB_HOST",
              value: "postgres.internal",
              category: "terraform",
              sensitive: false,
            },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
            },
          },
        }),
      })
    );
    expect(postRes.status).toBe(201);
    const postBody = await postRes.json();
    const varId = postBody.data.id;

    const listRes = await app.handle(
      new Request("http://localhost/api/v2/vars", {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBe(1);
    expect(listBody.data[0].attributes.key).toBe("DB_HOST");

    const patchRes = await app.handle(
      new Request(`http://localhost/api/v2/vars/${varId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: { attributes: { value: "pg-cluster.internal" } },
        }),
      })
    );
    expect(patchRes.status).toBe(200);

    const delRes = await app.handle(
      new Request(`http://localhost/api/v2/vars/${varId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(delRes.status).toBe(204);
  });

  it("bounds and paginates the global vars listing", async () => {
    await db.insert(workspaceVariables).values(Array.from({ length: 21 }, (_, index) => ({
      id: `var-pagination-${String(index).padStart(2, "0")}`,
      workspaceId,
      key: `KEY_${String(index).padStart(2, "0")}`,
      value: `value-${index}`,
      sensitive: false,
      hcl: false,
      category: "terraform",
      description: null,
    })));

    const listRes = await app.handle(
      new Request("http://localhost/api/v2/vars?page[number]=2&page[size]=5", {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data).toHaveLength(5);
    expect(listBody.data.map((item: { attributes: { key: string } }): string => item.attributes.key)).toEqual([
      "KEY_05",
      "KEY_06",
      "KEY_07",
      "KEY_08",
      "KEY_09",
    ]);
    expect(listBody.meta.pagination).toEqual({
      "current-page": 2,
      "page-size": 5,
      "prev-page": 1,
      "next-page": 3,
      "total-pages": 5,
      "total-count": 21,
    });
  });

  it("supports variable set project attachments and priority attributes", async () => {
    const createVs = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/varsets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "varsets",
            attributes: {
              name: "Global Secrets",
              priority: true,
            },
          },
        }),
      })
    );
    expect(createVs.status).toBe(201);
    const vsBody = await createVs.json();
    const varsetId = vsBody.data.id;
    expect(vsBody.data.attributes.priority).toBe(true);

    const attachProj = await app.handle(
      new Request(`http://localhost/api/v2/varsets/${varsetId}/relationships/projects`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: [{ id: projectId, type: "projects" }],
        }),
      })
    );
    expect(attachProj.status).toBe(204);

    const getVs = await app.handle(
      new Request(`http://localhost/api/v2/varsets/${varsetId}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(getVs.status).toBe(200);
    const getVsBody = await getVs.json();
    expect(getVsBody.data.attributes["project-count"]).toBe(1);
  });

  it("handles state version json downloads and discard deletion", async () => {
    const svId = `sv-${crypto.randomUUID()}`;
    await db.insert(stateVersions).values({
      id: svId,
      workspaceId,
      serial: 1,
      statePayload: JSON.stringify({ version: 4, lineage: "lin-1", resources: [] }),
      jsonState: JSON.stringify({ format_version: "1.0", values: {} }),
      status: "finalized",
    });

    const jsonRes = await app.handle(
      new Request(`http://localhost/api/v2/state-versions/${svId}/json-download`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(jsonRes.status).toBe(200);
    const jsonText = await jsonRes.text();
    expect(jsonText).toContain("format_version");

    const delRes = await app.handle(
      new Request(`http://localhost/api/v2/state-versions/${svId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(delRes.status).toBe(204);

    const updatedSv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, svId) });
    expect(updatedSv?.status).toBe("discarded");
  });
});