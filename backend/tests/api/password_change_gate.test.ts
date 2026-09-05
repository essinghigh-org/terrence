import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { hashPassword } from "../../src/lib/password-hashing";
import { eq } from "drizzle-orm";

// Issue #570: a forced password change gates every authenticated surface
// (allow-list: account-read, password-change, logout, and session refresh
// are exempt), including /mcp, and lifts once the password is changed.
describe("forced password change gates all surfaces (#570)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const userId = `usr-pwflag-${suffix}`;
  const token = `token-pwflag-${suffix}`;
  const currentPassword = `Old-password-99-${suffix}!`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const passwordTitle = async (res: Response): Promise<string | undefined> => {
    const body = await res.json() as { errors?: { title?: string }[] };
    return body.errors?.[0]?.title;
  };

  beforeAll(async () => {
    await db.insert(users).values({
      id: userId,
      username: userId,
      passwordHash: await hashPassword(currentPassword),
      mustChangePassword: true,
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.id, `tok-${suffix}`)).catch((): void => {});
    await db.delete(users).where(eq(users.id, userId)).catch((): void => {});
  });

  it("leaves account details readable", async () => {
    expect((await request("/api/v2/account/details")).status).toBe(200);
  });

  it("blocks API surfaces with Password Change Required", async () => {
    const res = await request("/api/v2/organizations");
    expect(res.status).toBe(403);
    expect(await passwordTitle(res)).toBe("Password Change Required");
  });

  it("blocks the MCP surface with Password Change Required", async () => {
    const res = await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
    expect(await passwordTitle(res)).toBe("Password Change Required");
  });

  it("leaves logout and session refresh open during the gate", async () => {
    expect((await request("/api/v2/users/logout", "POST")).status).not.toBe(403);
    expect((await request("/api/v2/users/refresh", "POST")).status).not.toBe(403);
  });

  it("lifts the gate once the password is changed", async () => {
    const changeRes = await request("/api/v2/account/password", "PATCH", {
      data: {
        type: "password",
        attributes: {
          current_password: currentPassword,
          password: `New-password-99-${suffix}!`,
          password_confirmation: `New-password-99-${suffix}!`,
        },
      },
    });
    expect(changeRes.status).toBe(200);
    const retry = await request("/api/v2/organizations");
    expect(retry.status).toBe(200);
    expect(await passwordTitle(retry)).not.toBe("Password Change Required");
  });
});
