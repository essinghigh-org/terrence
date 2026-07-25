import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, users, apiTokens, workspaces, workspaceVariables } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - Variables", () => {
  let userToken: string;
  let workspaceId: string;

  beforeAll(async () => {
    // Need to clean up everything that references orgs/users to avoid FK constraint errors
    const { stateVersions, runs, organizationMemberships } = await import("../../src/db/schema");
    await db.delete(stateVersions);
    await db.delete(runs);
    await db.delete(workspaceVariables);
    await db.delete(workspaceVariables); await db.delete(workspaces);
    await db.delete(organizationMemberships);

    await db.delete(apiTokens);
    await db.delete(organizations);
    await db.delete(users);

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

    await db.insert(organizations).values({ id: "org-vars", name: "var-homelab" });

    workspaceId = crypto.randomUUID();
    await db.insert(workspaces).values({
        id: workspaceId,
        name: "var-workspace",
        orgId: "org-vars"
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
              hcl: false,
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
    expect(data.data[0].attributes.key).toBe("AWS_REGION");
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
              key: "AWS_SECRET_ACCESS_KEY",
              value: "supersecret",
              category: "env",
              hcl: false,
              sensitive: true
            }
          }
        })
      })
    );
    expect(createRes.status).toBe(201);

    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    const sensitiveVar = data.data.find((v: any) => v.attributes.key === "AWS_SECRET_ACCESS_KEY");
    expect(sensitiveVar.attributes.value).toBe(null);
  });
});
