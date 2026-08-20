import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDirs: string[] = [];
const backendDir = join(import.meta.dir, "../..");

async function runProbe(source: string, password: string, env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-admin-bootstrap-"));
  testDirs.push(testDir);
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
      STORAGE_DIR: join(testDir, "storage"),
      ADMIN_PASSWORD: password,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map(async (dir: string): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  }));
});

describe("initial administrator bootstrap", () => {
  it("creates one forced-change site admin and unlocks it after password rotation", async () => {
    const result = await runProbe(`
      const { bootstrapInitialAdmin } = await import("./src/lib/bootstrap.ts");
      const { db } = await import("./src/db/index.ts");
      const { organizationMemberships, organizations, users } = await import("./src/db/schema.ts");
      const { app } = await import("./src/app.ts");

      const first = await bootstrapInitialAdmin();
      const envCleared = process.env.ADMIN_PASSWORD === undefined;
      process.env.ADMIN_PASSWORD = "ignored-second-password";
      const second = await bootstrapInitialAdmin();
      const stored = await db.query.users.findMany();
      const storedOrganizations = await db.query.organizations.findMany();
      const storedMemberships = await db.query.organizationMemberships.findMany();

      const request = (path, init = {}) => app.handle(new Request("http://localhost" + path, init));
      const loginResponse = await request("/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { attributes: { username: "admin", password: "temporary-admin-password" } } }),
      });
      const login = await loginResponse.json();
      const token = login.data.attributes.token;
      const auth = { Authorization: "Bearer " + token };

      const otherLoginResponse = await request("/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { attributes: { username: "admin", password: "temporary-admin-password" } } }),
      });
      const otherToken = (await otherLoginResponse.json()).data.attributes.token;
      const detailsResponse = await request("/api/v2/account/details", { headers: auth });
      const details = await detailsResponse.json();
      const blocked = await request("/api/v2/organizations", { headers: auth });

      const changed = await request("/api/v2/account/password", {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            type: "users",
            attributes: {
              current_password: "temporary-admin-password",
              password: "permanent-admin-password",
              password_confirmation: "permanent-admin-password",
            },
          },
        }),
      });
      const currentSession = await request("/api/v2/organizations", { headers: auth });
      const revokedSession = await request("/api/v2/account/details", {
        headers: { Authorization: "Bearer " + otherToken },
      });
      const oldPassword = await request("/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { attributes: { username: "admin", password: "temporary-admin-password" } } }),
      });
      const newPassword = await request("/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { attributes: { username: "admin", password: "permanent-admin-password" } } }),
      });
      const updated = await db.query.users.findFirst();

      console.log(JSON.stringify({
        first,
        second,
        envCleared,
        count: stored.length,
        organizationCount: storedOrganizations.length,
        organizationName: storedOrganizations[0]?.name,
        organizationOwner: storedMemberships[0]?.role,
        username: stored[0]?.username,
        siteAdmin: stored[0]?.isSiteAdmin,
        loginStatus: loginResponse.status,
        loginRequiresChange: login.data.attributes["must-change-password"],
        detailsStatus: detailsResponse.status,
        detailsRequiresChange: details.data.attributes["must-change-password"],
        blockedStatus: blocked.status,
        changeStatus: changed.status,
        currentSessionStatus: currentSession.status,
        revokedSessionStatus: revokedSession.status,
        oldPasswordStatus: oldPassword.status,
        newPasswordStatus: newPassword.status,
        cleared: updated?.mustChangePassword === false,
      }));
      process.exit(0);
    `, "temporary-admin-password");

    expect(result).toEqual({
      first: "created",
      second: "skipped",
      envCleared: true,
      count: 1,
      organizationCount: 1,
      organizationName: "default",
      organizationOwner: "owner",
      username: "admin",
      siteAdmin: true,
      loginStatus: 200,
      loginRequiresChange: true,
      detailsStatus: 200,
      detailsRequiresChange: true,
      blockedStatus: 403,
      changeStatus: 200,
      currentSessionStatus: 200,
      revokedSessionStatus: 401,
      oldPasswordStatus: 401,
      newPasswordStatus: 200,
      cleared: true,
    });
  });

  it("rejects an unsafe bootstrap password without creating a user", async () => {
    const result = await runProbe(`
      const { bootstrapInitialAdmin } = await import("./src/lib/bootstrap.ts");
      const { db } = await import("./src/db/index.ts");
      let error = "";
      try {
        await bootstrapInitialAdmin();
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      console.log(JSON.stringify({ error, count: (await db.query.users.findMany()).length }));
      process.exit(0);
    `, "too-short");

    expect(result).toEqual({
      error: "ADMIN_PASSWORD must be at least 10 characters",
      count: 0,
    });
  });

  it("creates the first administrator through the IACT-compatible API exactly once", async () => {
    const result = await runProbe(`
      const { app } = await import("./src/app.ts");
      const { db } = await import("./src/db/index.ts");

      // Header form is the default bootstrap flow (todo 142/143); the query
      // form requires IACT_QUERY_TOKEN_ENABLED.
      const request = (token, body) => app.handle(new Request(
        "http://localhost/admin/initial-admin-user",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-iact-token": token },
          body: JSON.stringify(body),
        },
      ));
      const attributes = {
        username: "owner",
        email: "owner@example.test",
        password: "chosen-admin-password",
      };
      const denied = await request("wrong", attributes);
      const invalid = await request("initial-admin-token", { username: "owner" });
      const created = await request("initial-admin-token", attributes);
      const createdBody = await created.json();
      const details = await app.handle(new Request("http://localhost/api/v2/account/details", {
        headers: { Authorization: "Bearer " + createdBody.token },
      }));
      process.env.IACT_TOKEN = "initial-admin-token";
      const repeated = await request("initial-admin-token", attributes);

      console.log(JSON.stringify({
        denied: denied.status,
        invalid: invalid.status,
        created: created.status,
        responseStatus: createdBody.status,
        details: details.status,
        repeated: repeated.status,
        users: (await db.query.users.findMany()).length,
        organizations: (await db.query.organizations.findMany()).length,
        memberships: (await db.query.organizationMemberships.findMany()).length,
      }));
      process.exit(0);
    `, "unused-admin-password", { IACT_TOKEN: "initial-admin-token" });

    expect(result).toEqual({
      denied: 404,
      invalid: 422,
      created: 200,
      responseStatus: "created",
      details: 200,
      repeated: 404,
      users: 1,
      organizations: 1,
      memberships: 1,
    });
  });

  it("accepts the bootstrap secret via header as an alternative to the query string (kanban 5.3)", async () => {
    const result = await runProbe(`
      const { app } = await import("./src/app.ts");
      const { db } = await import("./src/db/index.ts");

      const request = (body) => app.handle(new Request(
        "http://localhost/admin/initial-admin-user",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-iact-token": "initial-admin-token" },
          body: JSON.stringify(body),
        },
      ));
      const attributes = {
        username: "owner",
        email: "owner@example.test",
        password: "chosen-admin-password",
      };
      const created = await request(attributes);
      const createdBody = await created.json();
      console.log(JSON.stringify({
        status: created.status,
        responseStatus: createdBody.status,
        users: (await db.query.users.findMany()).length,
      }));
      process.exit(0);
    `, "unused-admin-password", { IACT_TOKEN: "initial-admin-token" });

    expect(result).toEqual({ status: 200, responseStatus: "created", users: 1 });
  });

  it("query-token form is opt-in (IACT_QUERY_TOKEN_ENABLED) and header form is the default", async () => {
    // Default: query form disabled — even the correct token via query is 404.
    const defaultResult = await runProbe(`
      const { app } = await import("./src/app.ts");
      const { db } = await import("./src/db/index.ts");

      const attributes = {
        username: "owner",
        email: "owner@example.test",
        password: "chosen-admin-password",
      };
      const body = JSON.stringify(attributes);
      const queryForm = await app.handle(new Request(
        "http://localhost/admin/initial-admin-user?token=initial-admin-token",
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
      ));
      const headerForm = await app.handle(new Request(
        "http://localhost/admin/initial-admin-user",
        { method: "POST", headers: { "Content-Type": "application/json", "x-iact-token": "initial-admin-token" }, body },
      ));
      console.log(JSON.stringify({
        queryForm: queryForm.status,
        headerForm: headerForm.status,
        users: (await db.query.users.findMany()).length,
      }));
      process.exit(0);
    `, "unused-admin-password", { IACT_TOKEN: "initial-admin-token" });
    expect(defaultResult).toEqual({ queryForm: 404, headerForm: 200, users: 1 });

    // Opt-in restores the reference installer's query form.
    const optInResult = await runProbe(`
      const { app } = await import("./src/app.ts");
      const { db } = await import("./src/db/index.ts");

      const attributes = {
        username: "owner",
        email: "owner@example.test",
        password: "chosen-admin-password",
      };
      const body = JSON.stringify(attributes);
      const queryForm = await app.handle(new Request(
        "http://localhost/admin/initial-admin-user?token=initial-admin-token",
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
      ));
      console.log(JSON.stringify({
        queryForm: queryForm.status,
        users: (await db.query.users.findMany()).length,
      }));
      process.exit(0);
    `, "unused-admin-password", { IACT_TOKEN: "initial-admin-token", IACT_QUERY_TOKEN_ENABLED: "1" });
    expect(optInResult).toEqual({ queryForm: 200, users: 1 });
  });
});
