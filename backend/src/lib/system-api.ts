import { randomBytes, randomUUID } from "node:crypto";
import { hashAuthenticationToken } from "./token-service";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { systemApiTokens } from "../db/schema";

export const SYSTEM_API_TOKEN_TTL_HOURS = 720;

export function hashSystemApiToken(token: string): string {
  return hashAuthenticationToken(token);
}

export async function createSystemApiToken(
  description: string,
  ttlHours = SYSTEM_API_TOKEN_TTL_HOURS,
): Promise<{ token: string; record: typeof systemApiTokens.$inferSelect }> {
  const normalizedDescription = description.trim();
  if (normalizedDescription === "") throw new Error("description is required");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 8760) throw new Error("ttl must be between 1 and 8760 hours");
  const token = `tfe-system-${randomBytes(32).toString("base64url")}`;
  const values = {
    id: `system-token-${randomUUID()}`,
    tokenHash: hashSystemApiToken(token),
    description: normalizedDescription,
    expiresAt: Date.now() + Math.floor(ttlHours * 60 * 60 * 1000),
  };
  await db.insert(systemApiTokens).values(values);
  const record = await db.query.systemApiTokens.findFirst({ where: eq(systemApiTokens.id, values.id) });
  if (record === undefined) throw new Error("system API token was not persisted");
  return { token, record };
}

export function systemTokenResource(record: typeof systemApiTokens.$inferSelect): Record<string, unknown> {
  return {
    id: record.id,
    type: "system-api-tokens",
    attributes: {
      description: record.description,
      "created-at": new Date(record.createdAt).toISOString(),
      "expires-at": new Date(record.expiresAt).toISOString(),
      "last-used-at": record.lastUsedAt === null ? null : new Date(record.lastUsedAt).toISOString(),
      revoked: record.revokedAt !== null,
    },
  };
}

export function systemAuthError(
  context: Readonly<{ systemToken?: unknown; token?: unknown; user?: unknown; orgId?: unknown; teamId?: unknown; run?: unknown }>,
  set: { status?: number; headers: Record<string, string | number> },
): Record<string, unknown> | undefined {
  if (context.systemToken !== undefined && context.systemToken !== null) return undefined;
  const hasApplicationCredential = context.token !== null && context.token !== undefined
    || context.user !== null && context.user !== undefined
    || context.orgId !== null && context.orgId !== undefined
    || context.teamId !== null && context.teamId !== undefined
    || context.run !== null && context.run !== undefined;
  set.status = hasApplicationCredential ? 404 : 401;
  return { errors: [{ status: String(set.status), title: hasApplicationCredential ? "Not Found" : "Unauthorized" }] };
}

const rateWindows = new Map<string, number>();
const MAX_RATE_WINDOW_ENTRIES = 4096;
const RATE_WINDOW_CLEANUP_BATCH = 64;
let rateWindowCleanupCursor: Iterator<[string, number]> | undefined;

/** One request per second per System API token, matching the reference format's system limit. */
export function systemRateLimited(tokenId: string, set: { status?: number; headers: Record<string, string | number> }): boolean {
  const now = Date.now();
  if (rateWindows.size > 1024) {
    rateWindowCleanupCursor ??= rateWindows.entries();
    for (let checked = 0; checked < RATE_WINDOW_CLEANUP_BATCH; checked += 1) {
      const next = rateWindowCleanupCursor.next();
      if (next.done) {
        rateWindowCleanupCursor = undefined;
        break;
      }
      const [id, expiresAt] = next.value;
      if (expiresAt <= now) rateWindows.delete(id);
    }
  }
  const resetAt = rateWindows.get(tokenId) ?? 0;
  if (resetAt > now) {
    set.status = 429;
    set.headers["Retry-After"] = Math.ceil((resetAt - now) / 1000);
    return true;
  }
  if (!rateWindows.has(tokenId) && rateWindows.size >= MAX_RATE_WINDOW_ENTRIES) {
    set.status = 429;
    set.headers["Retry-After"] = 1;
    return true;
  }
  rateWindows.set(tokenId, now + 1000);
  return false;
}
