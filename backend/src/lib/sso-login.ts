import { db } from "../db";
import { apiTokens, type users } from "../db/schema";
import { accessTokenDocument, issueLoginSession, opaqueToken, tokenHash } from "../routes/accounts";

type HeaderValue = string | number | readonly string[];
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, HeaderValue>> }>;
type RequestInfo = Readonly<{ url: string; headers: Readonly<{ get: (name: string) => string | null }> }>;
type LoginContext = Readonly<{ set: SetObj; request: RequestInfo | undefined; server?: unknown }>;

// SSO API tokens must never be immortal: when the caller does not supply an
// explicit TTL, fall back to the default SAML session timeout used by the
// ACS so every issued token expires.
const DEFAULT_SSO_API_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** Browser session or SSO API token (RelayState "api"), shared by SAML + OIDC. */
export async function issueSsoLogin(
  user: Readonly<typeof users.$inferSelect>,
  context: LoginContext,
  options: Readonly<{ tokenTtlMs?: number; wantsToken?: boolean }> = {},
): Promise<unknown> {
  if (!options.wantsToken) return issueLoginSession(user, true, context.set, context.request, context.server);
  const createdAt = Date.now();
  const ttlMs = options.tokenTtlMs ?? DEFAULT_SSO_API_TOKEN_TTL_MS;
  const expiresAt = createdAt + ttlMs;
  const tokenStr = opaqueToken("user");
  const tokenId = crypto.randomUUID();
  await db.insert(apiTokens).values({
    id: tokenId,
    token: tokenHash(tokenStr),
    userId: user.id,
    description: "SSO login token",
    createdAt,
    expiresAt,
  });
  // SSO API tokens carry no refresh session: mark them explicitly
  // non-refreshable even though a TTL is always configured.
  return accessTokenDocument(tokenId, tokenStr, user, expiresAt, false);
}
