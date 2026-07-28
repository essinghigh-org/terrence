import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  policySets,
  users,
} from "../../src/db/schema";

describe("policy set version uploads", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-policy-version-${suffix}`;
  const orgId = `org-policy-version-${suffix}`;
  const orgName = `policy-version-${suffix}`;
  const token = `token-policy-version-${suffix}`;
  let policySetId = "";

  const request = (path: string, method = "GET", body?: BodyInit, authenticated = true): Promise<Response> =>
    app.handle(new Request(new URL(path, "http://terrence.test"), {
      method,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/octet-stream" }),
      },
      ...(body === undefined ? {} : { body }),
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token, userId });
    policySetId = `polset-${crypto.randomUUID()}`;
    await db.insert(policySets).values({ id: policySetId, orgId, name: "Uploaded policies", kind: "opa" });
  });

  afterAll(async () => {
    await db.delete(policySets).where(eq(policySets.id, policySetId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("creates a version, accepts its one-time signed tar.gz upload, and reports ready", async () => {
    const create = await request(`/api/v2/policy-sets/${policySetId}/versions`, "POST");
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.data.attributes.status).toBe("pending");
    const upload = created.data.links.upload as string;
    const versionId = created.data.id as string;
    expect(new URL(upload).searchParams.get("signature")).not.toBeNull();

    const beforeUpload = await request(`/api/v2/policy-set-versions/${versionId}`);
    expect(beforeUpload.status).toBe(200);
    expect((await beforeUpload.json()).data.attributes.status).toBe("pending");

    const archive = gzipSync(Buffer.alloc(1024));
    const uploaded = await request(upload, "PUT", archive, false);
    expect(uploaded.status).toBe(200);
    expect((await uploaded.json()).data.attributes.status).toBe("ready");

    const ready = await request(`/api/v2/policy-set-versions/${versionId}`);
    const readyBody = await ready.json();
    expect(ready.status).toBe(200);
    expect(readyBody.data.attributes.status).toBe("ready");
    expect(readyBody.data.links.upload).toBeUndefined();
    expect(readyBody.data.attributes["status-timestamps"]["ready-at"]).toBeString();

    expect((await request(upload, "PUT", archive, false)).status).toBe(409);
  });

  it("rejects invalid archives and VCS-backed policy sets", async () => {
    const create = await request(`/api/v2/policy-sets/${policySetId}/versions`, "POST");
    const upload = (await create.json()).data.links.upload as string;
    expect((await request(upload, "PUT", "not gzip", false)).status).toBe(422);

    const vcsPolicySetId = `polset-vcs-${crypto.randomUUID()}`;
    await db.insert(policySets).values({
      id: vcsPolicySetId,
      orgId,
      name: "VCS policies",
      vcsRepo: { identifier: "example/policies" },
    });
    expect((await request(`/api/v2/policy-sets/${vcsPolicySetId}/versions`, "POST")).status).toBe(422);
    await db.delete(policySets).where(eq(policySets.id, vcsPolicySetId));
  });
});
