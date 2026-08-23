import { Elysia } from "elysia";
import { db } from "./db";
import { apiTokens, runTokens, users, teams, systemApiTokens } from "./db/schema";
import { eq } from "drizzle-orm";
import { hashAuthenticationToken } from "./lib/token-service";
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

export type SystemAuthToken = Readonly<{
  id: string;
  description: string;
  expiresAt: number;
  lastUsedAt: number | null;
}>;

function hashToken(token: string): string {
  return hashAuthenticationToken(token);
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


/** Count API tokens still stored as plaintext (pre-hash migration). Used by admin diagnostics (todo 332). */
export async function countLegacyPlaintextTokens(): Promise<number> {
  // Hashed tokens are exactly 64 hex chars (SHA-256 hex); anything else is legacy plaintext.
  // Paginated scan keeps memory bounded even on a large token table; GLOB/~ dialect split
  // would require backend branching, so a single portable path is kept.
  let count = 0;
  let offset = 0;
  const pageSize = 500;
  for (;;) {
    const page = await db.select({ token: apiTokens.token }).from(apiTokens).orderBy(apiTokens.id).limit(pageSize).offset(offset);
    if (page.length === 0) break;
    for (const row of page) {
      const v = row.token;
      if (v.length !== 64 || !/^[0-9a-f]{64}$/i.test(v)) count += 1;
    }
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return count;
}


/** Bulk-migrate any remaining plaintext api_tokens to SHA-256 hashes (todo 333).
 * Idempotent: already-hashed rows are skipped. Returns the number migrated. */
export async function migrateLegacyPlaintextTokens(): Promise<number> {
  let migrated = 0;
  let offset = 0;
  const pageSize = 200;
  for (;;) {
    const page = await db.select({ id: apiTokens.id, token: apiTokens.token }).from(apiTokens).orderBy(apiTokens.id).limit(pageSize).offset(offset);
    if (page.length === 0) break;
    for (const row of page) {
      const v = row.token;
      if (v.length === 64 && /^[0-9a-f]{64}$/i.test(v)) continue;
      const hashed = hashAuthenticationToken(v);
      // Guard against accidental double-hash if two migrators race on the same row.
      const current = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, row.id) });
      if (current === undefined) continue;
      if (current.token.length === 64 && /^[0-9a-f]{64}$/i.test(current.token)) continue;
      await db.update(apiTokens).set({ token: hashed }).where(eq(apiTokens.id, row.id));
      migrated += 1;
    }
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return migrated;
}

