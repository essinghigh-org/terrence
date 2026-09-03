import { createHash, createSign } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, like } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { clearSsoChallenges } from "../../src/lib/sso-challenges";
import { invalidateSettingsCache } from "../../src/lib/settings";
import {
  adminSettings,
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
  ATTR_EMAIL,
  ATTR_GROUPS,
  ATTR_SITE_ADMIN,
  ATTR_USERNAME,
  ENTITY_ID,
  IDP_CERT,
  IDP_KEY,
  IDP_ENTITY_ID,
  IDP_OLD_CERT,
  IDP_OLD_KEY,
  buildSignedLogoutRequest,
  buildSignedSamlResponse,
  inflateAndDecode,
  samlAcsRequest,
  type SamlResponseOptions,
} from "./saml_helpers";

describe("SAML SSO flow", () => {
  const suffix = crypto.randomUUID();
  const adminId = `usr-samlflow-admin-${suffix}`;
  const orgUserId = `usr-samlflow-local-${suffix}`;
  const orgId = `org-samlflow-${suffix}`;
  const orgName = `samlflow-${suffix}`;
  const adminToken = `samlflow-admin-${suffix}`;
  let originalSaml: typeof samlSettings.$inferSelect | undefined;
  let originalSamlLink: typeof adminSettings.$inferSelect | undefined;

  const request = (method: string, path: string, token?: string, body?: unknown): Promise<Response> =>
    app.handle(new Request(`https://terrence.test${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  const cookieValue = (response: Response, name: string): string => {
    const prefix = `${name}=`;
    const pair = response.headers.getSetCookie()
      .map((value): string => value.split(";")[0] ?? "")
      .find((value): boolean => value.startsWith(prefix));
    return pair?.slice(prefix.length) ?? "";
  };

  const validAcs = async (options: SamlResponseOptions = {}, relayState?: string, extraHeaders: Record<string, string> = {}): Promise<Response> => {
    const auth = await app.handle(new Request(`https://terrence.test/users/saml/auth${relayState === undefined ? "" : `?RelayState=${encodeURIComponent(relayState)}`}`));
    const location = new URL(auth.headers.get("Location") ?? "");
    const state = cookieValue(auth, "terrence_saml_state");
    if (state === "") throw new Error("SAML auth response has no state cookie");
    const requestId = /\bID="([^"]+)"/.exec(inflateAndDecode(location.searchParams.get("SAMLRequest") ?? ""))?.[1];
    if (requestId === undefined) throw new Error("SAML AuthnRequest has no ID");
    const response = buildSignedSamlResponse({ ...options, inResponseTo: requestId });
    return app.handle(samlAcsRequest(response, relayState, { ...extraHeaders, Cookie: `terrence_saml_state=${state}` }));
  };

  beforeAll(async () => {
    originalSaml = await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") });
    originalSamlLink = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "saml") });
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
    const samlValues = {
      id: "saml",
      enabled: true,
      debug: true,
      idpCert: IDP_CERT,
      idpEntityId: IDP_ENTITY_ID,
      ssoEndpointUrl: "https://idp.example.test/sso",
      sloEndpointUrl: "https://idp.example.test/slo",
      attrUsername: ATTR_USERNAME,
      attrEmail: ATTR_EMAIL,
      attrGroups: ATTR_GROUPS,
      attrSiteAdmin: ATTR_SITE_ADMIN,
      siteAdminRole: "site-admins",
      ssoApiTokenSessionTimeout: 3600,
      updatedAt: Date.now(),
    };
    const { id: _samlId, ...samlUpdate } = samlValues;
    // Upsert so a row left behind by a crashed parallel suite cannot fail the
    // whole file's setup.
    await db.insert(samlSettings).values(samlValues)
      .onConflictDoUpdate({ target: samlSettings.id, set: samlUpdate });
    await db.insert(adminSettings).values({ id: "saml", values: { "link-by-email": true }, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: adminSettings.id, set: { values: { "link-by-email": true }, updatedAt: Date.now() } });
    invalidateSettingsCache();
  });

  afterAll(async () => {
    await clearSsoChallenges("saml-authn");
    await clearSsoChallenges("saml-assertion");
    await clearSsoChallenges("saml-logout");
    const provisioned = await db.query.users.findMany({
      where: like(users.username, `%-${suffix}`),
    });
    const ids = [adminId, orgUserId, ...provisioned.map((row): string => row.id)];
    await db.delete(samlSettings).where(eq(samlSettings.id, "saml"));
    if (originalSaml !== undefined) await db.insert(samlSettings).values(originalSaml);
    if (originalSamlLink === undefined) {
      await db.delete(adminSettings).where(eq(adminSettings.id, "saml"));
    } else {
      await db.update(adminSettings).set({ values: originalSamlLink.values, updatedAt: Date.now() })
        .where(eq(adminSettings.id, "saml"));
    }
    invalidateSettingsCache();
    await db.delete(apiTokens).where(inArray(apiTokens.userId, ids));
    // Delete team memberships by organization, not by user or by a single
    // team ID, so group-mapped rows cannot remain and trip the FK on teams.
    const orgTeams = await db.query.teams.findMany({ where: eq(teams.orgId, orgId) });
    if (orgTeams.length > 0) {
      await db.delete(teamMemberships)
        .where(inArray(teamMemberships.teamId, orgTeams.map((row): string => row.id)));
    }
    await db.delete(teams).where(eq(teams.orgId, orgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, ids));
  });

  test("exposes SP metadata with the ACS URL and entity ID", async () => {
    const response = await app.handle(new Request("https://terrence.test/users/saml/metadata"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    const body = await response.text();
    expect(body).toContain(ENTITY_ID);
    expect(body).toContain(ACS_URL);
    expect(body).toContain("SingleLogoutService");
  });

  test("redirects SP-initiated auth to the IdP over the HTTP-Redirect binding", async () => {
    const response = await app.handle(new Request("https://terrence.test/users/saml/auth?RelayState=api"));
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
    const stateCookie = response.headers.getSetCookie().find((value): boolean => value.startsWith("terrence_saml_state="));
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=None");
    expect(stateCookie).toContain("Secure");
  });

  test("rejects browser SAML redirects over plain HTTP", async () => {
    const response = await app.handle(new Request("http://terrence.test/users/saml/auth"));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("HTTPS");
    expect(response.headers.getSetCookie().some((value): boolean => value.startsWith("terrence_saml_state="))).toBeFalse();
  });

  test("returns 404 for the auth endpoint when SAML is disabled", async () => {
    const disabled = await request("PATCH", "/api/v2/admin/saml-settings", adminToken, {
      data: { type: "saml-settings", attributes: { enabled: false } },
    });
    expect(disabled.status).toBe(200);
    try {
      const response = await app.handle(new Request("https://terrence.test/users/saml/auth"));
      expect(response.status).toBe(404);
    } finally {
      const restored = await request("PATCH", "/api/v2/admin/saml-settings", adminToken, {
        data: { type: "saml-settings", attributes: { enabled: true } },
      });
      expect(restored.status).toBe(200);
    }
  });

  test("rejects an assertion delivered to a browser that did not start the flow", async () => {
    const firstAuth = await app.handle(new Request("https://terrence.test/users/saml/auth"));
    const firstLocation = new URL(firstAuth.headers.get("Location") ?? "");
    const firstState = cookieValue(firstAuth, "terrence_saml_state");
    const firstRequestId = /\bID="([^"]+)"/.exec(inflateAndDecode(firstLocation.searchParams.get("SAMLRequest") ?? ""))?.[1];
    const secondAuth = await app.handle(new Request("https://terrence.test/users/saml/auth"));
    const secondState = cookieValue(secondAuth, "terrence_saml_state");
    if (firstState === "" || secondState === "" || firstRequestId === undefined) {
      throw new Error("SAML flow did not return both state cookies and a request ID");
    }
    const username = `csrf-${suffix}`;
    const assertion = buildSignedSamlResponse({
      username,
      email: `${username}@example.com`,
      inResponseTo: firstRequestId,
    });
    const mismatched = await app.handle(samlAcsRequest(assertion, undefined, {
      Cookie: `terrence_saml_state=${secondState}`,
    }));
    expect(mismatched.status).toBe(400);
    expect(await mismatched.text()).toContain("browser");
    expect(await db.query.users.findFirst({ where: eq(users.username, username) })).toBeUndefined();

    const matched = await app.handle(samlAcsRequest(assertion, undefined, {
      Cookie: `terrence_saml_state=${firstState}`,
    }));
    expect(matched.status).toBe(200);
    expect(await matched.text()).toContain("You are signed in");
    expect(await db.query.users.findFirst({ where: eq(users.username, username) })).not.toBeUndefined();
  });

  test("fails closed instead of deriving SAML trust URLs from Host in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPublicUrl = process.env["PUBLIC_URL"];
    try {
      process.env.NODE_ENV = "production";
      delete process.env["PUBLIC_URL"];
      const response = await app.handle(new Request("https://spoofed.example.test/users/saml/auth"));
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("PUBLIC_URL");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousPublicUrl === undefined) delete process.env["PUBLIC_URL"];
      else process.env["PUBLIC_URL"] = previousPublicUrl;
    }
  });

  test("accepts a valid signed response, provisions a user, and issues a browser session", async () => {
    const response = await validAcs({
      username: `alice-${suffix}`,
      email: `alice-${suffix}@example.com`,
    });
    expect(response.status).toBe(200);
    expect(response.headers.has("Set-Cookie")).toBe(true);
    expect(response.headers.getSetCookie().some((value): boolean => value.startsWith("terrence_saml_state=;"))).toBeTrue();
    expect((await response.text())).toContain("You are signed in");

    const created = await db.query.users.findFirst({
      where: eq(users.username, `alice-${suffix}`),
    });
    expect(created).not.toBeUndefined();
    expect(created?.ssoProvider).toBe("saml");
    expect(created?.ssoSubject).toBe(`alice-${suffix}`);

    // The issued browser session is usable.
    const refreshToken = cookieValue(response, "terrence_refresh");
    const refreshResponse = await app.handle(new Request("https://terrence.test/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: `terrence_refresh=${refreshToken}` },
    }));
    expect(refreshResponse.status).toBe(200);
    const session = await refreshResponse.json() as { data: { attributes: { token: string } } };
    expect(session.data.attributes.token).toMatch(/^user-/);
  });

  test("rejects a replayed assertion", async () => {
    const auth = await app.handle(new Request("https://terrence.test/users/saml/auth"));
    const location = new URL(auth.headers.get("Location") ?? "");
    const state = cookieValue(auth, "terrence_saml_state");
    if (state === "") throw new Error("SAML auth response has no state cookie");
    const requestId = /\bID="([^"]+)"/.exec(inflateAndDecode(location.searchParams.get("SAMLRequest") ?? ""))?.[1];
    if (requestId === undefined) throw new Error("SAML AuthnRequest has no ID");
    const assertionId = `_replay_${suffix}`;
    const assertion = buildSignedSamlResponse({
      username: `replay-${suffix}`,
      email: `replay-${suffix}@example.com`,
      inResponseTo: requestId,
      assertionId,
    });
    const first = await app.handle(samlAcsRequest(assertion, undefined, { Cookie: `terrence_saml_state=${state}` }));
    expect(first.status).toBe(200);
    const secondAuth = await app.handle(new Request("https://terrence.test/users/saml/auth"));
    const secondState = cookieValue(secondAuth, "terrence_saml_state");
    const secondRequestId = /\bID="([^"]+)"/.exec(inflateAndDecode(new URL(secondAuth.headers.get("Location") ?? "").searchParams.get("SAMLRequest") ?? ""))?.[1];
    if (secondState === "" || secondRequestId === undefined) throw new Error("SAML AuthnRequest has no second state");
    const replayAssertion = buildSignedSamlResponse({
      username: `replay-${suffix}`,
      email: `replay-${suffix}@example.com`,
      inResponseTo: secondRequestId,
      assertionId,
    });
    const replay = await app.handle(samlAcsRequest(replayAssertion, undefined, { Cookie: `terrence_saml_state=${secondState}` }));
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("already been used");
  });

  test("rejects an unsigned second assertion", async () => {
    const signed = buildSignedSamlResponse({
      username: `wrapped-${suffix}`,
      email: `wrapped-${suffix}@example.com`,
      inResponseTo: "_not-used",
    });
    const xml = Buffer.from(signed, "base64").toString("utf8").replace(
      "</samlp:Response>",
      '<saml:Assertion ID="_unsigned" Version="2.0"></saml:Assertion></samlp:Response>',
    );
    const response = await app.handle(samlAcsRequest(Buffer.from(xml, "utf8").toString("base64")));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("exactly one Assertion");
  });

  test("rejects a response-level signature instead of accepting an unsigned assertion", async () => {
    const response = await validAcs({
      username: `response-signature-${suffix}`,
      email: `response-signature-${suffix}@example.com`,
      signatureTarget: "response",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("signature");
  });

  test("issues a short-lived API token for the CLI flow via RelayState", async () => {
    const response = await validAcs({ username: `cli-${suffix}`, email: `cli-${suffix}@example.com` }, "api");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("sso-token");
    const completedAt = Date.now();

    const user = await db.query.users.findFirst({ where: eq(users.username, `cli-${suffix}`) });
    expect(user).not.toBeUndefined();
    const tokenRow = await db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.userId, user!.id), eq(apiTokens.description, "SSO login token")),
    });
    expect(tokenRow).not.toBeUndefined();
    expect(tokenRow!.expiresAt).not.toBeNull();
    expect(tokenRow!.expiresAt! - completedAt).toBeGreaterThan(3_500_000);
    expect(tokenRow!.expiresAt! - completedAt).toBeLessThanOrEqual(3_650_000);
  });

  test("returns JSON token when the ACS is called with an API Accept header", async () => {
    const response = await validAcs(
      { username: `json-${suffix}`, email: `json-${suffix}@example.com` },
      "cli",
      { Accept: "application/json" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().some((value): boolean => value.startsWith("terrence_saml_state=;"))).toBeTrue();
    const json = await response.json() as { data: { attributes: { token: string; "expired-at": string } } };
    expect(json.data.attributes.token).toMatch(/^user-/);
    expect(json.data.attributes["expired-at"]).toBeDefined();
  });

  test("links an existing local account by matching email", async () => {
    const response = await validAcs({
      username: `local-${suffix}`,
      email: "conflict@example.com",
    });
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
    const response = await validAcs({
      username: `other-${suffix}`,
      email: `ssonew-${suffix}@example.com`,
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already in use");
    const notTakenOver = await db.query.users.findFirst({ where: eq(users.email, `ssonew-${suffix}@example.com`) });
    expect(notTakenOver).toBeUndefined();
  });

  test("rejects an invalid signature", async () => {
    const response = await validAcs({
      username: `bad-sig-${suffix}`,
      email: `bad-sig-${suffix}@example.com`,
      privateKey: IDP_OLD_KEY,
      publicCert: IDP_OLD_CERT,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("signature");
  });

  test("rejects an IdP logout signed by an unconfigured certificate", async () => {
    const response = await app.handle(new Request("https://terrence.test/users/saml/logout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLRequest: buildSignedLogoutRequest(`wrong-cert-${suffix}`, { privateKey: IDP_OLD_KEY, publicCert: IDP_OLD_CERT }),
      }).toString(),
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("signature");
  });

  test("verifies with the previous certificate during rotation", async () => {
    // Current cert is the NEW one; responses signed with the OLD cert must
    // still verify because the old cert is retained during rotation.
    await db.update(samlSettings).set({ idpCert: IDP_CERT, oldIdpCert: IDP_OLD_CERT, updatedAt: Date.now() })
      .where(eq(samlSettings.id, "saml"));
    try {
      const response = await validAcs({
        username: `rotate-${suffix}`,
        email: `rotate-${suffix}@example.com`,
        privateKey: IDP_OLD_KEY,
        publicCert: IDP_OLD_CERT,
      });
      expect(response.status).toBe(200);
    } finally {
      // Restore so later tests that sign with the old key still reject.
      await db.update(samlSettings).set({ oldIdpCert: null, updatedAt: Date.now() })
        .where(eq(samlSettings.id, "saml"));
    }
  });

  test("rejects an expired assertion", async () => {
    const minutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const response = await validAcs({
      username: `expired-${suffix}`,
      email: `expired-${suffix}@example.com`,
      notBefore: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      notOnOrAfter: minutesAgo,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expired");
  });

  test("rejects an assertion for a different audience", async () => {
    const response = await validAcs({
      username: `aud-${suffix}`,
      email: `aud-${suffix}@example.com`,
      audience: "https://other.example.com/metadata",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("audience");
  });

  test("rejects an unsolicited assertion without signed InResponseTo", async () => {
    const response = await app.handle(samlAcsRequest(buildSignedSamlResponse({
      username: `unsolicited-${suffix}`,
      email: `unsolicited-${suffix}@example.com`,
    })));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("confirmation");
  });

  test("maps groups to teams and the owners role", async () => {
    const response = await validAcs({
      username: `grouped-${suffix}`,
      email: `grouped-${suffix}@example.com`,
      groups: ["admins", "developers"],
    });
    expect(response.status).toBe(200);
    const grouped = await db.query.users.findFirst({ where: eq(users.username, `grouped-${suffix}`) });
    expect(grouped).not.toBeUndefined();
    const membership = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.userId, grouped!.id)),
    });
    expect(membership?.role).toBe("owner");
    const teamMembership = await db.query.teamMemberships.findFirst({
      where: and(eq(teamMemberships.teamId, `team-dev-${suffix}`), eq(teamMemberships.userId, grouped!.id)),
    });
    expect(teamMembership).not.toBeUndefined();
  });

  test("removes SAML-sourced memberships when a later login omits the groups attribute", async () => {
    const groupedUsername = `group-removal-${suffix}`;
    // First login maps the groups attribute to teams and the owners role.
    const first = await validAcs({
      username: groupedUsername,
      email: `${groupedUsername}@example.com`,
      groups: ["admins", "developers"],
    });
    expect(first.status).toBe(200);
    const grouped = await db.query.users.findFirst({ where: eq(users.username, groupedUsername) });
    expect(grouped).not.toBeUndefined();
    expect(await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.userId, grouped!.id)),
    })).not.toBeUndefined();
    expect(await db.query.teamMemberships.findFirst({
      where: and(eq(teamMemberships.teamId, `team-dev-${suffix}`), eq(teamMemberships.userId, grouped!.id)),
    })).not.toBeUndefined();

    // Next login omits the groups attribute; the empty-group synchronization
    // prunes the SAML-sourced team membership and downgrades the org role.
    const second = await validAcs({
      username: groupedUsername,
      email: `${groupedUsername}@example.com`,
    });
    expect(second.status).toBe(200);
    expect(await db.query.teamMemberships.findFirst({
      where: and(eq(teamMemberships.teamId, `team-dev-${suffix}`), eq(teamMemberships.userId, grouped!.id)),
    })).toBeUndefined();
    const membershipAfter = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.userId, grouped!.id)),
    });
    expect(membershipAfter?.role).toBe("member");
  });

  test("falls back to the default email attributes when attrEmail is cleared", async () => {
    const username = `noattremail-${suffix}`;
    // The admin API rejects an empty attr-email, so clear it directly; the
    // ACS must fall back to the standard email attribute names.
    await db.update(samlSettings).set({ attrEmail: "", updatedAt: Date.now() }).where(eq(samlSettings.id, "saml"));
    try {
      const response = await validAcs({ username, email: `${username}@example.com` });
      expect(response.status).toBe(200);
      const created = await db.query.users.findFirst({ where: eq(users.username, username) });
      expect(created?.email).toBe(`${username}@example.com`);
    } finally {
      await db.update(samlSettings).set({ attrEmail: "email", updatedAt: Date.now() }).where(eq(samlSettings.id, "saml"));
    }
  });

  test("promotes a user to site admin when the site-admin attribute matches", async () => {
    const response = await validAcs({
      username: `siteadmin-${suffix}`,
      email: `siteadmin-${suffix}@example.com`,
      siteAdmin: "site-admins",
    });
    expect(response.status).toBe(200);
    const promoted = await db.query.users.findFirst({ where: eq(users.username, `siteadmin-${suffix}`) });
    expect(promoted?.isSiteAdmin).toBeTrue();
    expect(promoted?.ssoSiteAdmin).toBeTrue();
  });

  test("demotes a SAML-sourced site admin when the attribute stops matching", async () => {
    const adminUsername = `revoked-${suffix}`;
    // First login includes the site-admin attribute and elevates the account.
    const first = await validAcs({
      username: adminUsername,
      email: `${adminUsername}@example.com`,
      siteAdmin: "site-admins",
    });
    expect(first.status).toBe(200);
    let admin = await db.query.users.findFirst({ where: eq(users.username, adminUsername) });
    expect(admin?.isSiteAdmin).toBeTrue();

    // Next login omits the attribute; the SAML-sourced grant must be revoked.
    const second = await validAcs({
      username: adminUsername,
      email: `${adminUsername}@example.com`,
    });
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
    try {
      // Email-links to the existing local admin, but ssoSiteAdmin stays false.
      const response = await validAcs({
        username: localAdminUsername,
        email: `${localAdminUsername}@example.com`,
      });
      expect(response.status).toBe(200);
      const localAdmin = await db.query.users.findFirst({ where: eq(users.id, localAdminId) });
      expect(localAdmin?.isSiteAdmin).toBeTrue();
      expect(localAdmin?.ssoSiteAdmin).toBeFalse();
    } finally {
      await db.delete(users).where(eq(users.id, localAdminId));
    }
  });

  test("routes SLO to the IdP single logout endpoint", async () => {
    const username = `sp-slo-${suffix}`;
    const login = await validAcs({ username, email: `${username}@example.com` });
    const refreshToken = cookieValue(login, "terrence_refresh");
    const response = await app.handle(new Request("https://terrence.test/users/saml/slo", {
      headers: { Cookie: `terrence_refresh=${refreshToken}`, "Sec-Fetch-Site": "same-origin" },
    }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://idp.example.test/slo");
    expect(location.searchParams.has("SAMLRequest")).toBeTrue();
    const logoutRequest = inflateAndDecode(location.searchParams.get("SAMLRequest") ?? "");
    expect(logoutRequest).toContain('Destination="https://idp.example.test/slo"');
    expect(logoutRequest).toContain(`<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${username}</saml:NameID>`);
  });

  test("rejects an SP-initiated SLO request from a cross-site caller", async () => {
    const username = `cross-slo-${suffix}`;
    const login = await validAcs({ username, email: `${username}@example.com` });
    const refreshToken = cookieValue(login, "terrence_refresh");
    // A cross-site request cannot start an SP-initiated logout: the browser
    // binding guard rejects it instead of redirecting to the IdP.
    const response = await app.handle(new Request("https://terrence.test/users/saml/slo", {
      headers: { Cookie: `terrence_refresh=${refreshToken}`, "Sec-Fetch-Site": "cross-site" },
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  test("handles an IdP-initiated redirect-binding logout", async () => {
    const username = `redirect-slo-${suffix}`;
    const login = await validAcs({ username, email: `${username}@example.com` });
    const refreshToken = cookieValue(login, "terrence_refresh");
    const logoutXml = Buffer.from(buildSignedLogoutRequest(username), "base64").toString("utf8");
    const encodedRequest = Buffer.from(deflateRawSync(Buffer.from(logoutXml, "utf8"))).toString("base64");
    const relayState = "return";
    const sigAlg = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    const encodedRelayState = encodeURIComponent(relayState);
    const encodedSigAlg = encodeURIComponent(sigAlg);
    const signedInput = `SAMLRequest=${encodeURIComponent(encodedRequest)}&RelayState=${encodedRelayState}&SigAlg=${encodedSigAlg}`;
    const signature = createSign("RSA-SHA256").update(signedInput).sign(IDP_KEY).toString("base64");
    const logoutUrl = `https://terrence.test/users/saml/slo?${signedInput}&Signature=${encodeURIComponent(signature)}`;
    const response = await app.handle(new Request(logoutUrl, { headers: { Cookie: `terrence_refresh=${refreshToken}` } }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://idp.example.test/slo");
    expect(location.searchParams.get("RelayState")).toBe(relayState);
    expect(inflateAndDecode(location.searchParams.get("SAMLResponse") ?? ""))
      .toContain("LogoutResponse");
    const replay = await app.handle(new Request(logoutUrl, { headers: { Cookie: `terrence_refresh=${refreshToken}` } }));
    expect(replay.status).toBe(400);
  });

  test("revokes the local session on IdP-initiated logout", async () => {
    // Sign in first to get a browser refresh session.
    const options = { username: `slo-${suffix}`, email: `slo-${suffix}@example.com` };
    const login = await validAcs(options);
    expect(login.status).toBe(200);
    const refreshToken = cookieValue(login, "terrence_refresh");
    expect(refreshToken).not.toBe("");

    const refresh = await app.handle(new Request("https://terrence.test/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: `terrence_refresh=${refreshToken}` },
    }));
    expect(refresh.status).toBe(200);
    const activeRefreshToken = cookieValue(refresh, "terrence_refresh");
    expect(activeRefreshToken).not.toBe("");

    // An IdP-initiated LogoutRequest (signed) clears the session.
    const logoutResponse = await app.handle(new Request("https://terrence.test/users/saml/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `terrence_refresh=${activeRefreshToken}`,
      },
      body: new URLSearchParams({ SAMLRequest: buildSignedLogoutRequest(options.username) }).toString(),
    }));
    expect(logoutResponse.status).toBe(302);
    const logoutLocation = new URL(logoutResponse.headers.get("Location") ?? "");
    expect(logoutLocation.origin + logoutLocation.pathname).toBe("https://idp.example.test/slo");
    const logoutXml = inflateAndDecode(logoutLocation.searchParams.get("SAMLResponse") ?? "");
    expect(logoutXml).toContain("LogoutResponse");
    expect(logoutXml).toContain('InResponseTo="_logout_');
    expect(logoutXml).toContain("urn:oasis:names:tc:SAML:2.0:status:Success");

    const revokedRefresh = await app.handle(new Request("https://terrence.test/api/v2/users/refresh", {
      method: "POST",
      headers: { Cookie: `terrence_refresh=${activeRefreshToken}` },
    }));
    expect(revokedRefresh.status).toBe(401);
  });
});
