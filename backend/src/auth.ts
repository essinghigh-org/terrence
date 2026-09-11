import { Elysia } from "elysia";
import { db } from "./db";
import { apiTokens, refreshSessions, runTokens, users, teams, systemApiTokens } from "./db/schema";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { tokenHashCandidates } from "./lib/token-service";
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
  refreshFamilyId?: string | null;
};

export type SystemAuthToken = Readonly<{
  id: string;
  description: string;
  expiresAt: number;
  lastUsedAt: number | null;
}>;

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


type DerivedAuthContext = {
  user: typeof users.$inferSelect | null;
  token: AuthToken | null;
  orgId: string | null;
  teamId: string | null;
  tokenError: string | null;
  run: { runId: string; workspaceId: string; organizationId: string } | null;
  systemToken?: SystemAuthToken | null;
};

type BearerParse = { kind: "none" } | { kind: "invalid" } | { kind: "token"; tokenString: string };

function anonymousAuth(tokenError: string | null): DerivedAuthContext {
  return { user: null, token: null, orgId: null, teamId: null, tokenError, run: null };
}

function parseBearerCredential(request: DeriveContext["request"]): BearerParse {
  const authHeader = request.headers.get("authorization");
  if (typeof authHeader !== "string") return { kind: "none" };
  // Scheme is case-insensitive per RFC 7235 (todo 176); the credential that
  // follows is not.
  const bearerMatch = (/^bearer\s+/i.exec(authHeader));
  if (bearerMatch === null) return { kind: "none" };
  const tokenString = authHeader.slice(bearerMatch[0].length).trim();
  // Cheap rejection BEFORE any DB lookup (todo 175): a bearer token longer
  // than any legitimate credential format is garbage — hashing + querying
  // it only serves a denial-of-wallet on the database. 512 chars covers
  // every minted format (prefix + 43 base64url chars) with headroom.
  if (tokenString.length === 0 || tokenString.length > 512) return { kind: "invalid" };
  return { kind: "token", tokenString };
}

async function lookupApiToken(
  tokenHash: string,
  legacyTokenHash: string,
  tokenHashes: readonly string[],
): Promise<{ token: AuthToken | undefined; user: Readonly<typeof users.$inferSelect> | null }> {
  const rows = await db.select({ token: apiTokens, user: users })
    .from(apiTokens)
    .leftJoin(users, eq(users.id, apiTokens.userId))
    .where(inArray(apiTokens.token, tokenHashes))
    .limit(2);
  const row = rows.find((candidate): boolean => candidate.token.token === tokenHash) ?? rows[0];
  if (row?.token.token === legacyTokenHash) {
    await db.update(apiTokens).set({ token: tokenHash }).where(eq(apiTokens.id, row.token.id));
    return { token: { ...row.token, token: tokenHash }, user: row.user ?? null };
  }
  return { token: row?.token, user: row?.user ?? null };
}

async function resolveRunToken(
  request: DeriveContext["request"],
  tokenHashes: readonly string[],
  tokenHash: string,
  legacyTokenHash: string,
  isRunPrefix: boolean,
  isSystemPrefix: boolean,
): Promise<DerivedAuthContext | null> {
  // Run tokens: ephemeral worker credentials (the reference format run-token model). They do
  // not map to a user/team/org token row; the run row carries the scope.
  // Todo 335: prefix dispatch - run tokens are `trun_`, so skip this lookup
  // for tokens whose prefix clearly indicates another credential class.
  if (!(isRunPrefix || !isSystemPrefix)) return null;
  const runRows = await db.select().from(runTokens)
    .where(inArray(runTokens.tokenHash, tokenHashes))
    .limit(2);
  const runToken = runRows.find((candidate): boolean => candidate.tokenHash === tokenHash) ?? runRows[0];
  if (runToken === undefined) return null;
  if (runToken.tokenHash === legacyTokenHash) {
    await db.update(runTokens).set({ tokenHash }).where(eq(runTokens.id, runToken.id));
  }
  const now = Date.now();
  if (runToken.revokedAt !== null) {
    return anonymousAuth("revoked");
  }
  if (runToken.expiresAt <= now) {
    return anonymousAuth("expired");
  }
  rateLimitPrincipals.set(request, `run:${runToken.runId}`);
  return {
    ...anonymousAuth(null),
    run: { runId: runToken.runId, workspaceId: runToken.workspaceId, organizationId: runToken.organizationId },
  };
}