export const authPlugin = new Elysia({ name: "auth" })
  .derive({ as: "global" }, async ({ request }: DeriveContext): Promise<{
    user: typeof users.$inferSelect | null;
    token: AuthToken | null;
    orgId: string | null;
    teamId: string | null;
    tokenError: string | null;
    run: { runId: string; workspaceId: string; organizationId: string } | null;
    systemToken?: SystemAuthToken | null;
  }> => {
    rateLimitPrincipals.delete(request);
    const authHeader = request.headers.get("authorization");
    // Scheme is case-insensitive per RFC 7235 (todo 176); the credential that
    // follows is not.
    const bearerMatch = typeof authHeader === "string" ? authHeader.match(/^bearer\s+/i) : null;
    if (bearerMatch === null) {
      return { user: null, token: null, orgId: null, teamId: null, tokenError: null , run: null };
    }

    const tokenString = (authHeader as string).slice(bearerMatch[0].length).trim();
    // Cheap rejection BEFORE any DB lookup (todo 175): a bearer token longer
    // than any legitimate credential format is garbage — hashing + querying
    // it only serves a denial-of-wallet on the database. 512 chars covers
    // every minted format (prefix + 43 base64url chars) with headroom.
    if (tokenString.length === 0 || tokenString.length > 512) {
      return { user: null, token: null, orgId: null, teamId: null, tokenError: "invalid", run: null };
    }
    const tokenHash = hashToken(tokenString);

    // Lookup by hash. The user row is JOINed in so the common user-token path
    // costs ONE query instead of two (api_tokens + users). Portable across
    // backends: .get() is sqlite-only, so use limit(1) + await (drizzle query
    // builders are thenable on both dialects).
    const isRunPrefix = tokenString.startsWith("trun_");
    const isSystemPrefix = tokenString.startsWith("tfe-system-");
    const lookup = async (): Promise<{ token: AuthToken | undefined; user: (typeof users.$inferSelect) | null }> => {
      const rows = await db.select({ token: apiTokens, user: users })
        .from(apiTokens)
        .leftJoin(users, eq(users.id, apiTokens.userId))
        .where(eq(apiTokens.token, tokenHash))
        .limit(1);
      const row = rows[0];
      return { token: row?.token, user: row?.user ?? null };
    };
    // Only run/system credentials have dedicated tables. Other prefixed
    // credentials still use the indexed API-token lookup.
    const skipApiLookup = isRunPrefix || isSystemPrefix;
    let { token, user } = skipApiLookup ? { token: undefined, user: null } : await lookup();


    // Legacy fallback: re-hash plaintext token on successful use (todo 331).
    // Legacy plaintext rows are an explicit migration escape hatch, never the
    // default authentication path.
    const allowLegacyTokens = process.env.TERRENCE_ALLOW_LEGACY_TOKENS === "1";
    if (allowLegacyTokens && token === undefined) {
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

    // Run tokens: ephemeral worker credentials (the reference format run-token model). They do
    // not map to a user/team/org token row; the run row carries the scope.
    // Todo 335: prefix dispatch - run tokens are `trun_`, so skip this lookup
    // for tokens whose prefix clearly indicates another credential class.
    if (token === undefined && (isRunPrefix || !isSystemPrefix)) {
      const runRows = await db.select().from(runTokens)
        .where(eq(runTokens.tokenHash, tokenHash))
        .limit(1);
      const runToken = runRows[0];
      if (runToken !== undefined) {
        const now = Date.now();
        if (runToken.revokedAt !== null) {
          return { user: null, token: null, orgId: null, teamId: null, tokenError: "revoked", run: null };
        }
        if (runToken.expiresAt <= now) {
          return { user: null, token: null, orgId: null, teamId: null, tokenError: "expired", run: null };
        }
        rateLimitPrincipals.set(request, `run:${runToken.runId}`);
        return {
          user: null,
          token: null,
          orgId: null,
          teamId: null,
          tokenError: null,
          run: { runId: runToken.runId, workspaceId: runToken.workspaceId, organizationId: runToken.organizationId },
        };
      }
    }

    // System API tokens: dedicated administrative credentials for the System
    // API listener. The hash is unique across every token table, so checking
    // them last does not change which token matches — it only keeps the
    // hot application path (api_tokens + users in one query) free of an
    // extra round trip for a rare credential class.
    if (token === undefined && (isSystemPrefix || !isRunPrefix)) {
      const systemRow = (await db.select().from(systemApiTokens)
        .where(eq(systemApiTokens.tokenHash, tokenHash)).limit(1))[0];
      if (systemRow !== undefined) {
        const now = Date.now();
        if (systemRow.revokedAt !== null) {
          return { user: null, token: null, orgId: null, teamId: null, tokenError: "revoked", run: null, systemToken: null };
        }
        if (systemRow.expiresAt <= now) {
          return { user: null, token: null, orgId: null, teamId: null, tokenError: "expired", run: null, systemToken: null };
        }
        if (systemRow.lastUsedAt === null || now - systemRow.lastUsedAt > 60000) {
          await db.update(systemApiTokens).set({ lastUsedAt: now }).where(eq(systemApiTokens.id, systemRow.id));
        }
        rateLimitPrincipals.set(request, `system:${systemRow.id}`);
        return {
          user: null,
          token: null,
          orgId: null,
          teamId: null,
          tokenError: null,
          run: null,
          systemToken: { id: systemRow.id, description: systemRow.description, expiresAt: systemRow.expiresAt, lastUsedAt: now },
        };
      }
    }

    if (token === undefined) {
      return { user: null, token: null, orgId: null, teamId: null, tokenError: "invalid", run: null };
    }

    const now = Date.now();
    if (token.expiresAt !== null && token.expiresAt <= now) {
      return { user: null, token: null, orgId: null, teamId: null, tokenError: "expired" , run: null };
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
      if ((resolvedUser as unknown as { deletedAt: number | null | undefined })?.deletedAt != null) {
        return { user: null, token: null, orgId: null, teamId: null, tokenError: "invalid" , run: null };
      }
      if (resolvedUser?.isSuspended === true) {
        return { user: null, token: null, orgId: null, teamId: null, tokenError: "suspended" , run: null };
      }
      if (resolvedUser !== undefined) {
        setRequestSiteAdmin(resolvedUser.id, resolvedUser.isSiteAdmin === true);
      }
      return { user: resolvedUser ?? null, token: usedToken, orgId: null, teamId: null, tokenError: null , run: null };
    }

    if (token.teamId !== null) {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, token.teamId),
      });
      return { user: null, token: usedToken, orgId: null, teamId: team?.id ?? null, tokenError: team === undefined ? "invalid" : null , run: null };
    }

    if (token.orgId !== null) {
      return { user: null, token: usedToken, orgId: token.orgId, teamId: null, tokenError: null , run: null };
    }

    return { user: null, token: null, orgId: null, teamId: null, tokenError: null , run: null };
  })
  .macro({
    isAuth(value: boolean): Record<string, unknown> {
      return {
        beforeHandle({ user: _, token, systemToken, set }: { readonly user?: unknown; readonly token?: unknown; readonly systemToken?: unknown; readonly set: Readonly<{ status: number }> }): Record<string, unknown> | undefined {

          if (!value) return;
          if ((token === null || token === undefined) && (systemToken === null || systemToken === undefined)) {
            (set as { status: number }).status = 401;
            return { errors: [{ status: "401", title: "Unauthorized" }] };
          }
        },
      };
    },
  });
