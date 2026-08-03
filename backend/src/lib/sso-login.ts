import { db } from "../db";
import { apiTokens, type users } from "../db/schema";
import { accessTokenDocument, issueLoginSession, opaqueToken, tokenHash } from "../routes/accounts";

type HeaderValue = string | number | readonly string[];
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, HeaderValue>> }>;
type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;
type LoginContext = Readonly<{ set: SetObj; request: RequestInfo | undefined; server?: unknown }>;

/** Browser session or SSO API token (RelayState "api"), shared by SAML + OIDC. */
export async function issueSsoLogin(
  user: Readonly<typeof users.$inferSelect>,
  context: LoginContext,
  options: Readonly<{ tokenTtlMs?: number; wantsToken?: boolean }> = {},
): Promise<unknown> {
  if (!options.wantsToken) return issueLoginSession(user, true, context.set, context.request, context.server);
  const createdAt = Date.now();
  const expiresAt = options.tokenTtlMs !== undefined ? createdAt + options.tokenTtlMs : undefined;
  const tokenStr = opaqueToken("user");
  const tokenId = crypto.randomUUID();
  await db.insert(apiTokens).values({
    id: tokenId,
    token: tokenHash(tokenStr),
    userId: user.id,
    description: "SSO login token",
    createdAt,
    expiresAt: expiresAt ?? null,
  });
  // SSO API tokens carry no refresh session: mark them explicitly
  // non-refreshable even when a TTL is configured.
  return accessTokenDocument(tokenId, tokenStr, user, expiresAt, false);
}
