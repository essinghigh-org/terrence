import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, workspaces, workspaceVariables } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - Variables", () => {
  let userToken: string;
  let workspaceId: string;

  beforeAll(async () => {
    // Need to clean up everything that references orgs/users to avoid FK constraint errors
    const { stateVersions, runs, organizationMemberships, configurationVersions, logs, workspaceTags } = await import("../../src/db/schema");
    await db.delete(logs);
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables);
    await db.delete(workspaceTags);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);

    await db.delete(apiTokens);
    await db.delete(users).where(eq(users.username, "var-owner"));

    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "var-owner", password: "securepassword" } },
        }),
      })
    );
    expect(res.status).toBe(201);

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "var-owner", password: "securepassword" } },
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
          data: { type: "organizations", attributes: { name: `var-homelab-${Date.now()}` } }
        })
      })
    );
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).data.id;

    workspaceId = crypto.randomUUID();
    await db.insert(workspaces).values({
        id: workspaceId,
        name: "var-workspace",
        orgId: orgId
    });
  });

  it("should create a variable", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: {
              key: "AWS_REGION",
              value: "us-east-1",
              category: "env",
              sensitive: false
            }
          }
        })
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.type).toBe("vars");
    expect(data.data.attributes.key).toBe("AWS_REGION");
    expect(data.data.attributes.value).toBe("us-east-1");
  });

  it("should list variables", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBe(1);
  });

  it("should hide the value of a sensitive variable", async () => {
    const createRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: {
              key: "SECRET_KEY",
              value: "supersecret",
              category: "terraform",
              sensitive: true
            }
          }
        })
      })
    );
    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    expect(createData.data.attributes.value).toBeNull();

    const getRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    const getData = await getRes.json();
    const sensitiveVar = getData.data.find((v: any) => v.attributes.key === "SECRET_KEY");
    expect(sensitiveVar).toBeDefined();
    expect(sensitiveVar.attributes.value).toBeNull();
  });
});
