import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  oauthTokens,
  organizationMemberships,
  organizations,
  policies,
  policyChecks,
  policySets,
  runs,
  users,
  workspaces,
} from "../../src/db/schema";

describe("VCS OAuth & Policy as Code (Sentinel/OPA) API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `vcspol-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const workspaceId = `ws-pol-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("creates, lists, updates, and deletes VCS OAuth Clients and Tokens", async () => {
    // 1. Create OAuth client
    const createOcRes = await request(`/api/v2/organizations/${orgName}/oauth-clients`, "POST", {
      data: {
        attributes: {
          name: "GitHub Enterprise",
          "service-provider": "github",
          "api-url": "https://api.github.com",
          "http-url": "https://github.com",
        },
      },
    });
    expect(createOcRes.status).toBe(201);
    const createOcBody = await createOcRes.json();
    const ocId = createOcBody.data.id;
    expect(createOcBody.data.attributes.name).toBe("GitHub Enterprise");

    // 2. List OAuth clients
    const listOcRes = await request(`/api/v2/organizations/${orgName}/oauth-clients`);
    expect(listOcRes.status).toBe(200);
    const listOcBody = await listOcRes.json();
    expect(listOcBody.data.some((oc: any) => oc.id === ocId)).toBeTrue();

    // 3. Insert OAuth token in DB & list via API
    const otId = `ot-${crypto.randomUUID()}`;
    await db.insert(oauthTokens).values({
      id: otId,
      oauthClientId: ocId,
      serviceProviderUser: "octocat",
      token: "ghp_secret_token_12345",
      createdAt: Date.now(),
    });

    const listOtRes = await request(`/api/v2/oauth-clients/${ocId}/oauth-tokens`);
    expect(listOtRes.status).toBe(200);
    const listOtBody = await listOtRes.json();
    expect(listOtBody.data.some((ot: any) => ot.id === otId)).toBeTrue();

    // 4. Delete OAuth token and OAuth client
    const deleteOtRes = await request(`/api/v2/oauth-tokens/${otId}`, "DELETE");
    expect(deleteOtRes.status).toBe(204);

    const deleteOcRes = await request(`/api/v2/oauth-clients/${ocId}`, "DELETE");
    expect(deleteOcRes.status).toBe(204);
  });

  it("creates, lists, updates policy sets, policies, and policy checks", async () => {
    // 1. Create policy set
    const createPsRes = await request(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
      data: {
        attributes: {
          name: "Security Standard",
          description: "Mandatory security rules",
          kind: "opa",
          global: true,
        },
      },
    });
    expect(createPsRes.status).toBe(201);
    const createPsBody = await createPsRes.json();
    const psId = createPsBody.data.id;
    expect(createPsBody.data.attributes.name).toBe("Security Standard");

    // 2. Add individual policy to policy set
    const createPolRes = await request(`/api/v2/policy-sets/${psId}/policies`, "POST", {
      data: {
        attributes: {
          name: "No Public S3 Buckets",
          description: "Block public access to S3",
          "enforcement-level": "soft-mandatory",
          query: "data.terraform.s3.deny",
        },
      },
    });
    expect(createPolRes.status).toBe(201);
    const createPolBody = await createPolRes.json();
    const polId = createPolBody.data.id;
    expect(createPolBody.data.attributes.name).toBe("No Public S3 Buckets");

    // 3. Attach workspace to policy set
    const attachWsRes = await request(`/api/v2/policy-sets/${psId}/relationships/workspaces`, "POST", {
      data: [{ id: workspaceId, type: "workspaces" }],
    });
    expect(attachWsRes.status).toBe(204);

    const workspaceSetsRes = await request(`/api/v2/workspaces/${workspaceId}/policy-sets`);
    expect(workspaceSetsRes.status).toBe(200);
    const workspaceSetsBody = await workspaceSetsRes.json();
    expect(workspaceSetsBody.data).toContainEqual(expect.objectContaining({
      id: psId,
      attributes: expect.objectContaining({
        name: "Security Standard",
        scope: "global",
        "policy-count": 1,
      }),
    }));

    // 4. Create run & policy check
    const runId = `run-pol-${suffix}`;
    await db.insert(runs).values({
      id: runId,
      workspaceId,
      status: "policy_checking",
      createdAt: Date.now(),
    });

    const pcId = `pc-${suffix}`;
    await db.insert(policyChecks).values({
      id: pcId,
      runId,
      policyId: polId,
      policySetId: psId,
      status: "soft_failed",
      result: { passed: false, policy: "No Public S3 Buckets" },
      createdAt: Date.now(),
    });

    // 5. Query policy checks for run
    const getRunPcRes = await request(`/api/v2/runs/${runId}/policy-checks`);
    expect(getRunPcRes.status).toBe(200);
    const getRunPcBody = await getRunPcRes.json();
    expect(getRunPcBody.data[0].attributes.status).toBe("soft_failed");
    expect(getRunPcBody.data[0].attributes["policy-name"]).toBe("No Public S3 Buckets");
    expect(getRunPcBody.data[0].attributes["enforcement-level"]).toBe("soft-mandatory");

    // 6. Override policy check
    const overrideRes = await request(`/api/v2/policy-checks/${pcId}/actions/override`, "POST");
    expect(overrideRes.status).toBe(200);
    const overrideBody = await overrideRes.json();
    expect(overrideBody.data.attributes.status).toBe("overridden");

    // Clean up
    await db.delete(policyChecks).where(eq(policyChecks.id, pcId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(policies).where(eq(policies.id, polId));
    await db.delete(policySets).where(eq(policySets.id, psId));
  });
});
