import { db } from "../db";
import type { stateVersions } from "../db/schema";
import { CLIENT_ENCRYPTED_STATE_ERROR, decodeStatePayload, isClientEncryptedState, isUniqueConstraintError } from "./validation";
import { commitStateVersionAtSerialTx, nextStateSerialTx } from "./state-commit";

type StateInsert = Omit<typeof stateVersions.$inferInsert, "serial">;

/** Insert the next workspace state serial using an existing transaction. */
export async function insertStateVersionWithSerialTx(
  transaction: unknown,
  values: Readonly<StateInsert>,
): Promise<number> {
  const tx = transaction as typeof db;
  const statePayload = values.statePayload === null || values.statePayload === undefined ? null : decodeStatePayload(values.statePayload);
  if (isClientEncryptedState(statePayload)) throw new Error(CLIENT_ENCRYPTED_STATE_ERROR);
  const jsonState = values.jsonState === null || values.jsonState === undefined ? null : decodeStatePayload(values.jsonState);
  const serial = await nextStateSerialTx(tx, values.workspaceId);
  await commitStateVersionAtSerialTx(tx, { ...values, serial }, statePayload, jsonState);
  return serial;
}

/** Insert the next workspace state serial with a short retry for concurrent writers. */
export async function insertStateVersionWithSerialRetry(values: Readonly<StateInsert>): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.transaction(async (transaction): Promise<number> =>
        insertStateVersionWithSerialTx(transaction, values));
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error) || attempt === 2) throw error;
    }
  }
  throw new Error("State serial allocation failed");
}
