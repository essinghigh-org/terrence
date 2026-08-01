import { describe, expect, it, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { eq } from "drizzle-orm";

describe("TFE API v2 - Workspaces", () => {
  let userToken: string;

  beforeAll(async () => {
    // Need to clean up everything that references orgs/users to avoid FK constraint errors
    const { stateVersions, runs, workspaces: wsModel, workspaceVariables, organizationMemberships, apiTokens, users, configurationVersions, logs, workspaceTags } = await import("../../src/db/schema");
    await db.delete(logs);
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables);
    await db.delete(workspaceTags);
    await db.delete(wsModel);
    await db.delete(organizationMemberships);

    await db.delete(apiTokens);
    await db.delete(users).where(eq(users.username, "ws-owner"));

    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "ws-owner", password: "securepassword" } },
        }),
      })
    );
    expect(res.status).toBe(201);

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "ws-owner", password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    const orgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: "homelab" } }
        })
      })
    );
    expect(orgRes.status).toBe(201);
  });

  it("should create a workspace", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/organizations/homelab/workspaces", {
        method: "POST",
        headers: {
           "Content-Type": "application/vnd.api+json",
           "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            type: "workspaces",
            attributes: {
              name: "k8s-cluster",
              "auto-apply": false,
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("workspaces");
    expect(data.data.attributes.name).toBe("k8s-cluster");
  });

  it("should read a workspace by name", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/organizations/homelab/workspaces/k8s-cluster", {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.attributes.name).toBe("k8s-cluster");
  });

  it("should return the README from the most recent run configuration", async () => {
    const { configurationVersions, runs, workspaces } = await import("../../src/db/schema");
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.name, "k8s-cluster") });
    expect(workspace).toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), "terrence-readme-"));
    const archivePath = join(directory, "configuration.tar.gz");
    await writeFile(join(directory, "README.md"), "# Workspace\n\nManaged infrastructure.");
    const archive = Bun.spawn(["tar", "-czf", archivePath, "-C", directory, "README.md"]);
    expect(await archive.exited).toBe(0);
    const configurationVersionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await db.insert(configurationVersions).values({ id: configurationVersionId, workspaceId: workspace?.id ?? "", status: "uploaded", archivePath });
    await db.insert(runs).values({ id: runId, workspaceId: workspace?.id ?? "", configurationVersionId, status: "applied", createdAt: Date.now() + 1 });

    try {
      const response = await app.handle(new Request("http://localhost/api/v2/workspaces/" + workspace?.id + "/readme", {
        headers: { Authorization: `Bearer ${userToken}` },
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.attributes.content).toContain("Managed infrastructure.");
      expect(body.data.attributes["run-id"]).toBe(runId);
    } finally {
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(configurationVersions).where(eq(configurationVersions.id, configurationVersionId));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
