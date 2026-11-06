import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  oauthClients,
  oauthTokens,
  organizationMemberships,
  organizations,
  users,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { decryptSecret } from "../../src/lib/secrets";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";

describe("Azure DevOps Services PAT integration", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-ado-${suffix}`;
  const orgId = `org-ado-${suffix}`;
  const orgName = `ado-${suffix}`;
  const token = `ado-token-${suffix}`;
  let clientId = "";
  let patId = "";
  const request = (method: string, path: string, body?: unknown, auth = token): Promise<Response> =>
    app.handle(
      new Request(`http://terrence.test/api/v2${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/vnd.api+json" },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
  const attributes = {
    name: "Azure",
    "service-provider": "ado_services",
    "ado-org-name": "fabrikam",
    "http-url": "https://dev.azure.com",
    "api-url": "https://dev.azure.com",
    "oauth-token": "test-pat-one",
    secret: "test-webhook-secret",
  };
  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: `orgmem-${suffix}`, userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: `api-${suffix}`, token: hashAuthenticationToken(token), userId });
  });
  afterAll(async () => {
    setExternalUrlTransportForTests(undefined);
    await db.delete(oauthClients).where(eq(oauthClients.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });
  test("creates encrypted PAT without exposing credentials", async () => {
    const response = await request("POST", `/organizations/${orgName}/oauth-clients`, { data: { attributes } });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("test-pat-one");
    expect(JSON.stringify(body)).not.toContain("test-webhook-secret");
    clientId = body.data.id;
    const listed = await (await request("GET", `/oauth-clients/${clientId}/oauth-tokens`)).json();
    expect(listed.data).toHaveLength(1);
    patId = listed.data[0].id;
    expect(body.data.relationships["oauth-tokens"].data).toEqual([{ id: patId, type: "oauth-tokens" }]);
    const stored = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, patId) });
    expect(stored?.token).not.toBe("test-pat-one");
    expect(await decryptSecret(stored!.token)).toBe("test-pat-one");
  });
  test("provider oauth-token-string creates and rotates a PAT without leaking it", async () => {
    const { "oauth-token": _uiToken, ...providerAttributes } = attributes;
    const response = await request("POST", `/organizations/${orgName}/oauth-clients`, {
      data: { attributes: { ...providerAttributes, "oauth-token-string": "provider-pat-one" } },
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    const providerClientId = body.data.id;
    const providerTokenId = body.data.relationships["oauth-tokens"].data[0]?.id;
    expect(providerTokenId).toMatch(/^ot-/);
    expect(JSON.stringify(body)).not.toContain("provider-pat-one");
    const stored = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, providerTokenId) });
    expect(await decryptSecret(stored!.token)).toBe("provider-pat-one");
    const patched = await request("PATCH", `/oauth-clients/${providerClientId}`, {
      data: { attributes: { "oauth-token-string": "provider-pat-two" } },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.relationships["oauth-tokens"].data).toEqual([
      { id: providerTokenId, type: "oauth-tokens" },
    ]);
    const rotated = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, providerTokenId) });
    expect(await decryptSecret(rotated!.token)).toBe("provider-pat-two");
    for (const invalid of [
      { "oauth-token": "one", "oauth-token-string": "two" },
      { "oauth-token-string": null },
      { "oauth-token-string": 42 },
      { "oauth-token-string": "" },
      { "oauth-token-string": "bad\r\nheader" },
    ]) {
      expect(
        (
          await request("POST", `/organizations/${orgName}/oauth-clients`, {
            data: { attributes: { ...providerAttributes, ...invalid } },
          })
        ).status,
      ).toBe(422);
      expect(
        (await request("PATCH", `/oauth-clients/${providerClientId}`, { data: { attributes: invalid } })).status,
      ).toBe(422);
    }
    const unchanged = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, providerTokenId) });
    expect(await decryptSecret(unchanged!.token)).toBe("provider-pat-two");
    expect(
      (
        await request("PATCH", `/oauth-clients/${providerClientId}`, {
          data: { attributes: { "oauth-token": "same-pat", "oauth-token-string": "same-pat" } },
        })
      ).status,
    ).toBe(200);
    await db.delete(oauthClients).where(eq(oauthClients.id, providerClientId));
  });
  test("rotates in place preserving token IDs and webhook secret", async () => {
    expect(
      (
        await request("PATCH", `/oauth-clients/${clientId}`, {
          data: { attributes: { "oauth-token": "test-pat-two" } },
        })
      ).status,
    ).toBe(200);
    const stored = await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, clientId) });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(patId);
    expect(await decryptSecret(stored[0]!.token)).toBe("test-pat-two");
    const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) });
    expect(await decryptSecret(client!.secret!)).toBe("test-webhook-secret");
  });
  test("case-only organization updates preserve credential references", async () => {
    expect(
      (await request("PATCH", `/oauth-clients/${clientId}`, { data: { attributes: { "ado-org-name": "FABRIKAM" } } }))
        .status,
    ).toBe(200);
    const stored = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, patId) });
    expect(stored).toBeDefined();
    expect(await decryptSecret(stored!.token)).toBe("test-pat-two");
  });
  test("rejects PAT rotation when the organization changes before its transaction", async () => {
    const created = await request("POST", `/organizations/${orgName}/oauth-clients`, {
      data: { attributes },
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id as string;
    const asyncDb = db as unknown as {
      transaction: (callback: (tx: typeof db) => Promise<unknown>, options?: unknown) => Promise<unknown>;
    };
    const originalTransaction = asyncDb.transaction.bind(db);
    let changed = false;
    const rotation = spyOn(asyncDb, "transaction").mockImplementation(async (callback, ...options) => {
      if (!changed) {
        changed = true;
        // Commit another request after rotation has validated the old scope.
        const concurrent = await request("PATCH", `/oauth-clients/${id}`, {
          data: { attributes: { "ado-org-name": "contoso" } },
        });
        expect(concurrent.status).toBe(200);
      }
      return originalTransaction(callback, ...options);
    });
    try {
      const response = await request("PATCH", `/oauth-clients/${id}`, {
        data: { attributes: { "oauth-token": "fabrikam-only-pat" } },
      });
      expect(changed).toBeTrue();
      expect(response.status).toBe(409);
    } finally {
      rotation.mockRestore();
    }
    const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, id) });
    const tokens = await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, id) });
    expect(client?.adoOrgName).toBe("contoso");
    expect(tokens).toEqual([]);
  });
  test("discovers configured organization repositories using Basic PAT", async () => {
    const calls: string[] = [];
    setExternalUrlTransportForTests(async (target, init) => {
      calls.push(target.url);
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Basic ${Buffer.from(":test-pat-two").toString("base64")}`,
      );
      return Response.json({
        value: [
          { name: "infra", project: { name: "Cloud Team" }, remoteUrl: "https://evil.test/not-used" },
          { name: "../bad", project: { name: "Cloud Team" } },
          { name: "disabled", project: { name: "Cloud Team" }, isDisabled: true },
        ],
      });
    });
    const response = await request(
      "GET",
      `/organizations/${orgName}/vcs-connections/oauth-token:${patId}/repositories`,
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()).data.map((entry: { attributes: { identifier: string } }) => entry.attributes.identifier),
    ).toEqual(["fabrikam/Cloud Team/_git/infra"]);
    expect(calls).toEqual(["https://dev.azure.com/fabrikam/_apis/git/repositories?api-version=7.1"]);
    setExternalUrlTransportForTests(undefined);
  });
  test("reports expired PATs without exposing provider bodies or credentials", async () => {
    setExternalUrlTransportForTests(async () => new Response("private provider details test-pat-two", { status: 401 }));
    const response = await request(
      "GET",
      `/organizations/${orgName}/vcs-connections/oauth-token:${patId}/repositories`,
    );
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("PAT expiration");
    expect(body).not.toContain("test-pat-two");
    expect(body).not.toContain("private provider details");
    setExternalUrlTransportForTests(undefined);
  });
  test("rejects unscoped PATs, wrong organizations, unsafe URLs, malformed tokens", async () => {
    for (const patch of [
      { "ado-org-name": null },
      { "ado-org-name": "../elsewhere" },
      { "api-url": "https://evil.test" },
      { "http-url": "https://dev.azure.com/other" },
      { "api-url": "https://dev.azure.com@evil.test" },
      { "oauth-token": "bad\r\nheader" },
      { "oauth-token": "" },
      { "oauth-token": 42 },
    ]) {
      expect(
        (
          await request("POST", `/organizations/${orgName}/oauth-clients`, {
            data: { attributes: { ...attributes, ...patch } },
          })
        ).status,
      ).toBe(422);
    }
    expect(
      (
        await request("PATCH", `/oauth-clients/${clientId}`, {
          data: { attributes: { "api-url": "https://evil.test", "oauth-token": "new-pat" } },
        })
      ).status,
    ).toBe(422);
    const stored = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, patId) });
    expect(await decryptSecret(stored!.token)).toBe("test-pat-two");
  });
  test("registers Azure modules with canonical encoded links and rejects another Azure organization", async () => {
    const calls: string[] = [];
    setExternalUrlTransportForTests(async (target) => {
      calls.push(target.url);
      return Response.json({ id: "repo-id", value: [] });
    });
    const payload = (organization: string) => ({
      data: {
        type: "registry-modules",
        attributes: {
          "module-name": "ado-network",
          "module-provider": "azurerm",
          "vcs-repo": {
            identifier: `${organization}/Cloud Team/_git/terraform-azurerm-network`,
            "oauth-token-id": patId,
            "repository-url": "https://evil.test/misleading",
          },
        },
      },
    });
    const path = `/organizations/${orgName}/registry-modules/vcs`;
    const rejected = await request("POST", path, payload("other-tenant"));
    expect(rejected.status).toBe(422);
    expect(calls).toHaveLength(0);
    const created = await request("POST", path, payload("fabrikam"));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data.attributes["vcs-repo"]["repository-url"]).toBe(
      "https://dev.azure.com/fabrikam/Cloud%20Team/_git/terraform-azurerm-network",
    );
    const modulePath = `/organizations/${orgName}/registry-modules/private/${orgName}/ado-network/azurerm`;
    const enabled = await request("PATCH", modulePath, {
      data: { type: "registry-modules", attributes: { "vcs-repo": { "ingress-submodules": true } } },
    });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).data.attributes["vcs-repo"]["ingress-submodules"]).toBe(true);
    const malformed = await request("PATCH", modulePath, {
      data: { type: "registry-modules", attributes: { "vcs-repo": { "ingress-submodules": "true" } } },
    });
    expect(malformed.status).toBe(422);
    const disabled = await request("PATCH", modulePath, {
      data: { type: "registry-modules", attributes: { "vcs-repo": { "ingress-submodules": false } } },
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).data.attributes["vcs-repo"]["ingress-submodules"]).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url.startsWith("https://dev.azure.com/fabrikam/"))).toBe(true);
    setExternalUrlTransportForTests(undefined);
  });
  test("rejects cross-tenant workspace repositories", async () => {
    for (const vcs of [{ identifier: "another/Cloud Team/_git/infra" }]) {
      const response = await request("POST", `/organizations/${orgName}/workspaces`, {
        data: {
          type: "workspaces",
          attributes: { name: "ado-invalid", "vcs-repo": { "oauth-token-id": patId, ...vcs } },
        },
      });
      expect(response.status).toBe(422);
    }
  });
  test("accepts same-tenant workspace submodule ingress", async () => {
    const response = await request("POST", `/organizations/${orgName}/workspaces`, {
      data: {
        type: "workspaces",
        attributes: {
          name: "ado-submodules",
          "vcs-repo": {
            "oauth-token-id": patId,
            identifier: "fabrikam/Cloud Team/_git/infra",
            "ingress-submodules": true,
          },
        },
      },
    });
    expect(response.status).toBe(201);
    expect((await response.json()).data.attributes["vcs-repo"]["ingress-submodules"]).toBe(true);
  });
  test("rejects unauthorized rotation", async () => {
    expect(
      (
        await request(
          "PATCH",
          `/oauth-clients/${clientId}`,
          { data: { attributes: { "oauth-token": "stolen" } } },
          "invalid",
        )
      ).status,
    ).toBe(404);
  });
});
