import { db } from "../db";
import { orgTokenTTLPolicies } from "../db/schema";
import { eq } from "drizzle-orm";

// Token TTL policy enforcement (todo 72-74). The orgTokenTTLPolicies table is
// administrator-facing configuration; without this layer the UI let admins
// configure a security policy that token issuance silently ignored. Every
// long-lived credential mint (user/org/team) resolves its effective cap here
// before persistence.
//
// Policy semantics (todo 77-78):
// - max-ttl-ms = 0 means "no tokens of this type may be created".
// - Absurd/overflowing TTL values are rejected at the policy API boundary
//   (token-ttl.ts validates non-negative finite numbers); enforcement treats
//   any policy row as an upper bound on the requested expiry.
// - A policy only constrains NEWLY created tokens (todo 79/80: existing
//   credentials are untouched when a policy shortens).

/** Token types a policy can govern. Mirrors apiTokens.tokenType semantics:
 * "" is the organization-token slot. Whitelisted at the policy API (todo 76). */
export const TTL_POLICY_TOKEN_TYPES = ["", "organization", "user", "team", "team-legacy", "audit-trails", "audit_trails"] as const;
export type TtlPolicyTokenType = (typeof TTL_POLICY_TOKEN_TYPES)[number];

export function isTtlPolicyTokenType(value: string): value is TtlPolicyTokenType {
  return (TTL_POLICY_TOKEN_TYPES as readonly string[]).includes(value);
}

/** Normalize TFE wire token-types to our DB canonical ("" = org slot, "audit-trails" = audit). */
export function normalizeTtlPolicyTokenType(value: string): string {
  if (value === "organization") return "";
  if (value === "audit_trails") return "audit-trails";
  return value;
}

/** Denormalize DB canonical to TFE wire format for GET/PATCH responses. */
export function denormalizeTtlPolicyTokenType(value: string): string {
  if (value === "") return "organization";
  if (value === "audit-trails") return "audit_trails";
  return value;
}

export type TtlPolicyResolution =
  | { readonly kind: "ok"; readonly expiresAt: number | null }
  | { readonly kind: "forbidden"; readonly detail: string }
  | { readonly kind: "invalid"; readonly detail: string };

/**
 * Resolve the effective expiry for a new token under the organization's TTL
 * policies. `requestedExpiresAt` may be null (no expiry requested).
 * `orgId` may be null for user tokens minted outside any organization —
 * org policies cannot govern those.
 */
export async function resolveTokenExpiryUnderPolicy(
  orgId: string | null,
  tokenType: TtlPolicyTokenType,
  requestedExpiresAt: number | null,
): Promise<TtlPolicyResolution> {
  if (requestedExpiresAt !== null && !Number.isFinite(requestedExpiresAt)) {
    return { kind: "invalid", detail: "expired-at must be a valid timestamp" };
  }
  if (requestedExpiresAt !== null && requestedExpiresAt <= Date.now()) {
    return { kind: "invalid", detail: "expired-at must be in the future" };
  }
  if (orgId === null) return { kind: "ok", expiresAt: requestedExpiresAt };
  const policies = await db.query.orgTokenTTLPolicies.findMany({
    where: eq(orgTokenTTLPolicies.orgId, orgId),
  });
  const policy = policies.find((p: Readonly<{ tokenType: string; maxTtlMs: number }>): boolean => p.tokenType === tokenType);
  if (policy === undefined) return { kind: "ok", expiresAt: requestedExpiresAt };
  if (policy.maxTtlMs === 0) {
    return { kind: "forbidden", detail: `Organization policy forbids ${tokenType === "" ? "organization" : tokenType} tokens` };
  }

  const maxExpiresAt = Date.now() + policy.maxTtlMs;
  if (requestedExpiresAt === null) {
    return { kind: "ok", expiresAt: maxExpiresAt };
  }
  return { kind: "ok", expiresAt: Math.min(requestedExpiresAt, maxExpiresAt) };
}
