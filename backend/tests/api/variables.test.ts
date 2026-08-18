import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, workspaces, workspaceVariables } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("the reference format API v2 - Variables", () => {
  let userToken: string;
  let workspaceId: string;

  beforeAll(async () => {
    // Need to clean up everything that references orgs/users to avoid FK constraint errors
    const { stateVersions, runs, organizationMemberships, configurationVersions, logs, workspaceTags, organizations } = await import("../../src/db/schema");
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

    const orgName = `var-homelab-${Date.now()}`;
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

  it("should PATCH a variable to update hcl, description, and value (VAR-005/006/007)", async () => {
    // Create a non-sensitive tf variable to PATCH.
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
            attributes: { key: "REGION", value: "us-east-1", category: "terraform", sensitive: false }
          }
        })
      })
    );
    expect(createRes.status).toBe(201);
    const varId = (await createRes.json()).data.id;

    // Flip hcl on and add a description (these were never asserted on update).
    const patchRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars/${varId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: { hcl: true, description: "primary region variable", value: "us-west-2" }
          }
        })
      })
    );
    expect(patchRes.status).toBe(200);
    const body: { data: { attributes: { hcl: boolean; description: string; value: string } } } = await patchRes.json();
    expect(body.data.attributes.hcl).toBe(true);
    expect(body.data.attributes.description).toBe("primary region variable");
    expect(body.data.attributes.value).toBe("us-west-2");
  });

  it("protects against silent value loss when downgrading sensitivity without a value (VAR-006)", async () => {
    // the reference format silently discards the stored value when a PATCH sets sensitive: false
    // without providing a new value. Terrence protects the user: when the
    // previous variable was sensitive AND no new value is supplied in the
    // downgrade PATCH, the server keeps `sensitive = true` to prevent the
    // secret value from being exposed as plaintext to users who could see it.
    // This test documents the protective guard.
    const createRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json", "Authorization": `Bearer ${userToken}` },
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: { key: "KEEP_ME", value: "secret-val", category: "terraform", sensitive: true }
          }
        })
      })
    );
    expect(createRes.status).toBe(201);
    const varId = (await createRes.json()).data.id;

    const patchRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars/${varId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/vnd.api+json", "Authorization": `Bearer ${userToken}` },
        body: JSON.stringify({ data: { type: "vars", attributes: { sensitive: false } } })
      })
    );
    expect(patchRes.status).toBe(200);
    const body: { data: { attributes: { sensitive: boolean; value: unknown } } } = await patchRes.json();
    // Guard: server keeps sensitive=true to avoid exposing the secret value.
    expect(body.data.attributes.sensitive).toBe(true);
    // Masked because still sensitive.
    expect(body.data.attributes.value).toBeNull();
  });
});
