// Cross-replica lease for registry module synchronization.
//
// Registry module ingestion (webhook-driven) used to coalesce duplicate syncs
// with an in-process Map (syncInFlight) in lib/registry-module-sync.ts. That is
// replica-local: under a multi-instance deployment two replicas can receive the
// same module webhook and both ingest it. This module provides a database-backed
// mutex so only one replica runs the sync for a given module key at a time.
//
// The table (registry_sync_leases) is created idempotently at boot
// (src/db/index.ts) for both backends, so no generated migration is needed and a
// sparse/legacy journal that re-applies the boot path stays safe.
//
// Claim semantics mirror durable_jobs: INSERT ... ON CONFLICT DO UPDATE SET ...
// WHERE the existing lease has expired. The claimer then reads back ownership.
// A non-owner returns the module's current versions (it does not block or
// double-run). expiresAt bounds the lease so a crashed replica cannot block
// ingestion forever.
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { registrySyncLeases } from "../db/schema";
import { registryModuleVersions } from "../db/schema";
import { log } from "./log";

// Generous bound: module syncs download and unpack archives, which can take
// minutes for large modules. The owner refreshes the lease at the start of the
// sync, so this only needs to outlive a sync that has already begun and then
// been orphaned by a crash.
export const REGISTRY_SYNC_LEASE_MS = 10 * 60 * 1000;
// Renewal cadence while a sync runs: comfortably inside the lease window so a
// long tag scan (many archives, 15s timeouts each) cannot let the lease expire
// and hand the module to a second replica mid-ingestion.
const REGISTRY_SYNC_RENEWAL_MS = 60_000;

// A process-wide identity so a replica only ever releases its own lease and a
// non-owner can tell that it does not hold the lock.
const INSTANCE_ID = `registry-sync-${crypto.randomUUID()}`;

/** Try to claim the lease for `key`. Returns true if this replica now owns it. */
export async function claimRegistrySyncLease(key: string, now = Date.now()): Promise<boolean> {
  const expiresAt = now + REGISTRY_SYNC_LEASE_MS;
  await db.insert(registrySyncLeases).values({ key, owner: INSTANCE_ID, expiresAt })
    .onConflictDoUpdate({
      target: registrySyncLeases.key,
      set: { owner: INSTANCE_ID, expiresAt },
      // Only take over a lease whose previous owner has let it expire; an
      // active lease held by another replica is left untouched.
      where: lt(registrySyncLeases.expiresAt, now),
    });
  const row = await db.query.registrySyncLeases.findFirst({ where: eq(registrySyncLeases.key, key) });
  return row?.owner === INSTANCE_ID;
}

/**
 * Extend the lease for `key` while this replica still owns it. Returns false
 * when the lease expired and another replica took it over (or the row is gone),
 * so the sync can abort rather than continue writing under a lost lock.
 */
export async function renewRegistrySyncLease(key: string, now = Date.now()): Promise<boolean> {
  const updated = await db.update(registrySyncLeases)
    .set({ expiresAt: now + REGISTRY_SYNC_LEASE_MS })
    .where(and(eq(registrySyncLeases.key, key), eq(registrySyncLeases.owner, INSTANCE_ID)))
    .returning({ key: registrySyncLeases.key });
  return updated.length === 1;
}

/** Release a lease this replica holds. Safe to call when not the owner. */
export async function releaseRegistrySyncLease(key: string): Promise<void> {
  await db.delete(registrySyncLeases)
    .where(and(eq(registrySyncLeases.key, key), eq(registrySyncLeases.owner, INSTANCE_ID)));
}

/**
 * Owns a claimed lease for its lifetime: renews it on an interval while the
 * caller works and exposes isAlive() so long-running work can detect that the
 * lease was lost (expired and reclaimed by another replica) and abort. This
 * keeps REGISTRY_SYNC_RENEWAL_MS internal to the lease module and makes the
 * renewal loop cleanup unconditional on the caller path.
 */
export class RegistrySyncLease {
  private alive = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly key: string) {
  }

  /** Claim `key`, or return null when another replica holds an unexpired lease. */
  public static async acquire(key: string): Promise<RegistrySyncLease | null> {
    if (!(await claimRegistrySyncLease(key))) return null;
    const lease = new RegistrySyncLease(key);
    lease.timer = setInterval((): void => {
      renewRegistrySyncLease(key).then(
        (ok): void => { if (!ok) lease.alive = false; },
        (): void => { lease.alive = false; },
      );
    }, REGISTRY_SYNC_RENEWAL_MS);
    return lease;
  }

  /** True while this replica still owns the lease. */
  public isAlive(): boolean {
    return this.alive;
  }

  /** Stop the renewal loop and release the lease. Errors are recorded, not thrown. */
  public async release(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await releaseRegistrySyncLease(this.key);
    } catch (error: unknown) {
      log.error("Failed to release registry sync lease", { key: this.key, error });
    }
  }
}

/** Drop expired leases (periodic sweep). Returns the number reaped. */
export async function reapExpiredRegistrySyncLeases(now = Date.now()): Promise<number> {
  const deleted = await db.delete(registrySyncLeases)
    .where(lt(registrySyncLeases.expiresAt, now))
    .returning({ key: registrySyncLeases.key });
  return deleted.length;
}

/** Current version identifiers for a module; used as the result for non-owners. */
export async function currentModuleVersions(moduleId: string): Promise<readonly string[]> {
  const rows = await db.select({ version: registryModuleVersions.version })
    .from(registryModuleVersions)
    .where(eq(registryModuleVersions.moduleId, moduleId));
  return rows.map((row): string => row.version);
}
