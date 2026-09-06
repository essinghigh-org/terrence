import { desc, eq } from "drizzle-orm";
import type { db } from "../db";
import { stateVersions as stateVersionsTable } from "../db/schema";
import { insertStateOutputIndex } from "./state-output-index";
import { decodeStatePayload } from "./validation";

/** Values used by the shared state commit path. The row serial is allocated
 * by the transaction after its workspace fence has been acquired. */
export type StateCommitValues = Omit<typeof stateVersionsTable.$inferInsert, "serial"> & Readonly<{ serial: number }>;

export async function nextStateSerialTx(transaction: unknown, workspaceId: string): Promise<number> {
  const tx = transaction as typeof db;
  const latest = await tx.query.stateVersions.findFirst({
    where: eq(stateVersionsTable.workspaceId, workspaceId),
    orderBy: [desc(stateVersionsTable.serial)],
    columns: { serial: true },
  });
  const serial = (latest?.serial ?? 0) + 1;
  if (!Number.isSafeInteger(serial)) throw new Error("State serial allocation failed");
  return serial;
}

/** Insert one already-numbered state and rebuild all derived state indexes in
 * the same transaction. Callers must fence the workspace before allocating
 * the serial so a recovery promotion cannot race another writer. */
export async function commitStateVersionAtSerialTx(
  transaction: unknown,
  values: Readonly<StateCommitValues>,
  indexedStatePayload: string | null = null,
  indexedJsonState: string | null = null,
): Promise<void> {
  const tx = transaction as typeof db;
  await tx.insert(stateVersionsTable).values(values);
  const statePayload = indexedStatePayload ?? (values.statePayload === null || values.statePayload === undefined ? null : decodeStatePayload(values.statePayload));
  const jsonState = indexedJsonState ?? (values.jsonState === null || values.jsonState === undefined ? null : decodeStatePayload(values.jsonState));
  await insertStateOutputIndex(tx, values.id, values.workspaceId, jsonState, statePayload);
}
