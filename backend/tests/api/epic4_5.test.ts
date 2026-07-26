import { describe, expect, it, beforeEach } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, organizations, organizationMemberships, projects, projectTags, workspaces, workspaceTags, remoteStateConsumers, dataRetentionPolicies, configurationVersions, apiTokens } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("Epic 4 & 5 Projects, Workspaces, Remote State Consumers & Retention Policies", () => {
  let userToken: string;
  let userId: string;
  let orgName: string;
  let orgId: string;
  let projectId: string;
  let workspaceId: string;

  beforeEach(async () => {
    await db.delete(apiTokens);
    await db.delete(dataRetentionPolicies);
    await db.delete(remoteStateConsumers);
    await db.delete(configurationVersions);
    await db.delete(workspaceTags);
    await db.delete(workspaces);
    await db.delete(projectTags);
    await db.delete(projects);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(users);

    userId = `usr-${crypto.randomUUID()}`;
    userToken = `test-user-token-${crypto.randomUUID()}`;
    orgName = `epic45-org-${crypto.randomUUID().substring(0, 8)}`;
    orgId = `org-${crypto.randomUUID()}`;
    projectId = `proj-${crypto.randomUUID()}`;
    workspaceId = `ws-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: "epic45_owner",
      email: "owner@epic45.local",
      passwordHash: "hashed",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: userToken,
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
    });

    await db.insert(organizationMemberships).values({
      id: `orgmem-owner`,
      orgId,
      userId,
      role: "owner",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Core Project",
      description: "Infrastructure Core",
      defaultExecutionMode: "remote",
      createdAt: Date.now(),
    });

    await db.insert(workspaces).values({
      id: workspaceId,
      name: "prod-cluster",
      orgId,
      projectId,
      autoApply: false,
      terraformVersion: "latest",
      createdAt: Date.now(),
    });
  });

  it("manages project tag bindings and computes effective workspace tag bindings with inheritance", async () => {
    // Add tag to project
    const postProjTag = await app.handle(
      new Request(`http://localhost/api/v2/projects/${projectId}/tag-bindings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: [
            { attributes: { key: "environment", value: "production" } },
            { attributes: { key: "cost-center", value: "finance" } },
          ],
        }),
      })
    );
    expect(postProjTag.status).toBe(201);

    // Add direct tag to workspace
    await db.insert(workspaceTags).values({
      id: `wtag-1`,
      workspaceId,
      key: "team",
      value: "sre",
    });

    // Fetch workspace effective tag bindings
    const effRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/effective-tag-bindings`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(effRes.status).toBe(200);
    const effBody = await effRes.json();
    const tagKeys = effBody.data.map((t: any) => t.attributes.key);
    expect(tagKeys).toContain("cost-center");
    expect(tagKeys).toContain("environment");
    expect(tagKeys).toContain("team");
  });

  it("manages workspace remote state consumers relationships", async () => {
    const consumerWsId = `ws-consumer-${crypto.randomUUID()}`;
    await db.insert(workspaces).values({
      id: consumerWsId,
      name: "app-services",
      orgId,
      projectId,
      autoApply: false,
      terraformVersion: "latest",
    });

    const addRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/remote-state-consumers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: [{ id: consumerWsId, type: "workspaces" }],
        }),
      })
    );
    expect(addRes.status).toBe(204);

    const getRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/remote-state-consumers`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.length).toBe(1);
    expect(getBody.data[0].id).toBe(consumerWsId);
  });

  it("manages workspace data retention policy lifecycle", async () => {
    const postRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/data-retention-policy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              "state-versions-count": 10,
              "auto-destroy-activity-duration": "30d",
            },
          },
        }),
      })
    );
    expect(postRes.status).toBe(201);
    const postBody = await postRes.json();
    expect(postBody.data.attributes["state-versions-count"]).toBe(10);

    const getRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/data-retention-policy`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.attributes["state-versions-count"]).toBe(10);

    const delRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/relationships/data-retention-policy`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(delRes.status).toBe(204);
  });

  it("returns configuration version ingress attributes", async () => {
    const cvId = `cv-${crypto.randomUUID()}`;
    await db.insert(configurationVersions).values({
      id: cvId,
      workspaceId,
      status: "uploaded",
      source: "vcs",
      ingressAttributes: {
        commitSha: "abc1234",
        branch: "main",
        commitMessage: "Deploy infrastructure",
        senderUsername: "octocat",
      },
    });

    const res = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/ingress-attributes`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes["commit-sha"]).toBe("abc1234");
    expect(body.data.attributes.branch).toBe("main");
  });
});
