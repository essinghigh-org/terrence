import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  oauthClients,
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
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${auth}`,
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([{ id: crypto.randomUUID(), userId, orgId, role: "owner" }]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token: hashAuthenticationToken(token), userId }]);
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

  it("refuses to delete an OAuth client referenced by a workspace", async () => {
    const createOcRes = await request(`/api/v2/organizations/${orgName}/oauth-clients`, "POST", {
      data: { attributes: { name: "In-use OAuth", "service-provider": "github" } },
    });
    expect(createOcRes.status).toBe(201);
    const { data: client } = (await createOcRes.json()) as { data: { id: string } };
    const tokenId = `ot-in-use-${crypto.randomUUID()}`;
    const inUseWorkspaceId = `ws-in-use-${crypto.randomUUID()}`;
    await db.insert(oauthTokens).values({
      id: tokenId,
      oauthClientId: client.id,
      token: "ghp_in_use_token",
      createdAt: Date.now(),
    });
    await db.insert(workspaces).values({
      id: inUseWorkspaceId,
      orgId,
      name: "oauth-connected-workspace",
      vcsRepo: { identifier: "acme/repository", oauthTokenId: tokenId },
    });

    const blocked = await request(`/api/v2/oauth-clients/${client.id}`, "DELETE");
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { errors?: { detail?: string }[] };
    expect(blockedBody.errors?.[0]?.detail).toContain("oauth-connected-workspace");

    const tokenBlocked = await request(`/api/v2/oauth-tokens/${tokenId}`, "DELETE");
    expect(tokenBlocked.status).toBe(409);

    await db.delete(workspaces).where(eq(workspaces.id, inUseWorkspaceId));
    await db.delete(oauthTokens).where(eq(oauthTokens.id, tokenId));
    const removed = await request(`/api/v2/oauth-clients/${client.id}`, "DELETE");
    expect(removed.status).toBe(204);
  });

  it("keeps OAuth client and token deletion safe when workspace references race them", async () => {
    const clientId = `oc-race-${crypto.randomUUID()}`;
    const clientTokenId = `ot-race-client-${crypto.randomUUID()}`;
    const clientWorkspaceName = `race-client-${crypto.randomUUID()}`;
    await db.insert(oauthClients).values({
      id: clientId,
      orgId,
      name: "Racing OAuth client",
      serviceProvider: "github",
      createdAt: Date.now(),
    });
    await db.insert(oauthTokens).values({
      id: clientTokenId,
      oauthClientId: clientId,
      token: "race-client-token",
      createdAt: Date.now(),
    });

    const [clientReference, clientDeletion] = await Promise.all([
      request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
        data: {
          attributes: {
            name: clientWorkspaceName,
            "vcs-repo": { identifier: "acme/repository", "oauth-token-id": clientTokenId },
          },
        },
      }),
      request(`/api/v2/oauth-clients/${clientId}`, "DELETE"),
    ]);
    const storedClient = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) });
    const storedClientWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.name, clientWorkspaceName),
    });
    expect(storedClient === undefined && storedClientWorkspace !== undefined).toBe(false);
    if (storedClient === undefined) {
      expect(clientReference.status).toBe(422);
      expect(clientDeletion.status).toBe(204);
    } else {
      expect(clientReference.status).toBe(201);
      expect(clientDeletion.status).toBe(409);
    }

    const tokenClientId = `oc-race-token-${crypto.randomUUID()}`;
    const tokenId = `ot-race-token-${crypto.randomUUID()}`;
    const tokenWorkspaceName = `race-token-${crypto.randomUUID()}`;
    await db.insert(oauthClients).values({
      id: tokenClientId,
      orgId,
      name: "Racing OAuth token client",
      serviceProvider: "github",
      createdAt: Date.now(),
    });
    await db.insert(oauthTokens).values({
      id: tokenId,
      oauthClientId: tokenClientId,
      token: "race-token",
      createdAt: Date.now(),
    });

    const [tokenReference, tokenDeletion] = await Promise.all([
      request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
        data: {
          attributes: {
            name: tokenWorkspaceName,
            "vcs-repo": { identifier: "acme/repository", "oauth-token-id": tokenId },
          },
        },
      }),
      request(`/api/v2/oauth-tokens/${tokenId}`, "DELETE"),
    ]);
    const storedToken = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, tokenId) });
    const storedTokenWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.name, tokenWorkspaceName),
    });
    expect(storedToken === undefined && storedTokenWorkspace !== undefined).toBe(false);
    if (storedToken === undefined) {
      expect(tokenReference.status).toBe(422);
      expect(tokenDeletion.status).toBe(204);
    } else {
      expect(tokenReference.status).toBe(201);
      expect(tokenDeletion.status).toBe(409);
    }

    await db.delete(workspaces).where(eq(workspaces.name, clientWorkspaceName));
    await db.delete(workspaces).where(eq(workspaces.name, tokenWorkspaceName));
    await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
    await db.delete(oauthClients).where(eq(oauthClients.id, tokenClientId));
  });

  it("validates all policy attachments before creating or mutating a set", async () => {
    const sourceId = `source-${suffix}`;
    const targetId = `target-${suffix}`;
    const tfpolicyId = `tfpolicy-${suffix}`;
    const sentinelId = `sentinel-${suffix}`;
    const opaId = `opa-${suffix}`;
    const otherOrgId = `other-org-${suffix}`;
    const foreignId = `foreign-policy-${suffix}`;
    await db.insert(organizations).values({ id: otherOrgId, name: otherOrgId });
    await db.insert(policySets).values([
      { id: sourceId, orgId, name: sourceId, kind: "sentinel" },
      { id: targetId, orgId, name: targetId, kind: "sentinel" },
      { id: tfpolicyId, orgId, name: tfpolicyId, kind: "tfpolicy" },
    ]);
    await db.insert(policies).values([
      { id: sentinelId, orgId, name: sentinelId, kind: "sentinel", policySetId: sourceId },
      { id: opaId, orgId, name: opaId, kind: "opa" },
      { id: foreignId, orgId: otherOrgId, name: foreignId, kind: "sentinel" },
    ]);
    const ref = (id: string) => ({ id, type: "policies" });
    try {
      const invalidBatches = [
        [ref(sentinelId), ref(opaId)],
        [ref(sentinelId), ref("missing-policy")],
        [ref(sentinelId), ref(foreignId)],
        [ref(sentinelId), { id: opaId, type: "workspaces" }],
        [ref(sentinelId), null],
      ];
      for (const refs of invalidBatches) {
        const attached = await request(`/api/v2/policy-sets/${targetId}/relationships/policies`, "POST", {
          data: refs,
        });
        expect(attached.status).toBe(422);
        const before = await db.query.policySets.findMany({ where: eq(policySets.orgId, orgId) });
        const created = await request(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
          data: {
            type: "policy-sets",
            attributes: { name: "Invalid attachment", kind: "sentinel" },
            relationships: { policies: { data: refs } },
          },
        });
        expect(created.status).toBe(422);
        expect((await db.query.policySets.findMany({ where: eq(policySets.orgId, orgId) })).length).toBe(before.length);
        expect((await db.query.policies.findFirst({ where: eq(policies.id, sentinelId) }))?.policySetId).toBe(sourceId);
        expect((await db.query.policies.findFirst({ where: eq(policies.id, opaId) }))?.policySetId).toBeNull();
      }
      for (const kindId of [sentinelId, opaId]) {
        expect(
          (await request(`/api/v2/policy-sets/${tfpolicyId}/relationships/policies`, "POST", { data: [ref(kindId)] }))
            .status,
        ).toBe(422);
        expect(
          (
            await request(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
              data: {
                attributes: { name: "Invalid tfpolicy attachment", kind: "tfpolicy" },
                relationships: { policies: { data: [ref(kindId)] } },
              },
            })
          ).status,
        ).toBe(422);
      }
      expect((await db.query.policies.findFirst({ where: eq(policies.id, sentinelId) }))?.policySetId).toBe(sourceId);
      expect(
        (await request(`/api/v2/policy-sets/${targetId}/relationships/policies`, "POST", { data: [ref(sentinelId)] }))
          .status,
      ).toBe(204);
      expect((await db.query.policies.findFirst({ where: eq(policies.id, sentinelId) }))?.policySetId).toBe(targetId);
      for (const body of [{}, { data: null }, { data: [null] }, { data: [{ id: sentinelId, type: "workspaces" }] }]) {
        expect((await request(`/api/v2/policy-sets/${targetId}/relationships/policies`, "DELETE", body)).status).toBe(
          422,
        );
        expect((await db.query.policies.findFirst({ where: eq(policies.id, sentinelId) }))?.policySetId).toBe(targetId);
      }
      expect(
        (await request(`/api/v2/policy-sets/${targetId}/relationships/policies`, "DELETE", { data: [] })).status,
      ).toBe(204);
      expect((await db.query.policies.findFirst({ where: eq(policies.id, sentinelId) }))?.policySetId).toBe(targetId);
      // A standard JSON:API removal for an unrelated policy must not detach all.
      expect(
        (await request(`/api/v2/policy-sets/${targetId}/relationships/policies`, "DELETE", { data: [ref(opaId)] }))
          .status,
      ).toBe(204);
      expect((await db.query.policies.findFirst({ where: eq(policies.id, sentinelId) }))?.policySetId).toBe(targetId);
      expect(
        (await request(`/api/v2/policy-sets/${targetId}/relationships/policies`, "DELETE", { data: [ref(sentinelId)] }))
          .status,
      ).toBe(204);
      expect((await db.query.policies.findFirst({ where: eq(policies.id, sentinelId) }))?.policySetId).toBeNull();
      const created = await request(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
        data: {
          attributes: { name: "Valid initial attachment", kind: "opa" },
          relationships: { policies: { data: [ref(opaId)] } },
        },
      });
      expect(created.status).toBe(201);
      const createdId = (await created.json()).data.id;
      expect((await db.query.policies.findFirst({ where: eq(policies.id, opaId) }))?.policySetId).toBe(createdId);
      await request(`/api/v2/policy-sets/${createdId}`, "DELETE");
    } finally {
      await db.delete(policies).where(eq(policies.id, sentinelId));
      await db.delete(policies).where(eq(policies.id, opaId));
      await db.delete(policies).where(eq(policies.id, foreignId));
      await db.delete(organizations).where(eq(organizations.id, otherOrgId));
      for (const id of [sourceId, targetId, tfpolicyId]) await db.delete(policySets).where(eq(policySets.id, id));
    }
  });

  it("round-trips tfpolicy policy sets without falling back to Sentinel semantics", async () => {
    const created = await request(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
      data: { type: "policy-sets", attributes: { name: "Terraform policies", kind: "tfpolicy" } },
    });
    expect(created.status).toBe(201);
    const initial = (await created.json()).data;
    const id = initial.id;
    expect(initial.attributes).toMatchObject({ kind: "tfpolicy", "policy-tool-version": "latest" });
    try {
      const updated = await request(`/api/v2/policy-sets/${id}`, "PATCH", {
        data: {
          type: "policy-sets",
          attributes: { kind: "tfpolicy", "policy-tool-version": "managed", description: "Updated" },
        },
      });
      expect(updated.status).toBe(200);
      const read = await request(`/api/v2/policy-sets/${id}`);
      expect((await read.json()).data.attributes).toMatchObject({
        kind: "tfpolicy",
        "policy-tool-version": "managed",
        description: "Updated",
      });
      const listed = await request(`/api/v2/organizations/${orgName}/policy-sets?filter[kind]=tfpolicy`);
      expect((await listed.json()).data.map((item: { id: string }) => item.id)).toContain(id);
      for (const attribute of ["agent-enabled", "overridable"]) {
        const invalid = await request(`/api/v2/policy-sets/${id}`, "PATCH", {
          data: { attributes: { [attribute]: false } },
        });
        expect(invalid.status).toBe(422);
        const invalidCreate = await request(`/api/v2/organizations/${orgName}/policy-sets`, "POST", {
          data: { attributes: { name: "Invalid tfpolicy", kind: "tfpolicy", [attribute]: false } },
        });
        expect(invalidCreate.status).toBe(422);
      }
      const child = await request(`/api/v2/policy-sets/${id}/policies`, "POST", {
        data: { type: "policies", attributes: { name: "Must not become Sentinel" } },
      });
      expect(child.status).toBe(422);
      const runId = `run-tfpolicy-${suffix}`;
      const checkId = `check-tfpolicy-${suffix}`;
      await db.insert(runs).values({ id: runId, workspaceId, status: "errored", createdAt: Date.now() });
      await db.insert(policyChecks).values({ id: checkId, runId, policySetId: id, status: "unreachable" });
      try {
        expect((await request(`/api/v2/policy-checks/${checkId}/actions/override`, "POST")).status).toBe(409);
        expect((await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, checkId) }))?.status).toBe(
          "unreachable",
        );
      } finally {
        await db.delete(runs).where(eq(runs.id, runId));
      }
    } finally {
      expect((await request(`/api/v2/policy-sets/${id}`, "DELETE")).status).toBe(204);
    }
    expect((await request(`/api/v2/policy-sets/${id}`)).status).toBe(404);
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
        type: "policies",
        attributes: {
          name: "No Public S3 Buckets",
          description: "Block public access to S3",
          enforce: [{ mode: "mandatory" }],
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
    expect(workspaceSetsBody.data).toContainEqual(
      expect.objectContaining({
        id: psId,
        attributes: expect.objectContaining({
          name: "Security Standard",
          scope: "global",
          "policy-count": 1,
        }),
      }),
    );

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
    expect(getRunPcBody.data[0].attributes["enforcement-level"]).toBe("mandatory");

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

  it("filters org policies by kind and name (POL-001)", async () => {
    const opaId = `pol-opa-${suffix}`;
    const sentinelId = `pol-sent-${suffix}`;
    await db.insert(policies).values([
      {
        id: opaId,
        orgId,
        policySetId: null,
        name: "OPA Guardrail",
        kind: "opa",
        enforcementLevel: "mandatory",
        query: "data.terraform.deny",
      },
      {
        id: sentinelId,
        orgId,
        policySetId: null,
        name: "Sentinel Guard",
        kind: "sentinel",
        enforcementLevel: "hard-mandatory",
      },
    ]);

    try {
      // filter[kind]=opa returns only the OPA policy.
      const kindFiltered = await request(`/api/v2/organizations/${orgName}/policies?filter[kind]=opa`);
      expect(kindFiltered.status).toBe(200);
      const kindBody = await kindFiltered.json();
      const kindIds = kindBody.data.map((p: any) => p.id) as string[];
      expect(kindIds).toContain(opaId);
      expect(kindIds).not.toContain(sentinelId);

      // q does a free-text name search.
      const qFiltered = await request(`/api/v2/organizations/${orgName}/policies?q=opa`);
      expect(qFiltered.status).toBe(200);
      const qIds = (await qFiltered.json()).data.map((p: any) => p.id) as string[];
      expect(qIds).toContain(opaId);

      // A kind with no matches returns an empty list.
      const empty = await request(`/api/v2/organizations/${orgName}/policies?filter[kind]=opa&q=does-not-exist`);
      expect(empty.status).toBe(200);
      expect((await empty.json()).data).toEqual([]);

      // Policy-sets list also honors filter[kind] and q.
      const setA = `polset-opa-${suffix}`;
      const setB = `polset-sent-${suffix}`;
      await db.insert(policySets).values([
        { id: setA, orgId, name: "OPA Stack", kind: "opa" },
        { id: setB, orgId, name: "Sentinel Stack", kind: "sentinel" },
      ]);
      try {
        const setKind = await request(`/api/v2/organizations/${orgName}/policy-sets?filter[kind]=sentinel`);
        expect(setKind.status).toBe(200);
        const setKindIds = (await setKind.json()).data.map((s: any) => s.id) as string[];
        expect(setKindIds).toContain(setB);
        expect(setKindIds).not.toContain(setA);

        const setQ = await request(`/api/v2/organizations/${orgName}/policy-sets?q=opa`);
        expect(setQ.status).toBe(200);
        const setQIds = (await setQ.json()).data.map((s: any) => s.id) as string[];
        expect(setQIds).toContain(setA);
        expect(setQIds).not.toContain(setB);
      } finally {
        await db.delete(policySets).where(eq(policySets.id, setA));
        await db.delete(policySets).where(eq(policySets.id, setB));
      }
    } finally {
      await db.delete(policies).where(eq(policies.id, opaId));
      await db.delete(policies).where(eq(policies.id, sentinelId));
    }
  });
});
