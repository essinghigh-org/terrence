import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";
import { apiTokens, type users } from "../db/schema";
import { issueLoginSession } from "../routes/accounts";

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
  const tokenStr = `user-${randomBytes(32).toString("base64url")}`;
  const tokenId = crypto.randomUUID();
  const createdAt = Date.now();
  await db.insert(apiTokens).values({
    id: tokenId,
    token: createHash("sha256").update(tokenStr).digest("hex"),
    userId: user.id,
    description: "SSO login token",
    createdAt,
    expiresAt: options.tokenTtlMs !== undefined ? createdAt + options.tokenTtlMs : null,
  });
  return {
    data: {
      id: tokenId,
      type: "tokens",
      attributes: {
        token: tokenStr,
        "must-change-password": user.mustChangePassword,
        ...(options.tokenTtlMs === undefined ? {} : { "expired-at": new Date(createdAt + options.tokenTtlMs).toISOString() }),
      },
    },
  };
}
