import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizationMemberships, organizations, users } from "../../src/db/schema";
import { bootstrapInitialAdmin } from "../../src/lib/bootstrap";

// The first-user site-admin election must be single-source: only the
// ADMIN_PASSWORD bootstrap (and the installer IACT bootstrap) may create the
// initial site admin. Local signup never elects one, which eliminates the
// concurrent-signup race where two requests both counted zero users and both
// inserted a site admin on PostgreSQL.
describe("initial site-admin election", () => {
  const previousAdminPassword = process.env.ADMIN_PASSWORD;

  afterAll(async () => {
    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousAdminPassword;
  });

  test("bootstrap creates the initial site admin on an empty instance", async () => {
    process.env.ADMIN_PASSWORD = "bootstrap-admin-1";
    let adminId = "";
    try {
      const result = await bootstrapInitialAdmin();
      expect(result).toBe("created");
      const admin = await db.query.users.findFirst({ where: eq(users.username, "admin") });
      expect(admin?.isSiteAdmin).toBe(true);
      // The bootstrap id is random (user-<uuid>); retain it for cleanup.
      adminId = admin?.id ?? "";
    } finally {
      if (adminId !== "") await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, adminId));
      await db.delete(users).where(eq(users.username, "admin"));
    }
  });

  test("local signup on an empty instance does NOT create a site admin", async () => {
    const username = `signup-${crypto.randomUUID()}`;
    const response = await app.handle(new Request("http://localhost/api/v2/users", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "users", attributes: { username, password: "signup-password" } },
      }),
    }));
    expect(response.status).toBe(201);
    const registered = (await response.json()).data as { attributes: { "is-site-admin": boolean }; id: string };
    expect(registered.attributes["is-site-admin"]).toBe(false);
    const row = await db.query.users.findFirst({ where: eq(users.username, username) });
    expect(row?.isSiteAdmin).toBe(false);
    await db.delete(users).where(eq(users.id, registered.id));
  });

  test("bootstrap still works after a signup user exists (no duplicate election)", async () => {
    // Seed one non-admin user, then bootstrap: it must skip, not promote.
    const username = `seeded-${crypto.randomUUID()}`;
    const signup = await app.handle(new Request("http://localhost/api/v2/users", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "users", attributes: { username, password: "seed-password" } },
      }),
    }));
    expect(signup.status).toBe(201);
    process.env.ADMIN_PASSWORD = "bootstrap-admin-2";
    let adminId = "";
    try {
      const result = await bootstrapInitialAdmin();
      expect(result).toBe("skipped");
      const signupRow = await db.query.users.findFirst({ where: eq(users.username, username) });
      expect(signupRow?.isSiteAdmin).toBe(false);
    } finally {
      await db.delete(users).where(eq(users.username, username));
      const admin = await db.query.users.findFirst({ where: eq(users.username, "admin") });
      adminId = admin?.id ?? "";
      if (adminId !== "") await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, adminId));
      await db.delete(users).where(eq(users.username, "admin"));
    }
  });

  // Clean up the default org the bootstrap may have created when it ran.
  afterAll(async () => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, "default") });
    if (org !== undefined) {
      await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, org.id));
      await db.delete(organizations).where(eq(organizations.id, org.id));
    }
  });
});
