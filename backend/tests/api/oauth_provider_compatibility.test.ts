import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, oauthClients, organizationMemberships, organizations, users } from "../../src/db/schema";

describe("OAuth client provider wire compatibility", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-oauth-provider-${suffix}`;
  const orgId = `org-oauth-provider-${suffix}`;
  const orgName = `oauth-provider-${suffix}`;
  const token = `oauth-provider-token-${suffix}`;
  let clientId = "";

  const request = (method: string, path: string, body?: unknown): Promise<Response> =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `orgmem-oauth-provider-${suffix}`,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({
      id: `api-oauth-provider-${suffix}`,
      token: createHash("sha256").update(token).digest("hex"),
      userId,
    });
  });

  afterAll(async () => {
    await db.delete(oauthClients).where(eq(oauthClients.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  for (const provider of [
    "ado_server",
    "ado_services",
    "bitbucket_data_center",
    "bitbucket_hosted",
    "bitbucket_server",
    "github",
    "github_enterprise",
    "gitlab_hosted",
    "gitlab_community_edition",
    "gitlab_enterprise_edition",
  ]) {
    test(`${provider} create/read/update round trip`, async () => {
      const created = await request("POST", `/api/v2/organizations/${orgName}/oauth-clients`, {
        data: { type: "oauth-clients", attributes: { name: provider, "service-provider": provider } },
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.data.attributes["service-provider"]).toBe(provider);
      const read = await request("GET", `/api/v2/oauth-clients/${body.data.id}`);
      expect((await read.json()).data.attributes["service-provider"]).toBe(provider);
      const patched = await request("PATCH", `/api/v2/oauth-clients/${body.data.id}`, {
        data: { attributes: { "service-provider": provider, name: "renamed" } },
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()).data.attributes["service-provider"]).toBe(provider);
    });
  }
  test("legacy provider names remain accepted and return canonical wire names", async () => {
    for (const [legacy, canonical] of [
      ["gitlab", "gitlab_hosted"],
      ["bitbucket", "bitbucket_hosted"],
      ["gitlab_ce", "gitlab_community_edition"],
      ["gitlab_ee", "gitlab_enterprise_edition"],
      ["azure_devops_server", "ado_server"],
    ]) {
      const created = await request("POST", `/api/v2/organizations/${orgName}/oauth-clients`, {
        data: { attributes: { name: legacy, "service-provider": legacy } },
      });
      expect(created.status).toBe(201);
      expect((await created.json()).data.attributes["service-provider"]).toBe(canonical);
    }
  });
  test("canonical hosted providers retain OAuth adapter dispatch", async () => {
    for (const [provider, host, path] of [
      ["gitlab_hosted", "gitlab.com", "/oauth/authorize"],
      ["bitbucket_hosted", "bitbucket.org", "/site/oauth2/authorize"],
    ] as const) {
      const created = await request("POST", `/api/v2/organizations/${orgName}/oauth-clients`, {
        data: {
          attributes: {
            name: provider,
            "service-provider": provider,
            key: "client-id",
            secret: "client-secret",
            "organization-scoped": true,
          },
        },
      });
      expect(created.status).toBe(201);
      const id = (await created.json()).data.id;
      const connect = await request("GET", `/api/v2/oauth-clients/${id}/connect`);
      expect(connect.status).toBe(302);
      const target = new URL(connect.headers.get("location")!);
      expect(target.hostname).toBe(host);
      expect(target.pathname).toBe(path);
    }
  });
  test("ADO organization persists, updates, preserves on omission and clears explicitly", async () => {
    const created = await request("POST", `/api/v2/organizations/${orgName}/oauth-clients`, {
      data: { attributes: { name: "ADO", "service-provider": "ado_services", "ado-org-name": "first" } },
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data.attributes["ado-org-name"]).toBe("first");
    clientId = body.data.id;
    for (const [attributes, expected] of [
      [{ "ado-org-name": "second" }, "second"],
      [{ name: "renamed" }, "second"],
      [{ "ado-org-name": null }, null],
    ] as const) {
      expect((await request("PATCH", `/api/v2/oauth-clients/${clientId}`, { data: { attributes } })).status).toBe(200);
      const read = await request("GET", `/api/v2/oauth-clients/${clientId}`);
      expect((await read.json()).data.attributes["ado-org-name"]).toBe(expected);
      expect((await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) }))?.adoOrgName).toBe(
        expected,
      );
    }
    for (const attributes of [{ "service-provider": "unknown" }, { "ado-org-name": 42 }]) {
      expect((await request("PATCH", `/api/v2/oauth-clients/${clientId}`, { data: { attributes } })).status).toBe(422);
      expect(
        (
          await request("POST", `/api/v2/organizations/${orgName}/oauth-clients`, {
            data: { attributes: { name: "invalid", ...attributes } },
          })
        ).status,
      ).toBe(422);
    }
  });
});
