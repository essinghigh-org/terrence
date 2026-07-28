import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, registryModules, registryModuleVersions } from "../../src/db/schema";

describe("Module Deprecation, Revocation & Tests API", () => {
  let token: string;
  let moduleId: string;
  let versionId: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    moduleId = `mod-${crypto.randomUUID()}`;
    versionId = `ver-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: `user_${Date.now()}`,
      passwordHash: "hash",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: tokenVal,
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: `org-${crypto.randomUUID()}`,
    });

    await db.insert(organizationMemberships).values({
      id: `om-${crypto.randomUUID()}`,
      userId,
      orgId,
      role: "owner",
      status: "active",
    });

    await db.insert(registryModules).values({
      id: moduleId,
      orgId,
      namespace: `acme_${Date.now()}`,
      name: "vpc",
      provider: "aws",
      createdAt: Date.now(),
    });

    await db.insert(registryModuleVersions).values({
      id: versionId,
      moduleId,
      version: "1.0.0",
      status: "ok",
      createdAt: Date.now(),
    });

    token = tokenVal;
  });

  test("POST /registry-module-versions/:id/actions/revoke revokes module version", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/registry-module-versions/${versionId}/actions/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.attributes.status).toBe("revoked");
    expect(json.data.attributes.revoked).toBe(true);
  });

  test("POST /registry-modules/:module_id/versions/:version/actions/test triggers module test", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/registry-modules/${moduleId}/versions/1.0.0/actions/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.attributes.status).toBe("passed");
  });
});
