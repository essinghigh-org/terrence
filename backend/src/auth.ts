import { Elysia } from "elysia";
import { db } from "./db";
import { apiTokens, users } from "./db/schema";
import { eq } from "drizzle-orm";

export const authPlugin = new Elysia({ name: 'auth' })
  .derive({ as: 'global' }, async ({ request }) => {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { user: null, token: null, orgId: null };
    }

    const tokenString = authHeader.substring(7);
    const token = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.token, tokenString)
    });

    if (!token) {
      return { user: null, token: null, orgId: null };
    }

    if (token.userId) {
      const user = await db.query.users.findFirst({
          where: eq(users.id, token.userId)
      });
      return { user, token, orgId: null };
    }

    if (token.orgId) {
      return { user: null, token, orgId: token.orgId };
    }

    return { user: null, token: null, orgId: null };
  })
  .macro({
    isAuth(value: boolean) {
      return {
        beforeHandle({ user, token, set }) {
          if (!value) return;
          if (!token) {
              set.status = 401;
              return { errors: [{ status: "401", title: "Unauthorized" }] };
          }
        }
      };
    }
  });
