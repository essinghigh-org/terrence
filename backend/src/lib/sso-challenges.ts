import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { ssoChallenges } from "../db/schema";

const MAX_CHALLENGES_PER_KIND = 10_000;

async function trimSsoChallenges(kind: string): Promise<void> {
  const now = Date.now();
  await db.delete(ssoChallenges).where(and(
    eq(ssoChallenges.kind, kind),
    lt(ssoChallenges.expiresAt, now),
  ));
  const retained = await db.query.ssoChallenges.findMany({
    where: eq(ssoChallenges.kind, kind),
    orderBy: [asc(ssoChallenges.expiresAt)],
    columns: { id: true },
    limit: MAX_CHALLENGES_PER_KIND + 1,
  });
  if (retained.length > MAX_CHALLENGES_PER_KIND) {
    await db.delete(ssoChallenges).where(inArray(
      ssoChallenges.id,
      retained.slice(0, retained.length - MAX_CHALLENGES_PER_KIND).map((challenge): string => challenge.id),
    ));
  }
}

export async function storeSsoChallenge(
  kind: string,
  id: string,
  payload: Readonly<Record<string, unknown>>,
  expiresAt: number,
): Promise<void> {
  await db.delete(ssoChallenges).where(and(
    eq(ssoChallenges.kind, kind),
    eq(ssoChallenges.id, id),
    lt(ssoChallenges.expiresAt, Date.now()),
  ));
  await db.insert(ssoChallenges).values({ id, kind, payload, expiresAt })
    .onConflictDoUpdate({
      target: ssoChallenges.id,
      set: { kind, payload, expiresAt },
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
export async function consumeSsoChallenge(
  kind: string,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db.delete(ssoChallenges).where(and(
    eq(ssoChallenges.kind, kind),
    eq(ssoChallenges.id, id),
    gt(ssoChallenges.expiresAt, Date.now()),
  )).returning({ payload: ssoChallenges.payload });
  return rows[0]?.payload;
}
