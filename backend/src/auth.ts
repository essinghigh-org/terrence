import { Elysia } from "elysia";
import { db } from "./db";
import { apiTokens, users, teams } from "./db/schema";
import { eq } from "drizzle-orm";

export const authPlugin = new Elysia({ name: 'auth' })
  .derive({ as: 'global' }, async ({ request }) => {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { user: null, token: null, orgId: null, teamId: null };
    }

    const tokenString = authHeader.substring(7);
    const token = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.token, tokenString)
    });

    if (!token) {
      return { user: null, token: null, orgId: null, teamId: null };
    }

    const now = Date.now();
    if (token.expiresAt !== null && token.expiresAt <= now) {
      return { user: null, token: null, orgId: null, teamId: null };
    }

    if (!token.lastUsedAt || now - token.lastUsedAt > 60000) {
      db.update(apiTokens)
        .set({ lastUsedAt: now })
        .where(eq(apiTokens.id, token.id))
        .catch(console.error);
    }
    const usedToken = { ...token, lastUsedAt: now };

    if (token.userId) {
      const user = await db.query.users.findFirst({
          where: eq(users.id, token.userId)
      });
      return { user, token: usedToken, orgId: null, teamId: null };
    }

    if (token.teamId) {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, token.teamId)
      });
      return { user: null, token: usedToken, orgId: team?.orgId || token.orgId, teamId: token.teamId };
    }

    if (token.orgId) {
      return { user: null, token: usedToken, orgId: token.orgId, teamId: null };
    }

    return { user: null, token: null, orgId: null, teamId: null };
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
