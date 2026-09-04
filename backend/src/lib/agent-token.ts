export const AGENT_POOL_TOKEN_DEFAULT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

type AgentPoolTokenLifecycle = Readonly<{
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}>;

/**
 * Legacy rows predate expiry columns. Treat their creation time as the start
 * of the same default lifetime used for newly minted agent credentials until
 * the boot backfill has materialized expires_at.
 */
export function agentPoolTokenExpiresAt(token: Pick<AgentPoolTokenLifecycle, "createdAt" | "expiresAt">): number {
  return token.expiresAt ?? token.createdAt + AGENT_POOL_TOKEN_DEFAULT_TTL_MS;
}

export function isAgentPoolTokenActive(
  token: AgentPoolTokenLifecycle,
  now = Date.now(),
): boolean {
  return token.revokedAt === null && agentPoolTokenExpiresAt(token) > now;
}
