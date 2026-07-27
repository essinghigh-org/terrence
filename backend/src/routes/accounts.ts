import { Elysia } from "elysia";
import { db } from "../db";
import { users, apiTokens, organizations } from "../db/schema";
import { eq, count } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { type userResource } from "../lib/response";
import { isUniqueConstraintError } from "../lib/validation";
import { auditLog } from "../lib/utils";
import { authPlugin } from "../auth";

type Attrs = Record<string, unknown>;
type DataPayload = { readonly data?: { readonly attributes?: Attrs; readonly type?: string; readonly id?: string } };

function extractAttrs(body: unknown): Attrs | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const payload = body as DataPayload;
  return payload.data?.attributes;
}

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ReqCtx = Readonly<{
  body?: unknown;
  set: SetObj;
}>;

type AuthReqCtx = Readonly<{
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  tokenError?: string | null;
  body?: unknown;
  set: SetObj;
}>;

export const accountRoutes = new Elysia({ name: "accounts" })
  // Public routes (no auth required)
  .post("/api/v2/users/login", async ({ body, set }: ReqCtx): Promise<unknown> => {
    let payload: DataPayload | undefined;
    if (typeof body === "string") {
      try {
        payload = JSON.parse(body) as DataPayload;
      } catch {
        (set as { status: number }).status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON string" }] };
      }
    } else if (body !== null && typeof body === "object") {
      payload = body;
    }

    const attrs = payload?.data?.attributes ?? {};
    const username = typeof attrs.username === "string" ? attrs.username : "";
    const password = typeof attrs.password === "string" ? attrs.password : "";

    if (username === "" || password === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing credentials" }] };
    }

    const user = await db.query.users.findFirst({
      where: eq(users.username, username),
    });

    if (user === undefined || !(await bcrypt.compare(password, user.passwordHash))) {
      (set as { status: number }).status = 401;
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
          token: tokenStr,
        },
      },
    };
  })
  .post("/api/v2/users", async ({ body, set }: ReqCtx): Promise<unknown> => {
    const attrs = extractAttrs(body) ?? {};
    const username = typeof attrs.username === "string" ? attrs.username : "";
    const password = typeof attrs.password === "string" ? attrs.password : "";
    const email = attrs.email;

    if (username === "" || password === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    if (password.length < 10) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Password must be at least 10 characters" }] };
    }
    if (email !== undefined && email !== null && typeof email !== "string") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string" }] };
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.username, username),
    });
    if (existing !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const normalizedEmail = typeof email === "string" && email.trim() !== "" ? email.trim() : null;

    try {
      const isSiteAdmin = await db.transaction(async (tx: unknown): Promise<boolean> => {
        const t = tx as typeof db;
        const userCount = (await t.select({ val: count() }).from(users))[0]?.val ?? 0;
        const admin = userCount === 0;
        await t.insert(users).values({ id, username, email: normalizedEmail, passwordHash, isSiteAdmin: admin });
        return admin;
      });
      await auditLog("create", "users", id, null, null, { username });
      (set as { status: number }).status = 201;
      return {
        data: {
          id,
          type: "users",
          attributes: { username, email: normalizedEmail, "is-site-admin": isSiteAdmin },
        },
      };
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
      }
      throw e;
    }
  })
  .use(authPlugin)
  .get("/api/v2/account/details", async ({ user, orgId, tokenError, set }: AuthReqCtx): Promise<unknown> => {
    // Return 401 for invalid or expired tokens (distinct from "no auth" → 404)
    if (tokenError !== null && tokenError !== undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: tokenError === "expired" ? "Token expired" : "Invalid token" }] };
    }
    if (user !== null && user !== undefined) return { data: userResource(user) };

    const org = orgId !== null && orgId !== undefined
      ? await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })
      : null;
    if (org === null || org === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const synthetic = { id: `service-user-${org.id}`, username: `${org.name}-service-user` };
    return { data: userResource(synthetic, { id: org.id, type: "organizations" }) };
  })
  .patch("/api/v2/account/update", async ({ user, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attrs = extractAttrs(body);
    if (attrs === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    const changes: { username?: string; email?: string | null } = {};
    if (Object.hasOwn(attrs, "username")) {
      if (typeof attrs.username !== "string" || attrs.username.trim() === "") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username cannot be empty" }] };
      }
      changes.username = attrs.username.trim();
    }
    if (Object.hasOwn(attrs, "email")) {
      const emailVal = attrs.email;
      if (emailVal !== null && (typeof emailVal !== "string" || emailVal.trim() === "")) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string or null" }] };
      }
      changes.email = emailVal === null ? null : emailVal.trim();
    }
    if (Object.keys(changes).length === 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No account fields provided" }] };
    }

    try {
      await db.update(users).set(changes).where(eq(users.id, user.id));
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Username is already in use" }] };
      }
      throw error;
    }

    return { data: userResource({ ...user, ...changes }) };
  })
  .patch("/api/v2/account/password", async ({ user, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attrs = extractAttrs(body) ?? {};
    const currentPassword = typeof attrs.current_password === "string" ? attrs.current_password : (typeof attrs["current-password"] === "string" ? attrs["current-password"] : "");
    const password = typeof attrs.password === "string" ? attrs.password : "";
    const confirmation = typeof attrs.password_confirmation === "string" ? attrs.password_confirmation : (typeof attrs["password-confirmation"] === "string" ? attrs["password-confirmation"] : "");
    if (currentPassword === "" || password === "" || password !== confirmation || password.length < 10) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid password change request" }] };
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Current password is incorrect" }] };
    }

    await db.update(users).set({ passwordHash: await bcrypt.hash(password, 10) }).where(eq(users.id, user.id));
    return { data: userResource(user) };
  });