async function resolveSystemToken(
  request: DeriveContext["request"],
  tokenHashes: readonly string[],
  tokenHash: string,
  legacyTokenHash: string,
  isSystemPrefix: boolean,
  isRunPrefix: boolean,
): Promise<DerivedAuthContext | null> {
  // System API tokens: dedicated administrative credentials for the System
  // API listener. The hash is unique across every token table, so checking
  // them last does not change which token matches — it only keeps the
  // hot application path (api_tokens + users in one query) free of an
  // extra round trip for a rare credential class.
  if (!(isSystemPrefix || !isRunPrefix)) return null;
  const systemRows = await db.select().from(systemApiTokens)
    .where(inArray(systemApiTokens.tokenHash, tokenHashes)).limit(2);
  const systemRow = systemRows.find((candidate): boolean => candidate.tokenHash === tokenHash) ?? systemRows[0];
  if (systemRow === undefined) return null;
  if (systemRow.tokenHash === legacyTokenHash) {
    await db.update(systemApiTokens).set({ tokenHash }).where(eq(systemApiTokens.id, systemRow.id));
  }
  const now = Date.now();
  if (systemRow.revokedAt !== null) {
    return { ...anonymousAuth("revoked"), systemToken: null };
  }
  if (systemRow.expiresAt <= now) {
    return { ...anonymousAuth("expired"), systemToken: null };
  }
  if (systemRow.lastUsedAt === null || now - systemRow.lastUsedAt > 60000) {
    await db.update(systemApiTokens).set({ lastUsedAt: now }).where(eq(systemApiTokens.id, systemRow.id));
  }
  rateLimitPrincipals.set(request, `system:${systemRow.id}`);
  return {
    ...anonymousAuth(null),
    systemToken: { id: systemRow.id, description: systemRow.description, expiresAt: systemRow.expiresAt, lastUsedAt: now },
  };
}

async function validateApiTokenFreshness(token: Readonly<AuthToken>, now: number): Promise<DerivedAuthContext | null> {
  if (token.expiresAt !== null && token.expiresAt <= now) {
    return anonymousAuth("expired");
  }

  if (token.refreshFamilyId != null) {
    const session = await db.query.refreshSessions.findFirst({
      where: and(eq(refreshSessions.familyId, token.refreshFamilyId), eq(refreshSessions.userId, token.userId ?? ""), isNull(refreshSessions.revokedAt), gt(refreshSessions.expiresAt, now)),
      columns: { id: true },
    });
    if (session === undefined) return anonymousAuth("invalid");
  }

  return null;
}

async function touchApiTokenLastUsed(token: Readonly<AuthToken>, now: number): Promise<void> {
  if (token.lastUsedAt === null || now - token.lastUsedAt > 60000) {
    await db.update(apiTokens)
      .set({ lastUsedAt: now })
      .where(eq(apiTokens.id, token.id));
  }
}

