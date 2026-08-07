import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { workspaceVariables, workspaces, runs, stateVersions } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - Runs", () => {
  let workspaceId = "";
  let userToken: string;

  beforeAll(async () => {
    // Clear and setup
    const { configurationVersions, users, apiTokens, logs, workspaceTags, organizationMemberships, organizations } = await import("../../src/db/schema");
    await db.delete(logs);
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables);
    await db.delete(workspaceTags);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(apiTokens);
    await db.delete(users).where(eq(users.username, "run-owner"));

    await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "run-owner", password: "securepassword" } },
        }),
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "run-owner", password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    // Create org via API so ownership membership is established
    const orgName = `homelab-runs-${Date.now()}`;
    const orgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: orgName } }
        })
      })
    );
    expect(orgRes.status).toBe(201);
    const orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";

    const ws = await db.insert(workspaces).values({
      id: "ws-run-test",
      name: "run-workspace",
      orgId: orgId,
      autoApply: false
    }).returning();
    workspaceId = ws[0]!.id;
  });

  it("should create a run", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: {
              message: "Custom run message",
              "auto-apply": true,
            },
            relationships: {
              workspace: {
                data: {
                  id: workspaceId,
                  type: "workspaces",
                },
              },
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("runs");
    expect(data.data.attributes.status).toBe("pending");
    expect(data.data.attributes.message).toBe("Custom run message");
    expect(data.data.attributes["auto-apply"]).toBe(true);
    expect(data.data.attributes.actions["is-force-cancelable"]).toBe(false);
    expect(data.data.attributes.permissions["can-force-cancel"]).toBe(false);

    const runInDb = await db.query.runs.findFirst({
      where: eq(runs.id, data.data.id),
    });
    expect(runInDb).toBeDefined();
    expect(runInDb?.status).toBe("pending");
    expect(runInDb?.autoApply).toBe(true);
  });

  it("should include created-by with included user data when fetching a single run", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: { message: "Test single run creator" },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
            },
          },
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { data: { id: string } };
    const runId = created.data.id;

    const response = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}`, {
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(response.status).toBe(200);
    const document = await response.json() as {
      data: { id: string; relationships?: Record<string, unknown> };
      included?: { id: string; type: string; attributes: Record<string, unknown> }[];
    };

    expect(document.data.relationships).toBeDefined();
    expect(document.data.relationships!["created-by"]).toBeDefined();
    const createdBy = document.data.relationships!["created-by"] as { data: { id: string; type: string } | null };
    expect(createdBy.data).toBeDefined();
    expect(createdBy.data!.type).toBe("users");

    expect(document.included).toBeDefined();
    expect(document.included!.length).toBeGreaterThan(0);
    const includedUser = document.included!.find((u: { type: string }): boolean => u.type === "users");
    expect(includedUser).toBeDefined();
    expect(includedUser!.attributes.username).toBe("run-owner");
    expect(includedUser!.attributes["avatar-url"]).toMatch(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/);
  });

  it("lists runs with created-by included user data", async () => {
    // Create a run first
    const createRes = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: { message: "Triggered by test user" },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
            },
          },
        }),
      })
    );
    expect(createRes.status).toBe(201);

    // List runs for the workspace
    const listRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/runs`, {
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      data: { id: string; relationships?: { "created-by"?: { data: { id: string; type: string } | null } } }[];
      included?: { id: string; type: string; attributes: { username: string; "avatar-url": string } }[];
    };

    const createdRun = listData.data.find((r) => r.relationships?.["created-by"]?.data?.id !== null);
    expect(createdRun).toBeDefined();
    expect(createdRun!.relationships!["created-by"]!.data!.type).toBe("users");

    // Check that included user data is present
    expect(listData.included).toBeDefined();
    expect(listData.included!.length).toBeGreaterThan(0);
    const includedUser = listData.included!.find((u) => u.type === "users");
    expect(includedUser).toBeDefined();
    expect(includedUser!.attributes.username).toBe("run-owner");
    expect(includedUser!.attributes["avatar-url"]).toMatch(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/);
  });

  it("rejects destroy runs when destroy plans are disabled", async () => {
    const body = JSON.stringify({
      data: {
        type: "runs",
        attributes: {
          "is-destroy": true,
          message: "Destroy plan",
        },
        relationships: {
          workspace: {
            data: {
              id: workspaceId,
              type: "workspaces",
            },
          },
        },
      },
    });
    const createDestroyRun = (path: string): Promise<Response> => app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`,
        },
        body,
      }),
    );

    await db.update(workspaces)
      .set({ allowDestroyPlan: false })
      .where(eq(workspaces.id, workspaceId));

    for (const path of ["/api/v2/runs", `/api/v2/workspaces/${workspaceId}/runs`]) {
      const response = await createDestroyRun(path);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        errors: [{
          status: "422",
          title: "Unprocessable Entity",
          detail: "Destroy plans are disabled for this workspace",
        }],
      });
    }

    await db.update(workspaces)
      .set({ allowDestroyPlan: true })
      .where(eq(workspaces.id, workspaceId));
    const response = await createDestroyRun("/api/v2/runs");
    expect(response.status).toBe(201);
    const document = await response.json() as { data: { id: string; attributes: { "is-destroy": boolean } } };
    expect(document.data.attributes["is-destroy"]).toBe(true);
    expect(await db.query.runs.findFirst({ where: eq(runs.id, document.data.id) })).toMatchObject({
      isDestroy: true,
    });
  });

  it("rejects malformed run variables and unsafe target/replace addresses", async () => {
    const post = (attributes: Record<string, unknown>): Promise<Response> => app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          data: {
            attributes,
            relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
          },
        }),
      }),
    );

    // Variables must be objects with a string key and value.
    for (const variables of [
      [{ key: "foo" }],
      [{ value: "bar" }],
      [{ key: "foo", value: "bar" }, "not-an-object"],
      [{ key: "foo", value: "bar" }, null],
      [{ key: "", value: "bar" }],
      [{ key: "-malicious", value: "bar" }],
      [{ key: "foo", value: "bar\nevil" }],
    ]) {
      const response = await post({ variables });
      expect(response.status).toBe(422);
    }

    // A control-character-free, well-formed variable must be accepted.
    const validVariables = [{ key: "region", value: "us-east-1" }];
    const ok = await post({ variables: validVariables });
    expect(ok.status).toBe(201);

    // Unsafe target/replace addresses must be rejected.
    for (const attrs of [
      { "target-addrs": ["-auto-approve"] },
      { "target-addrs": ["aws_instance.foo bar"] },
      { "target-addrs": ["aws_instance.foo\nbar"] },
      { "target-addrs": "not-an-array" },
      { "replace-addrs": ["--flag"] },
    ]) {
      const response = await post(attrs);
      expect(response.status).toBe(422);
    }

    // A valid address must still be accepted.
    const okAddr = await post({ "target-addrs": ["aws_instance.example"] });
    expect(okAddr.status).toBe(201);

    // Valid indexed for_each addresses (quoted string indexes) must be accepted.
    const okIndexedAddr = await post({ "target-addrs": [`aws_instance.web["example"]`] });
    expect(okIndexedAddr.status).toBe(201);

    // A valid replacement address (indexed) must be accepted.
    const okReplaceAddr = await post({ "replace-addrs": [`aws_instance.web["example"]`] });
    expect(okReplaceAddr.status).toBe(201);
  });
});
