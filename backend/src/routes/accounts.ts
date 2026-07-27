import { Elysia } from "elysia";
import { db } from "../db";
import { users, apiTokens, organizations } from "../db/schema";
import { eq, count } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { userResource } from "../lib/response";
import { isUniqueConstraintError } from "../lib/validation";
import { auditLog, checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

export const accountRoutes = new Elysia({ name: "accounts" })
  // Public routes (no auth required)
  .post("/api/v2/users/login", async ({ body, set }) => {
    let payload;
    if (typeof body === 'string') {
        try {
            payload = JSON.parse(body);
        } catch (e) {
            set.status = 400;
            return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON string" }] };
        }
    } else {
        payload = body;
    }

    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing credentials" }] };
    }

    const user = await db.query.users.findFirst({
      where: eq(users.username, username)
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
    }

    const tokenStr = `user-${crypto.randomUUID()}`;
    const tokenId = crypto.randomUUID();

    const tokenHash = createHash("sha256").update(tokenStr).digest("hex");
    await db.insert(apiTokens).values({
      id: tokenId,
      token: tokenHash,
      userId: user.id,
      description: "User login token",
      createdAt: Date.now(),
    });

    return {
      data: {
        id: tokenId,
        type: "tokens",
        attributes: {
          token: tokenStr
        }
      }
    };
  })
  .post("/api/v2/users", async ({ body, set }) => {
    const payload = body as any;
    const { username, password, email } = payload?.data?.attributes || {};

    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    if (password.length < 10) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Password must be at least 10 characters" }] };
    }
    if (email !== undefined && email !== null && typeof email !== "string") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string" }] };
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.username, username)
    });
    if (existing) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const normalizedEmail = typeof email === "string" && email.trim() ? email.trim() : null;

    try {
      const isSiteAdmin = await db.transaction(async (tx) => {
        const userCount = (await tx.select({ val: count() }).from(users))[0]?.val ?? 0;
        const admin = userCount === 0;
        await tx.insert(users).values({ id, username, email: normalizedEmail, passwordHash, isSiteAdmin: admin });
        return admin;
      });
      await auditLog("create", "users", id, null, null, { username });
      set.status = 201;
      return {
        data: {
          id,
          type: "users",
          attributes: { username, email: normalizedEmail, "is-site-admin": isSiteAdmin }
        }
      };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
        set.status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
      }
      throw e;
    }
  })
  .use(authPlugin)
  .get("/api/v2/account/details", async ({ user, orgId, tokenError, set }) => {
    // Return 401 for invalid or expired tokens (distinct from "no auth" → 404)
    if (tokenError) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: tokenError === "expired" ? "Token expired" : "Invalid token" }] };
    }
    if (user) return { data: userResource(user) };

    const org = orgId
      ? await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })
      : null;
    if (!org) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const synthetic = { id: `service-user-${org.id}`, username: `${org.name}-service-user` };
    return { data: userResource(synthetic, { id: org.id, type: "organizations" }) };
  })
  .patch("/api/v2/account/update", async ({ user, body, set }) => {
    if (!user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes;
    if (!attributes || typeof attributes !== "object") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    const changes: { username?: string; email?: string | null } = {};
    if (Object.hasOwn(attributes, "username")) {
      if (typeof attributes.username !== "string" || !attributes.username.trim()) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username cannot be empty" }] };
      }
      changes.username = attributes.username.trim();
    }
    if (Object.hasOwn(attributes, "email")) {
      if (attributes.email !== null && (typeof attributes.email !== "string" || !attributes.email.trim())) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string or null" }] };
      }
      changes.email = attributes.email === null ? null : attributes.email.trim();
    }
    if (Object.keys(changes).length === 0) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No account fields provided" }] };
    }

    try {
      await db.update(users).set(changes).where(eq(users.id, user.id));
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        set.status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Username is already in use" }] };
      }
      throw error;
    }

    return { data: userResource({ ...user, ...changes }) };
  })
  .patch("/api/v2/account/password", async ({ user, body, set }) => {
    if (!user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes || {};
    const currentPassword = attributes.current_password ?? attributes["current-password"];
    const password = attributes.password;
    const confirmation = attributes.password_confirmation ?? attributes["password-confirmation"];
    if (!currentPassword || !password || password !== confirmation || password.length < 10) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid password change request" }] };
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Current password is incorrect" }] };
    }

    await db.update(users).set({ passwordHash: await bcrypt.hash(password, 10) }).where(eq(users.id, user.id));
    return { data: userResource(user) };
  });
