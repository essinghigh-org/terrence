import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, like } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  samlSettings,
  teamMemberships,
  teams,
  users,
} from "../../src/db/schema";
import {
  ACS_URL,
  ENTITY_ID,
  IDP_CERT,
  IDP_OLD_CERT,
  IDP_OLD_KEY,
  buildSignedLogoutRequest,
  buildSignedSamlResponse,
  inflateAndDecode,
  samlAcsRequest,
} from "./saml_helpers";

describe("SAML SSO flow", () => {
  const suffix = crypto.randomUUID();
  const adminId = `usr-samlflow-admin-${suffix}`;
  const orgUserId = `usr-samlflow-local-${suffix}`;
  const orgId = `org-samlflow-${suffix}`;
  const orgName = `samlflow-${suffix}`;
  const adminToken = `samlflow-admin-${suffix}`;

  const request = (method: string, path: string, token?: string, body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      // Local account used for conflict/link tests.
      { id: orgUserId, username: `local-${suffix}`, email: "conflict@example.com", passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName, samlEnabled: true, ownersTeamSamlRoleId: "admins" });
    await db.insert(teams).values({ id: `team-dev-${suffix}`, orgId, name: "developers" });
    await db.insert(apiTokens).values({
      id: `api-samlflow-${suffix}`,
      token: createHash("sha256").update(adminToken).digest("hex"),
      userId: adminId,
    });
    await db.insert(samlSettings).values({
      id: "saml",
      enabled: true,
      debug: true,
      idpCert: IDP_CERT,
      ssoEndpointUrl: "https://idp.example.test/sso",
      sloEndpointUrl: "https://idp.example.test/slo",
      attrUsername: "Username",
      attrGroups: "MemberOf",
      attrSiteAdmin: "SiteAdmin",
      siteAdminRole: "site-admins",
      ssoApiTokenSessionTimeout: 3600,
      updatedAt: Date.now(),
    });
  });

  afterAll(async () => {
    const provisioned = await db.query.users.findMany({
      where: like(users.username, `%-${suffix}`),
    });
    const ids = [adminId, orgUserId, ...provisioned.map((row): string => row.id)];
    await db.delete(samlSettings).where(eq(samlSettings.id, "saml"));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, ids));
    // Delete team memberships by team, not by user, so group-mapped rows do
    // not remain and trip the FK on teams.
    await db.delete(teamMemberships).where(eq(teamMemberships.teamId, `team-dev-${suffix}`));
    await db.delete(teams).where(eq(teams.id, `team-dev-${suffix}`));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, ids));
  });

  test("exposes SP metadata with the ACS URL and entity ID", async () => {
    const response = await app.handle(new Request("http://terrence.test/users/saml/metadata"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    const body = await response.text();
    expect(body).toContain(ENTITY_ID);
    expect(body).toContain(ACS_URL);
    expect(body).toContain("SingleLogoutService");
  });

  test("redirects SP-initiated auth to the IdP over the HTTP-Redirect binding", async () => {
    const response = await app.handle(new Request("http://terrence.test/users/saml/auth?RelayState=api"));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://idp.example.test/sso");
    expect(location.searchParams.has("SAMLRequest")).toBeTrue();
    const authnRequest = inflateAndDecode(location.searchParams.get("SAMLRequest") ?? "");
    // The AuthnRequest must target the IdP SSO endpoint, not an empty
    // Destination — strict IdPs reject requests with a missing/mismatched one.
    expect(authnRequest).toContain(`Destination="https://idp.example.test/sso"`);
    expect(authnRequest).toContain(`ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`);
    expect(location.searchParams.get("RelayState")).toBe("api");
  });

  test("returns 404 for the auth endpoint when SAML is disabled", async () => {
    await request("PATCH", "/api/v2/admin/saml-settings", adminToken, {
      data: { type: "saml-settings", attributes: { enabled: false } },
    });
    const response = await app.handle(new Request("http://terrence.test/users/saml/auth"));
    expect(response.status).toBe(404);
    await request("PATCH", "/api/v2/admin/saml-settings", adminToken, {
      data: { type: "saml-settings", attributes: { enabled: true } },
    });
  });

  test("accepts a valid signed response, provisions a user, and issues a browser session", async () => {
    const samlResponse = buildSignedSamlResponse({
      username: `alice-${suffix}`,
      email: `alice-${suffix}@example.com`,
    });
    const response = await app.handle(samlAcsRequest(samlResponse));
    expect(response.status).toBe(200);
    expect(response.headers.has("Set-Cookie")).toBe(true);
    expect((await response.text())).toContain("You are signed in");

    const created = await db.query.users.findFirst({
      where: eq(users.username, `alice-${suffix}`),
    });
    expect(created).not.toBeUndefined();
    expect(created?.ssoProvider).toBe("saml");
    expect(created?.ssoSubject).toBe(`alice-${suffix}`);

    // The issued browser session is usable.
    const cookie = response.headers.get("Set-Cookie") ?? "";
    const refreshToken = cookie.split(";")[0]?.split("=")[1] ?? "";
    const refreshResponse = await app.handle(new Request("http://terrence.test/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: `terrence_refresh=${refreshToken}` },
    }));
    expect(refreshResponse.status).toBe(200);
    const session = await refreshResponse.json() as { data: { attributes: { token: string } } };
    expect(session.data.attributes.token).toMatch(/^user-/);
  });

  test("issues a short-lived API token for the CLI flow via RelayState", async () => {
    const before = Date.now();
    const response = await app.handle(samlAcsRequest(
      buildSignedSamlResponse({ username: `cli-${suffix}`, email: `cli-${suffix}@example.com` }),
      "api",
    ));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("sso-token");

    const user = await db.query.users.findFirst({ where: eq(users.username, `cli-${suffix}`) });
    expect(user).not.toBeUndefined();
    const tokenRow = await db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.userId, user!.id), eq(apiTokens.description, "SSO login token")),
    });
    expect(tokenRow).not.toBeUndefined();
    expect(tokenRow!.expiresAt).not.toBeNull();
    expect(tokenRow!.expiresAt! - before).toBeGreaterThan(3_500_000);
    expect(tokenRow!.expiresAt! - before).toBeLessThanOrEqual(3_650_000);
  });

  test("returns JSON token when the ACS is called with an API Accept header", async () => {
    const response = await app.handle(new Request("http://terrence.test/users/saml/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        SAMLResponse: buildSignedSamlResponse({ username: `json-${suffix}`, email: `json-${suffix}@example.com` }),
        RelayState: "cli",
      }).toString(),
    }));
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { attributes: { token: string; "expired-at": string } } };
    expect(json.data.attributes.token).toMatch(/^user-/);
    expect(json.data.attributes["expired-at"]).toBeDefined();
  });

  test("links an existing local account by matching email", async () => {
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: `local-${suffix}`,
      email: "conflict@example.com",
    })));
    expect(response.status).toBe(200);
    const linked = await db.query.users.findFirst({ where: eq(users.id, orgUserId) });
    expect(linked?.ssoProvider).toBe("saml");
    expect(linked?.ssoSubject).toBe(`local-${suffix}`);
    expect(linked?.username).toBe(`local-${suffix}`);
  });

  test("blocks provisioning when the username belongs to a different local account", async () => {
    await db.insert(users).values({
      id: `usr-samlflow-other-${suffix}`,
      username: `other-${suffix}`,
      email: `other-${suffix}@example.com`,
      passwordHash: "unused",
    });
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: `other-${suffix}`,
      email: `ssonew-${suffix}@example.com`,
    })));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already in use");
    const notTakenOver = await db.query.users.findFirst({ where: eq(users.email, `ssonew-${suffix}@example.com`) });
    expect(notTakenOver).toBeUndefined();
  });

  test("rejects an invalid signature", async () => {
    const samlResponse = buildSignedSamlResponse({
      username: `bad-sig-${suffix}`,
      email: `bad-sig-${suffix}@example.com`,
      privateKey: IDP_OLD_KEY,
      publicCert: IDP_OLD_CERT,
    });
    const response = await app.handle(samlAcsRequest(samlResponse));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("signature");
  });

  test("verifies with the previous certificate during rotation", async () => {
    // Current cert is the NEW one; responses signed with the OLD cert must
    // still verify because the old cert is retained during rotation.
    await db.update(samlSettings).set({ idpCert: IDP_CERT, oldIdpCert: IDP_OLD_CERT, updatedAt: Date.now() })
      .where(eq(samlSettings.id, "saml"));
    try {
      const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
        username: `rotate-${suffix}`,
        email: `rotate-${suffix}@example.com`,
        privateKey: IDP_OLD_KEY,
        publicCert: IDP_OLD_CERT,
      })));
      expect(response.status).toBe(200);
    } finally {
      // Restore so later tests that sign with the old key still reject.
      await db.update(samlSettings).set({ oldIdpCert: null, updatedAt: Date.now() })
        .where(eq(samlSettings.id, "saml"));
    }
  });

  test("rejects an expired assertion", async () => {
    const minutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: `expired-${suffix}`,
      email: `expired-${suffix}@example.com`,
      notBefore: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      notOnOrAfter: minutesAgo,
    })));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expired");
  });

  test("rejects an assertion for a different audience", async () => {
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: `aud-${suffix}`,
      email: `aud-${suffix}@example.com`,
      audience: "https://other.example.com/metadata",
    })));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("audience");
  });

  test("maps groups to teams and the owners role", async () => {
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: `grouped-${suffix}`,
      email: `grouped-${suffix}@example.com`,
      groups: ["admins", "developers"],
    })));
    expect(response.status).toBe(200);
    const grouped = await db.query.users.findFirst({ where: eq(users.username, `grouped-${suffix}`) });
    expect(grouped).not.toBeUndefined();
    const membership = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.userId, grouped!.id)),
    });
    expect(membership?.role).toBe("owner");
    const teamMembership = await db.query.teamMemberships.findFirst({
      where: eq(teamMemberships.teamId, `team-dev-${suffix}`),
    });
    expect(teamMembership?.userId).toBe(grouped!.id);
  });

  test("promotes a user to site admin when the site-admin attribute matches", async () => {
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: `siteadmin-${suffix}`,
      email: `siteadmin-${suffix}@example.com`,
      siteAdmin: "site-admins",
    })));
    expect(response.status).toBe(200);
    const promoted = await db.query.users.findFirst({ where: eq(users.username, `siteadmin-${suffix}`) });
    expect(promoted?.isSiteAdmin).toBeTrue();
    expect(promoted?.ssoSiteAdmin).toBeTrue();
  });

  test("demotes a SAML-sourced site admin when the attribute stops matching", async () => {
    const adminUsername = `revoked-${suffix}`;
    // First login includes the site-admin attribute and elevates the account.
    const first = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: adminUsername,
      email: `${adminUsername}@example.com`,
      siteAdmin: "site-admins",
    })));
    expect(first.status).toBe(200);
    let admin = await db.query.users.findFirst({ where: eq(users.username, adminUsername) });
    expect(admin?.isSiteAdmin).toBeTrue();

    // Next login omits the attribute; the SAML-sourced grant must be revoked.
    const second = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: adminUsername,
      email: `${adminUsername}@example.com`,
    })));
    expect(second.status).toBe(200);
    admin = await db.query.users.findFirst({ where: eq(users.username, adminUsername) });
    expect(admin?.isSiteAdmin).toBeFalse();
    expect(admin?.ssoSiteAdmin).toBeFalse();
  });

  test("keeps a locally-granted site admin despite a SAML login without the attribute", async () => {
    const localAdminId = `usr-saml-localadmin-${suffix}`;
    const localAdminUsername = `localadmin-${suffix}`;
    await db.insert(users).values({
      id: localAdminId,
      username: localAdminUsername,
      email: `${localAdminUsername}@example.com`,
      passwordHash: "unused",
      isSiteAdmin: true,
    });
    // Email-links to the existing local admin, but ssoSiteAdmin stays false.
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: localAdminUsername,
      email: `${localAdminUsername}@example.com`,
    })));
    expect(response.status).toBe(200);
    const localAdmin = await db.query.users.findFirst({ where: eq(users.id, localAdminId) });
    expect(localAdmin?.isSiteAdmin).toBeTrue();
    expect(localAdmin?.ssoSiteAdmin).toBeFalse();
    await db.delete(users).where(eq(users.id, localAdminId));
  });

  test("routes SLO to the IdP single logout endpoint", async () => {
    const response = await app.handle(new Request("http://terrence.test/users/saml/slo"));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://idp.example.test/slo");
    expect(location.searchParams.has("SAMLRequest")).toBeTrue();
  });

  test("revokes the local session on IdP-initiated logout", async () => {
    // Sign in first to get a browser refresh session.
    const options = { username: `slo-${suffix}`, email: `slo-${suffix}@example.com` };
    const login = await app.handle(samlAcsRequest(buildSignedSamlResponse(options)));
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("terrence_refresh=");
    const refreshToken = setCookie.split(";")[0]?.split("=")[1] ?? "";

    const refresh = await app.handle(new Request("http://terrence.test/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: `terrence_refresh=${refreshToken}` },
    }));
    expect(refresh.status).toBe(200);

    // An IdP-initiated LogoutRequest (signed) clears the session.
    const logoutResponse = await app.handle(new Request("http://terrence.test/users/saml/logout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SAMLRequest: buildSignedLogoutRequest() }).toString(),
    }));
    expect(logoutResponse.status).toBe(200);
    expect(await logoutResponse.text()).toContain("LogoutResponse");

    const revokedRefresh = await app.handle(new Request("http://localhost/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: `terrence_refresh=${refreshToken}` },
    }));
    expect(revokedRefresh.status).toBe(401);
  });
});