import { describe, expect, it, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { eq } from "drizzle-orm";

describe("the reference format API v2 - Workspaces", () => {
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

  it("should include the current run per workspace when include=current_run is requested", async () => {
    const { runs, workspaces, configurationVersions } = await import("../../src/db/schema");
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.name, "k8s-cluster") });
    expect(workspace).toBeDefined();
    const configurationVersionId = crypto.randomUUID();
    await db.insert(configurationVersions).values({
      id: configurationVersionId,
      workspaceId: workspace?.id ?? "",
      status: "uploaded",
      createdAt: Date.now(),
    });
    const olderRunId = `run-${crypto.randomUUID()}`;
    const newerRunId = `run-${crypto.randomUUID()}`;
    await db.insert(runs).values([
      {
        id: olderRunId,
        workspaceId: workspace?.id ?? "",
        status: "applied",
        message: "Older run",
        configurationVersionId,
        createdAt: Date.now() - 1000,
      },
      {
        id: newerRunId,
        workspaceId: workspace?.id ?? "",
        status: "planning",
        message: "Newer run",
        configurationVersionId,
        createdAt: Date.now(),
      },
    ]);
    try {
      const response = await app.handle(new Request("http://localhost/api/v2/organizations/homelab/workspaces?include=current_run", {
        headers: { Authorization: `Bearer ${userToken}` },
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      const workspaceResource = body.data.find((entry: { id: string }): boolean => entry.id === workspace?.id);
      expect(workspaceResource.relationships["current-run"]).toEqual({ data: { id: newerRunId, type: "runs" } });
      const includedRun = body.included.find((entry: { id: string }): boolean => entry.id === newerRunId);
      expect(includedRun).toBeDefined();
      expect(includedRun.attributes.status).toBe("planning");
      expect(includedRun.attributes.message).toBe("Newer run");
      // SQLite 0/1 integers must be normalized to real booleans in the
      // included run resource.
      expect(includedRun.attributes["is-destroy"]).toBe(false);
      expect(includedRun.attributes["auto-apply"]).toBe(false);
      expect(body.included.some((entry: { id: string }): boolean => entry.id === olderRunId)).toBe(false);

      // Without include, the relationship must stay absent (the reference format default shape).
      const plainResponse = await app.handle(new Request("http://localhost/api/v2/organizations/homelab/workspaces", {
        headers: { Authorization: `Bearer ${userToken}` },
      }));
      const plainBody = await plainResponse.json();
      const plainWorkspace = plainBody.data.find((entry: { id: string }): boolean => entry.id === workspace?.id);
      expect(plainWorkspace.relationships["current-run"]).toBeUndefined();
      expect(plainBody.included).toBeUndefined();
    } finally {
      await db.delete(runs).where(eq(runs.id, olderRunId));
      await db.delete(runs).where(eq(runs.id, newerRunId));
      await db.delete(configurationVersions).where(eq(configurationVersions.id, configurationVersionId));
    }
  });

  it("should return the dependency graph from the latest finalized state", async () => {
    const { stateVersions, workspaces } = await import("../../src/db/schema");
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.name, "k8s-cluster") });
    expect(workspace).toBeDefined();
    const stateVersionId = crypto.randomUUID();
    const olderStateVersionId = crypto.randomUUID();
    const pendingStateVersionId = crypto.randomUUID();
    const state = JSON.stringify({
      version: 4,
      serial: 2,
      resources: [
        { mode: "managed", type: "aws_vpc", name: "main", instances: [{ dependencies: [] }] },
        { mode: "managed", type: "aws_subnet", name: "web", instances: [{ dependencies: ["aws_vpc.main"] }] },
      ],
    });
    await db.insert(stateVersions).values({
      id: olderStateVersionId,
      workspaceId: workspace?.id ?? "",
      serial: 1,
      statePayload: JSON.stringify({ version: 4, serial: 1, resources: [{ mode: "managed", type: "null_resource", name: "older", instances: [{ dependencies: [] }] }] }),
      jsonState: JSON.stringify({ version: 4, serial: 1, resources: [{ mode: "managed", type: "null_resource", name: "older", instances: [{ dependencies: [] }] }] }),
      status: "finalized",
      intermediate: false,
      createdAt: Date.now() - 1,
    });
    await db.insert(stateVersions).values({
      id: stateVersionId,
      workspaceId: workspace?.id ?? "",
      serial: 2,
      statePayload: state,
      jsonState: state,
      status: "finalized",
      intermediate: false,
      createdAt: Date.now(),
    });
    await db.insert(stateVersions).values({
      id: pendingStateVersionId,
      workspaceId: workspace?.id ?? "",
      serial: 3,
      statePayload: JSON.stringify({ version: 4, serial: 3, resources: [] }),
      jsonState: JSON.stringify({ version: 4, serial: 3, resources: [] }),
      status: "pending",
      intermediate: false,
      createdAt: Date.now() + 1,
    });

    try {
      const response = await app.handle(new Request("http://localhost/api/v2/workspaces/" + workspace?.id + "/dependency-graph", {
        headers: { Authorization: `Bearer ${userToken}` },
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.attributes.nodes).toEqual([
        { address: "aws_vpc.main", dependencies: [] },
        { address: "aws_subnet.web", dependencies: ["aws_vpc.main"] },
      ]);
      expect(body.data.attributes.edges).toEqual([{ from: "aws_vpc.main", to: "aws_subnet.web" }]);
    } finally {
      await db.delete(stateVersions).where(eq(stateVersions.id, olderStateVersionId));
      await db.delete(stateVersions).where(eq(stateVersions.id, stateVersionId));
      await db.delete(stateVersions).where(eq(stateVersions.id, pendingStateVersionId));
    }
  });
});