async function resolveUserToken(
  userId: string,
  user: Readonly<typeof users.$inferSelect> | null,
  usedToken: Readonly<AuthToken>,
): Promise<DerivedAuthContext> {
  // The joined lookup already resolves the user.
  const resolvedUser = user ?? await db.query.users.findFirst({ where: eq(users.id, userId) });
  // A token whose owner row has been removed is no longer a valid user
  // credential.  Without this guard the token would survive a partial
  // cleanup and be returned as authenticated with a null user.
  if (resolvedUser === undefined) {
    return anonymousAuth("invalid");
  }
  if ((resolvedUser as unknown as { deletedAt: number | null | undefined }).deletedAt != null) {
    return anonymousAuth("invalid");
  }
  if (resolvedUser.isSuspended === true) {
    return anonymousAuth("suspended");
  }
  setRequestSiteAdmin(resolvedUser.id, resolvedUser.isSiteAdmin === true);
  return { user: resolvedUser, token: usedToken, orgId: null, teamId: null, tokenError: null, run: null };
}

async function resolveTeamToken(teamId: string, usedToken: Readonly<AuthToken>): Promise<DerivedAuthContext> {
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
  });
  return { user: null, token: usedToken, orgId: null, teamId: team?.id ?? null, tokenError: team === undefined ? "invalid" : null, run: null };
}

export const authPlugin = new Elysia({ name: "auth" })
  .derive({ as: "global" }, async ({ request }: DeriveContext): Promise<DerivedAuthContext> => {
    rateLimitPrincipals.delete(request);
    const parsed = parseBearerCredential(request);
    if (parsed.kind === "none") {
      return anonymousAuth(null);
    }
    if (parsed.kind === "invalid") {
      return anonymousAuth("invalid");
    }

    const [tokenHash, legacyTokenHash] = tokenHashCandidates(parsed.tokenString);
    const tokenHashes = [tokenHash, legacyTokenHash];

    // Lookup by hash. The user row is JOINed in so the common user-token path
    // costs ONE query instead of two (api_tokens + users). Portable across
    // backends: .get() is sqlite-only, so use limit(1) + await (drizzle query
    // builders are thenable on both dialects).
    const isRunPrefix = parsed.tokenString.startsWith("trun_");
    const isSystemPrefix = parsed.tokenString.startsWith("tfe-system-");
    // Only run/system credentials have dedicated tables. Other prefixed
    // credentials still use the indexed API-token lookup.
    const skipApiLookup = isRunPrefix || isSystemPrefix;
    const { token, user } = skipApiLookup ? { token: undefined, user: null } : await lookupApiToken(tokenHash, legacyTokenHash, tokenHashes);

    if (token === undefined) {
      const runAuth = await resolveRunToken(request, tokenHashes, tokenHash, legacyTokenHash, isRunPrefix, isSystemPrefix);
      if (runAuth !== null) return runAuth;
      const systemAuth = await resolveSystemToken(request, tokenHashes, tokenHash, legacyTokenHash, isSystemPrefix, isRunPrefix);
      if (systemAuth !== null) return systemAuth;
      return anonymousAuth("invalid");
    }

    const now = Date.now();
    const freshnessError = await validateApiTokenFreshness(token, now);
    if (freshnessError !== null) return freshnessError;
    await touchApiTokenLastUsed(token, now);
    const usedToken: AuthToken = { ...token, lastUsedAt: now };
    rememberRateLimitPrincipal(request, token);

    if (token.userId !== null) {
      return await resolveUserToken(token.userId, user, usedToken);
    }

    if (token.teamId !== null) {
      return await resolveTeamToken(token.teamId, usedToken);
    }

    if (token.orgId !== null) {
      return { user: null, token: usedToken, orgId: token.orgId, teamId: null, tokenError: null, run: null };
    }

    return anonymousAuth(null);
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
    systemAuth(value: boolean): Record<string, unknown> {
      return {
        beforeHandle({ token, systemToken, set }: { readonly token?: unknown; readonly systemToken?: unknown; readonly set: Readonly<{ status: number }> }): Record<string, unknown> | undefined {
          if (!value) return;
          if ((token === null || token === undefined) && (systemToken === null || systemToken === undefined)) {
            (set as { status: number }).status = 401;
            return { errors: [{ status: "401", title: "Unauthorized" }] };
          }
        },
      };
    },
  });
