import { and, asc, count, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { ssoChallenges } from "../db/schema";
import { log } from "./log";

const MAX_CHALLENGES_PER_KIND = 10_000;
const CHALLENGE_PURGE_INTERVAL_MS = 60_000;

/** Remove expired challenges even when no new login flow is being started. */
export async function purgeExpiredSsoChallenges(now = Date.now()): Promise<void> {
  await db.delete(ssoChallenges).where(lt(ssoChallenges.expiresAt, now));
}

const challengePurgeTimer = setInterval((): void => {
  void purgeExpiredSsoChallenges().catch((error: unknown): void => {
    log.warn("Failed to purge expired SSO challenges", { error: error instanceof Error ? error.message : String(error) });
  });
}, CHALLENGE_PURGE_INTERVAL_MS);
(challengePurgeTimer as unknown as { unref?: () => void }).unref?.();

async function trimSsoChallenges(kind: string): Promise<void> {
  const now = Date.now();
  await db.delete(ssoChallenges).where(and(
    eq(ssoChallenges.kind, kind),
    lt(ssoChallenges.expiresAt, now),
  ));
  if (Math.random() >= 0.01) return;
  const countRow = (await db.select({ value: count() }).from(ssoChallenges).where(eq(ssoChallenges.kind, kind)))[0];
  const total = countRow?.value ?? 0;
  if (total <= MAX_CHALLENGES_PER_KIND) return;
  const evicted = await db.query.ssoChallenges.findMany({
    where: eq(ssoChallenges.kind, kind),
    orderBy: [asc(ssoChallenges.expiresAt)],
    columns: { id: true },
    limit: total - MAX_CHALLENGES_PER_KIND,
  });
  if (evicted.length > 0) {
    await db.delete(ssoChallenges).where(inArray(
      ssoChallenges.id,
      evicted.map((challenge): string => challenge.id),
    ));
  }
}

export async function storeSsoChallenge(
  kind: string,
  id: string,
  payload: Readonly<Record<string, unknown>>,
  expiresAt: number,
): Promise<void> {
  await db.insert(ssoChallenges).values({ id, kind, payload, expiresAt })
    .onConflictDoUpdate({
      target: ssoChallenges.id,
      set: { payload, expiresAt },
      where: eq(ssoChallenges.kind, kind),
    });
  await trimSsoChallenges(kind);
}

/** Claim an ID once without a read-then-write race. */
export async function claimSsoChallenge(
  kind: string,
  id: string,
  payload: Readonly<Record<string, unknown>>,
  expiresAt: number,
): Promise<boolean> {
  await db.delete(ssoChallenges).where(and(
    eq(ssoChallenges.kind, kind),
    lt(ssoChallenges.expiresAt, Date.now()),
  ));
  const rows = await db.insert(ssoChallenges).values({ id, kind, payload, expiresAt })
    .onConflictDoNothing()
    .returning({ id: ssoChallenges.id });
  await trimSsoChallenges(kind);
  return rows.length === 1;
}

export async function clearSsoChallenges(kind: string): Promise<void> {
  await db.delete(ssoChallenges).where(eq(ssoChallenges.kind, kind));
}

/** Atomically consume a live challenge; replayed or expired IDs return undefined. */
export async function consumeSsoChallenge(kind: string, id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.delete(ssoChallenges).where(and(
    eq(ssoChallenges.kind, kind),
    eq(ssoChallenges.id, id),
    gt(ssoChallenges.expiresAt, Date.now()),
  )).returning({ payload: ssoChallenges.payload });
  return rows[0]?.payload;
}
