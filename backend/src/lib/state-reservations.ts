import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, stateVersions, workspaces } from "../db/schema";
import { auditLogValues } from "./audit-trail";

export const STATE_UPLOAD_TTL_MS = 60 * 60 * 1000;
type Workspace = Readonly<typeof workspaces.$inferSelect>;
type Reservation = Readonly<typeof stateVersions.$inferSelect>;

export function stateUploadLock(workspace: Workspace): string {
  return JSON.stringify([workspace.locked, workspace.lockOwnerType, workspace.lockOwnerId, workspace.lockedAt]);
}

export function stateReservationObsolete(reservation: Reservation, workspace: Workspace, now = Date.now()): boolean {
  return now >= (reservation.uploadExpiresAt ?? reservation.createdAt + STATE_UPLOAD_TTL_MS)
    || (reservation.uploadLock !== null && reservation.uploadLock !== stateUploadLock(workspace));
}

/** Lock the workspace row until transaction commit without altering its lock.
 * The predicate rejects a handoff since the caller authorized the operation. */
export async function fenceStateWorkspace(tx: typeof db, workspace: Workspace): Promise<boolean> {
  const rows = await tx.update(workspaces).set({ locked: workspace.locked }).where(and(
    eq(workspaces.id, workspace.id),
    workspace.locked === null ? isNull(workspaces.locked) : eq(workspaces.locked, workspace.locked),
    workspace.lockOwnerType === null ? isNull(workspaces.lockOwnerType) : eq(workspaces.lockOwnerType, workspace.lockOwnerType),
    workspace.lockOwnerId === null ? isNull(workspaces.lockOwnerId) : eq(workspaces.lockOwnerId, workspace.lockOwnerId),
    workspace.lockedAt === null ? isNull(workspaces.lockedAt) : eq(workspaces.lockedAt, workspace.lockedAt),
  )).returning({ id: workspaces.id });
  return rows.length === 1;
}

/** Remove only uncommitted obsolete reservations, retaining an atomic audit
 * tombstone. Deleting frees the unique serial for the next legitimate writer. */
export async function pruneStateReservations(tx: typeof db, workspace: Workspace): Promise<void> {
  const pending = await tx.query.stateVersions.findMany({ where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "pending"), isNull(stateVersions.statePayload)) });
  for (const reservation of pending) {
    if (!stateReservationObsolete(reservation, workspace)) continue;
    await discardStateReservation(tx, reservation, workspace, Date.now() >= (reservation.uploadExpiresAt ?? reservation.createdAt + STATE_UPLOAD_TTL_MS) ? "upload-expired" : "lock-changed");
  }
}


export async function discardStateReservation(tx: typeof db, reservation: Reservation, workspace: Workspace, reason: "upload-expired" | "lock-changed" | "discarded"): Promise<boolean> {
  const removed = await tx.delete(stateVersions).where(and(eq(stateVersions.id, reservation.id), eq(stateVersions.status, "pending"), isNull(stateVersions.statePayload))).returning({ id: stateVersions.id });
  if (removed.length === 0) return false;
  await tx.insert(auditLogs).values(auditLogValues({
    orgId: workspace.orgId,
    userId: null,
    action: reason === "discarded" ? "discard" : "expire",
    resourceType: "state-version",
    resourceId: reservation.id,
    details: { workspaceId: workspace.id, serial: reservation.serial, reason },
  }) as typeof auditLogs.$inferInsert);
  return true;
}
