import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import ldap from "ldapjs";
import type { Server } from "ldapjs";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { adminSettings, apiTokens, users } from "../../src/db/schema";

const SERVICE_DN = "cn=admin,dc=example,dc=com";
const USER_DN = (username: string): string => `uid=${username},dc=example,dc=com`;
const VALID_USER_PASSWORD = "ldap-pass";

function startLdapMock(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject): void => {
    const server = ldap.createServer();
    server.bind("dc=example,dc=com", (req: ldap.BindRequest, res: ldap.Response, next: ldap.NextCallback): void => {
      const dn = req.dn.toString();
      if (dn === SERVICE_DN || req.credentials === VALID_USER_PASSWORD) {
        res.end();
        next();
        return;
      }
      next(new ldap.InvalidCredentialsError());
    });
    server.bind("cn=admin", (_req, res, next): void => { res.end(); next(); });

    // The mock directory knows exactly two users.
    server.search("dc=example,dc=com", (req, res, next): void => {
      const value = req.filter.value ?? req.filter.attributeValue;
      const username = typeof value === "string" && value !== "" ? value : "alice";
      const dn = USER_DN(username);
      if (username === "carol") {
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

    server.on("error", (): void => undefined);
    server.listen(0, "127.0.0.1", (): void => {
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
  let ldapPort = 0;
  let ldapServer: Server | undefined;

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
      "bind-password": "service-secret",
      "base-dn": "dc=example,dc=com",
      "user-filter": "(uid={{username}})",
      "attr-username": "uid",
      "attr-email": "mail",
      "attr-display-name": "cn",
      ...overrides,
    };
    await db.insert(adminSettings).values({ id: "ldap", values, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
  };

  const setLocalAuth = async (enabled: boolean): Promise<void> => {
    const values = enabled
      ? { "local-auth-enabled": true, "limit-user-organization-creation": false }
      : { "local-auth-enabled": false, "limit-user-organization-creation": false };
    await db.insert(adminSettings).values({ id: "general", values, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: adminSettings.id, set: { values, updatedAt: Date.now() } });
  };

  beforeAll(async () => {
    const started = await startLdapMock();
    ldapServer = started.server;
    ldapPort = started.port;

    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: localId, username: "bob", email: "local-bob@example.com", passwordHash: await bcrypt.hash("local-pass", 10) },
    ]);
    await db.insert(apiTokens).values({
      id: `api-ldap-${suffix}`,
      token: createHash("sha256").update(adminToken).digest("hex"),
      userId: adminId,
    });
    await setLdapSettings(true);
  });

  afterAll(async () => {
    ldapServer?.close();
    await db.delete(adminSettings).where(eq(adminSettings.id, "ldap"));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, localId]));
    await db.delete(users).where(inArray(users.id, [adminId, localId]));
  });

  test("provisions a new user on successful directory credentials", async () => {
    const response = await login("alice", VALID_USER_PASSWORD, true);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { attributes: { token: string } } };
    expect(body.data.attributes.token).toMatch(/^user-/);

    const created = await db.query.users.findFirst({ where: eq(users.username, "alice") });
    expect(created).not.toBeUndefined();
    expect(created?.ssoProvider).toBe("ldap");
    expect(created?.ssoSubject).toBe(USER_DN("alice"));
    expect(created?.email).toBe("alice@example.com");
  });

  test("rejects wrong directory credentials", async () => {
    const response = await login("alice", "wrong-password", true);
    expect(response.status).toBe(401);
  });

  test("returns a non-browser token for API logins", async () => {
    const response = await login("alice", "ldap-pass", false);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { attributes: { token: string } } };
    expect(body.data.attributes.token).toMatch(/^user-/);
  });

  test("falls back to local password when the directory rejects", async () => {
    // "bob" exists locally; the directory also has bob but with VALID_USER_PASSWORD.
    // Logging in with bob's local password must still work when local auth is on.
    const response = await login("bob", "local-pass", true);
    expect(response.status).toBe(200);
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, localId) });
    expect(refreshed?.ssoProvider).toBeNull();
  });

  test("honours local-auth-disabled: LDAP only, no local fallback", async () => {
    await setLocalAuth(false);
    try {
      // LDAP credentials still work.
      const ldapOk = await login("alice", "ldap-pass", true);
      expect(ldapOk.status).toBe(200);
      // Local-only credentials are rejected even if a local account exists.
      const localRejected = await login("bob", "local-pass", true);
      expect(localRejected.status).toBe(401);
    } finally {
      await setLocalAuth(true);
    }
  });

  test("blocks provisioning when the username is already in use locally", async () => {
    const response = await login("bob", "ldap-pass", true);
    expect(response.status).toBe(401);
    const bob = await db.query.users.findFirst({ where: eq(users.id, localId) });
    expect(bob?.ssoProvider).toBeNull();
  });

  test("disabled LDAP falls back to local authentication entirely", async () => {
    await setLdapSettings(false);
    try {
      const ok = await login("bob", "local-pass", true);
      expect(ok.status).toBe(200);
      const rejected = await login("alice", "ldap-pass", true);
      expect(rejected.status).toBe(401);
    } finally {
      await setLdapSettings(true);
    }
  });

  test("rejects local password sign-in when local authentication is disabled and LDAP is off", async () => {
    await setLdapSettings(false);
    await setLocalAuth(false);
    try {
      const response = await login("bob", "local-pass", true);
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
      const response = await login("alice", VALID_USER_PASSWORD, true);
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
    const getResponse = await request("GET", "/api/v2/admin/ldap-settings", adminToken);
    expect(getResponse.status).toBe(200);
    const attrs = ((await getResponse.json()) as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(attrs).toMatchObject({ enabled: true, host: "127.0.0.1", port: ldapPort, encryption: "plain" });

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
    expect(savedAttrs).toMatchObject({ "user-filter": "(cn={{username}})", encryption: "starttls" });
    await setLdapSettings(true);
  });
});