import { Elysia } from "elysia";
import { db } from "./db";
import { apiTokens, users, teams } from "./db/schema";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { setRequestSiteAdmin } from "./lib/request-scope";

type AuthToken = {
  id: string;
  token: string;
  userId: string | null;
  teamId: string | null;
  orgId: string | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  scopes?: string | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type HeaderGetter = { readonly get: (name: string) => string | null };
type DeriveContext = { readonly request: { readonly headers: HeaderGetter } };

const rateLimitPrincipals = new WeakMap<object, string>();

export function authenticatedRateLimitKey(request: object): string | undefined {
  return rateLimitPrincipals.get(request);
}

export function rememberRateLimitPrincipal(request: object, token: Readonly<AuthToken>): void {
  const principal = token.userId !== null
    ? `user:${token.userId}`
    : token.teamId !== null
      ? `team:${token.teamId}`
      : token.orgId !== null
        ? `organization:${token.orgId}`
        : undefined;
  if (principal !== undefined) rateLimitPrincipals.set(request, principal);
}

export const authPlugin = new Elysia({ name: "auth" })
  .derive({ as: "global" }, async ({ request }: DeriveContext): Promise<{
    user: typeof users.$inferSelect | null;
    token: AuthToken | null;
    orgId: string | null;
    teamId: string | null;
    tokenError: string | null;
  }> => {
    rateLimitPrincipals.delete(request);
    const authHeader = request.headers.get("authorization");
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      return { user: null, token: null, orgId: null, teamId: null, tokenError: null };
    }

    const tokenString = authHeader.substring(7);
    const tokenHash = hashToken(tokenString);

    // Lookup by hash. The user row is JOINed in so the common user-token path
    // costs ONE query instead of two (api_tokens + users).
    const lookup = async (): Promise<{ token: AuthToken | undefined; user: (typeof users.$inferSelect) | null }> => {
      const row = await db.select({ token: apiTokens, user: users })
        .from(apiTokens)
        .leftJoin(users, eq(users.id, apiTokens.userId))
        .where(eq(apiTokens.token, tokenHash))
        .get();
      return { token: row?.token, user: row?.user ?? null };
    };
    let { token, user } = await lookup();


    // Legacy fallback: re-hash plaintext token on successful use
    if (token === undefined) {
      const legacyToken = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.token, tokenString),
      });
      if (legacyToken !== undefined) {
        await db.update(apiTokens)
          .set({ token: tokenHash })
          .where(eq(apiTokens.id, legacyToken.id));
        token = { ...legacyToken, token: tokenHash };
        user = null;
      }
    }

    if (token === undefined) {
      return { user: null, token: null, orgId: null, teamId: null, tokenError: "invalid" };
    }

    const now = Date.now();
    if (token.expiresAt !== null && token.expiresAt <= now) {
      return { user: null, token: null, orgId: null, teamId: null, tokenError: "expired" };
    }

    if (token.lastUsedAt === null || now - token.lastUsedAt > 60000) {
      await db.update(apiTokens)
        .set({ lastUsedAt: now })
        .where(eq(apiTokens.id, token.id));
    }
    const usedToken: AuthToken = { ...token, lastUsedAt: now };
    rememberRateLimitPrincipal(request, token);

    if (token.userId !== null) {
      // The joined lookup already resolves the user for hashed tokens. Only
      // tokens found via the plaintext legacy fallback re-query (rare).
      const resolvedUser = user ?? await db.query.users.findFirst({ where: eq(users.id, token.userId) });
      if (resolvedUser?.isSuspended === true) {
        return { user: null, token: null, orgId: null, teamId: null, tokenError: "suspended" };
      }
      if (resolvedUser !== undefined) {
        setRequestSiteAdmin(resolvedUser.id, resolvedUser.isSiteAdmin === true);
      }
      return { user: resolvedUser ?? null, token: usedToken, orgId: null, teamId: null, tokenError: null };
    }

    if (token.teamId !== null) {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, token.teamId),
      });
      return { user: null, token: usedToken, orgId: null, teamId: team?.id ?? null, tokenError: team === undefined ? "invalid" : null };
    }

    if (token.orgId !== null) {
      return { user: null, token: usedToken, orgId: token.orgId, teamId: null, tokenError: null };
    }

    return { user: null, token: null, orgId: null, teamId: null, tokenError: null };
  })
  .macro({
    isAuth(value: boolean): Record<string, unknown> {
      return {
        beforeHandle({ user: _, token, set }: { readonly user?: unknown; readonly token?: unknown; readonly set: Readonly<{ status: number }> }): Record<string, unknown> | undefined {

          if (!value) return;
          if (token === null || token === undefined) {
            (set as { status: number }).status = 401;
            return { errors: [{ status: "401", title: "Unauthorized" }] };
          }
        },
      };
    },
  });
