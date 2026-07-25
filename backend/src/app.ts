import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit } from "elysia-rate-limit";
import { db } from "./db";
import { users, apiTokens } from "./db/schema";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";

export const app = new Elysia()
  .use(rateLimit({ max: 1000, duration: 60000 }))
  .onParse(async ({ request, contentType }) => {
    if (contentType === 'application/vnd.api+json') {
      const text = await request.text();
      try {
        return JSON.parse(text);
      } catch {
        return null; // Let the handler deal with invalid JSON
      }
    }
  })
  .use(staticPlugin({
    assets: "../frontend/dist",
    prefix: "/"
  }))
  .onError(({ code, error, set }) => {
    set.headers["Content-Type"] = "application/vnd.api+json";
    if (code === "NOT_FOUND") {
      set.status = 404;
      return {
        errors: [{
          status: "404",
          title: "Not Found"
        }]
      };
    }

    // Default fallback
    set.status = 500;
    return {
      errors: [{
        status: "500",
        title: "Internal Server Error",
        detail: error.message || "An unexpected error occurred"
      }]
    };
  })
  .get("/.well-known/terraform.json", () => ({
    "tfe.v2.1": "/api/v2/",
    "tfe.v2.2": "/api/v2/",
    "state.v2": "/api/v2/",
  }))
  .get("/api", () => "Terrence API")
  .post("/api/v2/users/login", async ({ body, set }) => {
    let payload;
    if (typeof body === 'string') {
        try {
            payload = JSON.parse(body);
        } catch (e) {
            set.status = 400;
            return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON" }] };
        }
    } else {
        payload = body;
    }

    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
        set.status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    const user = await db.query.users.findFirst({
        where: eq(users.username, username)
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        set.status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid credentials" }] };
    }

    const tokenString = crypto.randomUUID() + "-" + crypto.randomUUID();
    const tokenId = crypto.randomUUID();

    await db.insert(apiTokens).values({
        id: tokenId,
        token: tokenString,
        userId: user.id,
        description: "Login token",
    });

    set.status = 201;
    return {
        data: {
            id: tokenId,
            type: "api-tokens",
            attributes: {
                token: tokenString,
            }
        }
    };
  })
  .get("/api/v2/account/details", async ({ headers, set }) => {
    const authHeader = headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        set.status = 401;
        return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    const tokenString = authHeader.substring(7);
    const token = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.token, tokenString)
    });

    if (!token || !token.userId) {
        set.status = 401;
        return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    const user = await db.query.users.findFirst({
        where: eq(users.id, token.userId)
    });

    if (!user) {
        set.status = 401;
        return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    return {
        data: {
            id: user.id,
            type: "users",
            attributes: {
                username: user.username,
            }
        }
    };
  })
  .post("/api/v2/users", async ({ body, set }) => {
    let payload;
    if (typeof body === 'string') {
        try {
            payload = JSON.parse(body);
        } catch (e) {
            set.status = 400;
            return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON" }] };
        }
    } else {
        payload = body;
    }

    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
        set.status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    try {
        const id = crypto.randomUUID();
        const passwordHash = await bcrypt.hash(password, 10);

        await db.insert(users).values({
            id,
            username,
            passwordHash
        });

        set.status = 201;
        return {
            data: {
                id,
                type: "users",
                attributes: {
                    username
                }
            }
        };
    } catch (e: any) {
        if (
            e.message?.includes("UNIQUE constraint failed") ||
            e.message?.includes("SQLITE_CONSTRAINT") ||
            e.message?.includes("UNIQUE") ||
            e.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
            e.message?.includes("SQLITE_CONSTRAINT_UNIQUE") ||
            (e.cause && e.cause.message?.includes("UNIQUE constraint failed"))
        ) {
            set.status = 409;
            return { errors: [{ status: "409", title: "Conflict", detail: "Username already exists" }] };
        }
        throw e;
    }
  })
  .get("*", ({ request, set }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) {
        set.status = 404;
        set.headers["Content-Type"] = "application/vnd.api+json";
        return {
            errors: [{
                status: "404",
                title: "Not Found"
            }]
        };
    }
    // Fallback for SPA routing
    return Bun.file("../frontend/dist/index.html");
  });

// Endpoints are not implemented yet to fulfill the TDD requirement.
// The tests will fail against this app instance.
