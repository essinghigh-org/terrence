import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import * as ldap from "ldapjs";
import type { Server } from "ldapjs";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { adminSettings, apiTokens, users } from "../../src/db/schema";
import { oauthPlugin } from "../../src/oauth";
import { invalidatePingSsoCache } from "../../src/routes/health";
import { invalidateSettingsCache } from "../../src/lib/settings";

const SERVICE_DN = "cn=admin,dc=example,dc=com";
const USER_DN = (username: string): string => `uid=${username},dc=example,dc=com`;
const SERVICE_PASSWORD = "service-secret";
const VALID_USER_PASSWORD = "ldap-pass";

function startLdapMock(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject): void => {
    const server = ldap.createServer();
    server.bind("dc=example,dc=com", (req: ldap.BindRequest, res: ldap.Response, next: ldap.NextCallback): void => {
      const dn = req.dn.toString();
      if ((dn === SERVICE_DN && req.credentials === SERVICE_PASSWORD)
        || (dn !== SERVICE_DN && req.credentials === VALID_USER_PASSWORD)) {
        res.end();
        next();
        return;
      }
      next(new ldap.InvalidCredentialsError());
    });
    // The mock directory knows exactly two users, plus an ambiguous multi-entry
    // case used to exercise the unique-match rule: "duplicate" has two entries.
    server.search("dc=example,dc=com", (req, res, next): void => {
      const value = req.filter.value ?? req.filter.attributeValue;
      const username = typeof value === "string" ? value : "";
      if (username === "") {
        res.end();
        next();
        return;
      }
      const dn = USER_DN(username);
      if (username === "carol") {
        res.end();
        next();
        return;
      }
      if (username === "duplicate") {
        // Two distinct entries share the same uid: the search filter matches
        // both, so no single entry may be bound.
        res.send({
          dn: USER_DN("duplicate"),
          attributes: { uid: "duplicate", mail: "duplicate@example.com", cn: "Duplicate" },
        });
        res.send({
          dn: USER_DN("duplicate2"),
          attributes: { uid: "duplicate", mail: "duplicate-2@example.com", cn: "Duplicate 2" },
        });
        res.end();
        next();
        return;
      }
      res.send({
        dn,
        attributes: {
          uid: username,
          mail: `${username}@example.com`,
          cn: username.charAt(0).toUpperCase() + username.slice(1),
        },
      });
      res.end();
      next();
    });

    let started = false;
    server.on("error", (error: unknown): void => {
      if (started) return;
      started = true;
      reject(error instanceof Error ? error : new Error("ldap mock failed to start"));
    });
    server.listen(0, "127.0.0.1", (): void => {
      if (started) return;
      started = true;
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ldap mock failed to bind"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

describe("LDAP authentication", () => {
  const suffix = crypto.randomUUID();
  const adminId = `usr-ldap-admin-${suffix}`;
  const localId = `usr-ldap-local-${suffix}`;
  const adminToken = `ldap-admin-token-${suffix}`;
  const ldapUsername = `alice-${suffix}`;
  const localUsername = `bob-${suffix}`;
  const oauthApp = new Elysia().use(oauthPlugin);
  let ldapPort = 0;
  let ldapServer: Server | undefined;
  let originalGeneral: typeof adminSettings.$inferSelect | undefined;
  let originalLdap: typeof adminSettings.$inferSelect | undefined;

  const request = (method: string, path: string, token?: string, body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  const login = async (username: string, password: string, browserSession = true): Promise<Response> =>
    request("POST", "/api/v2/users/login", undefined, {
      data: { attributes: { username, password, "browser-session": browserSession } },
    });

  const setLdapSettings = async (enabled: boolean, overrides: Record<string, unknown> = {}): Promise<void> => {
    const values = {
      enabled,
      host: "127.0.0.1",
      port: ldapPort,
      encryption: "plain",
      "bind-dn": SERVICE_DN,
      "bind-password": SERVICE_PASSWORD,
      "base-dn": "dc=example,dc=com",
      "user-filter": "(uid={{username}})",
      "attr-username": "uid",
      "attr-email": "mail",
      "attr-display-name": "cn",
      ...overrides,
    };
    await db.insert(adminSettings).values({ id: "ldap", values, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
    invalidateSettingsCache();
    invalidatePingSsoCache();
  };

  const setLocalAuth = async (enabled: boolean): Promise<void> => {
    const values = enabled
      ? { "local-auth-enabled": true, "limit-user-organization-creation": false }
      : { "local-auth-enabled": false, "limit-user-organization-creation": false };
    await db.insert(adminSettings).values({ id: "general", values, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
    invalidateSettingsCache();
    invalidatePingSsoCache();
  };

  beforeAll(async () => {
    originalGeneral = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "general") });
    originalLdap = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "ldap") });
    const started = await startLdapMock();
    ldapServer = started.server;
    ldapPort = started.port;

    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: localId, username: localUsername, email: `local-${localUsername}@example.com`, passwordHash: await Bun.password.hash("local-pass", { algorithm: "bcrypt", cost: 10 }) },
    ]);
    await db.insert(apiTokens).values({
      id: `api-ldap-${suffix}`,
      token: createHash("sha256").update(adminToken).digest("hex"),
      userId: adminId,
    });
    await setLdapSettings(true);
    await setLocalAuth(true);
  });

  afterAll(async () => {
    const server = ldapServer;
    try {
      if (server !== undefined) {
        await new Promise<void>((resolve, reject): void => {
          server.close((error?: Error): void => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      }
    } finally {
      // Database restoration must run even if server.close rejects.
      if (originalLdap === undefined) {
        await db.delete(adminSettings).where(eq(adminSettings.id, "ldap"));
      } else {
        await db.update(adminSettings).set({ values: originalLdap.values, updatedAt: Date.now() })
          .where(eq(adminSettings.id, "ldap"));
      }
      if (originalGeneral === undefined) {
        await db.delete(adminSettings).where(eq(adminSettings.id, "general"));
      } else {
        await db.update(adminSettings).set({ values: originalGeneral.values, updatedAt: Date.now() })
          .where(eq(adminSettings.id, "general"));
      }
      invalidateSettingsCache();
      const provisioned = await db.query.users.findMany({ where: inArray(users.username, [ldapUsername, localUsername]) });
      const ids = [adminId, localId, ...provisioned.map((row): string => row.id)];
      await db.delete(apiTokens).where(inArray(apiTokens.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
  });

  test("provisions a new user on successful directory credentials", async () => {
    const response = await login(ldapUsername, VALID_USER_PASSWORD, true);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { attributes: { token: string } } };
    expect(body.data.attributes.token).toMatch(/^user-/);

    const created = await db.query.users.findFirst({ where: eq(users.username, ldapUsername) });
    expect(created).not.toBeUndefined();
    expect(created?.ssoProvider).toBe("ldap");
    expect(created?.ssoSubject).toBe(USER_DN(ldapUsername));
    expect(created?.email).toBe(`${ldapUsername}@example.com`);
  });

  test("rejects wrong directory credentials", async () => {
    const response = await login(ldapUsername, "wrong-password", true);
    expect(response.status).toBe(401);
  });

  test("refuses to authenticate when the directory match is ambiguous", async () => {
    // The mock returns two entries whose uid equals the presented username;
    // binding an arbitrary one would sign the caller in as the wrong identity.
    const response = await login("duplicate", VALID_USER_PASSWORD, true);
    expect(response.status).toBe(401);
  });

  test("rejects a username that is missing from the directory", async () => {
    const response = await login("carol", VALID_USER_PASSWORD, true);
    expect(response.status).toBe(401);
  });

  test("returns a non-browser token for API logins", async () => {
    const response = await login(ldapUsername, VALID_USER_PASSWORD, false);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { attributes: { token: string } } };
    expect(body.data.attributes.token).toMatch(/^user-/);
    expect(response.headers.getSetCookie().some((value): boolean => value.startsWith("terrence_refresh="))).toBeFalse();
  });

  test("falls back to local password when the directory rejects", async () => {
    // The local user also exists in the directory with VALID_USER_PASSWORD.
    // Logging in with the local password must still work when local auth is on.
    const response = await login(localUsername, "local-pass", true);
    expect(response.status).toBe(200);
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, localId) });
    expect(refreshed?.ssoProvider).toBeNull();
  });

  test("honours local-auth-disabled: LDAP only, no local fallback", async () => {
    await setLocalAuth(false);
    try {
      // LDAP credentials still work.
      const ldapOk = await login(ldapUsername, VALID_USER_PASSWORD, true);
      expect(ldapOk.status).toBe(200);
      // Local-only credentials are rejected even if a local account exists.
      const localRejected = await login(localUsername, "local-pass", true);
      expect(localRejected.status).toBe(401);
    } finally {
      await setLocalAuth(true);
    }
  });

  test("uses LDAP for Terraform CLI authorization when local auth is disabled", async () => {
    const verifier = "ldap-cli-verifier-012345678901234567890123456789";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const parameters = new URLSearchParams({
      client_id: "terraform-cli",
      code_challenge: Buffer.from(digest).toString("base64url"),
      code_challenge_method: "S256",
      redirect_uri: "http://localhost:10000/login",
      response_type: "code",
      state: `ldap-cli-${suffix}`,
      username: ldapUsername,
      password: VALID_USER_PASSWORD,
    });
    await setLocalAuth(false);
    try {
      // With LDAP enabled, the authorizer still presents the username/password
      // form even though local authentication is disabled: the directory
      // accepts those credentials on the POST path.
      const page = await oauthApp.handle(new Request(`http://localhost/oauth/authorization?${parameters.toString()}`));
      const html = await page.text();
      expect(html).toContain('id="username"');
      expect(html).toContain('id="password"');
      const authorization = await oauthApp.handle(new Request("http://localhost/oauth/authorization", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: parameters,
      }));
      expect(authorization.status).toBe(302);
      const callback = new URL(authorization.headers.get("Location") ?? "");
      const token = await oauthApp.handle(new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from("terraform-cli:").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: "terraform-cli",
          code: callback.searchParams.get("code") ?? "",
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: "http://localhost:10000/login",
        }),
      }));
      expect(token.status).toBe(200);
    } finally {
      await setLocalAuth(true);
    }
  });

  test("blocks provisioning when the username is already in use locally", async () => {
    const response = await login(localUsername, VALID_USER_PASSWORD, true);
    expect(response.status).toBe(401);
    const bob = await db.query.users.findFirst({ where: eq(users.id, localId) });
    expect(bob?.ssoProvider).toBeNull();
  });

  test("disabled LDAP falls back to local authentication entirely", async () => {
    await setLdapSettings(false);
    try {
      const ok = await login(localUsername, "local-pass", true);
      expect(ok.status).toBe(200);
      const rejected = await login(ldapUsername, VALID_USER_PASSWORD, true);
      expect(rejected.status).toBe(401);
    } finally {
      await setLdapSettings(true);
    }
  });

  test("rejects local password sign-in when local authentication is disabled and LDAP is off", async () => {
    await setLdapSettings(false);
    await setLocalAuth(false);
    try {
      const response = await login(localUsername, "local-pass", true);
      expect(response.status).toBe(401);
      const noLocal = await request("POST", "/api/v2/users/login", undefined, {
        data: { attributes: { username: "does-not-exist", password: "x", "browser-session": true } },
      });
      expect(noLocal.status).toBe(401);
    } finally {
      await setLdapSettings(true);
      await setLocalAuth(true);
    }
  });

  test("fails closed when a bind DN is set without a bind password", async () => {
    // A bind DN with an empty password would be an unauthenticated bind
    // (RFC 4511 §4.2); the login must fail rather than silently downgrade.
    await setLocalAuth(false);
    await setLdapSettings(true, { "bind-dn": SERVICE_DN, "bind-password": null });
    try {
      const response = await login(ldapUsername, VALID_USER_PASSWORD, true);
      expect(response.status).toBe(401);
    } finally {
      await setLdapSettings(true);
      await setLocalAuth(true);
    }
  });

  test("exposes the local-auth and SSO state through the public ping endpoint", async () => {
    const enabled = await request("GET", "/api/v2/ping");
    expect(enabled.status).toBe(200);
    const enabledBody = await enabled.json() as {
      "local-auth-enabled": boolean;
      sso: { saml: boolean; oidc: boolean; ldap: boolean };
    };
    expect(enabledBody["local-auth-enabled"]).toBe(true);
    expect(enabledBody.sso.ldap).toBe(true);

    await setLdapSettings(false);
    await setLocalAuth(false);
    try {
      const disabled = await request("GET", "/api/v2/ping");
      const disabledBody = await disabled.json() as {
        "local-auth-enabled": boolean;
        sso: { saml: boolean; oidc: boolean; ldap: boolean };
      };
      expect(disabledBody["local-auth-enabled"]).toBe(false);
      expect(disabledBody.sso.ldap).toBe(false);
    } finally {
      await setLdapSettings(true);
      await setLocalAuth(true);
    }
  });

  test("validates LDAP admin settings and persists them", async () => {
    try {
      const getResponse = await request("GET", "/api/v2/admin/ldap-settings", adminToken);
      expect(getResponse.status).toBe(200);
      const attrs = ((await getResponse.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
      expect(attrs).toMatchObject({ enabled: true, host: "127.0.0.1", port: ldapPort, encryption: "plain" });
      // The bind password is a secret: the admin API must never echo it back.
      expect(attrs["bind-password"]).not.toBe(SERVICE_PASSWORD);

      const badPort = await request("PATCH", "/api/v2/admin/ldap-settings", adminToken, {
        data: { attributes: { port: "not-a-number" } },
      });
      expect(badPort.status).toBe(422);

      const missingHost = await request("PATCH", "/api/v2/admin/ldap-settings", adminToken, {
        data: { attributes: { enabled: true, host: null } },
      });
      expect(missingHost.status).toBe(422);

      const missingPlaceholder = await request("PATCH", "/api/v2/admin/ldap-settings", adminToken, {
        data: { attributes: { "user-filter": "(uid=static)" } },
      });
      expect(missingPlaceholder.status).toBe(422);

    // A bind DN without a bind password would be an unauthenticated bind;
    // the admin API must reject the configuration up front.
      const bindDnWithoutPassword = await request("PATCH", "/api/v2/admin/ldap-settings", adminToken, {
        data: { attributes: { "bind-dn": SERVICE_DN, "bind-password": null } },
      });
      expect(bindDnWithoutPassword.status).toBe(422);

      const saved = await request("PATCH", "/api/v2/admin/ldap-settings", adminToken, {
        data: { attributes: { "user-filter": "(cn={{username}})", encryption: "starttls" } },
      });
      expect(saved.status).toBe(200);
      const savedAttrs = ((await saved.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
      expect(savedAttrs).toMatchObject({
        "user-filter": "(cn={{username}})",
        encryption: "starttls",
        host: "127.0.0.1",
        "base-dn": "dc=example,dc=com",
      });
    } finally {
      await setLdapSettings(true);
    }
  });
});
