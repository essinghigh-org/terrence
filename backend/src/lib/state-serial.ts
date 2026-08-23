import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { stateVersions } from "../db/schema";
import { isUniqueConstraintError } from "./validation";
import { insertStateOutputIndex } from "./state-output-index";

type StateInsert = Omit<typeof stateVersions.$inferInsert, "serial">;

/** Insert the next workspace state serial using an existing transaction. */
export async function insertStateVersionWithSerialTx(
  transaction: unknown,
  values: Readonly<StateInsert>,
): Promise<number> {
  const tx = transaction as typeof db;
  const latest = await tx.query.stateVersions.findFirst({
    where: eq(stateVersions.workspaceId, values.workspaceId),
    orderBy: [desc(stateVersions.serial)],
    columns: { serial: true },
  });
  const serial = (latest?.serial ?? 0) + 1;
  await tx.insert(stateVersions).values({ ...values, serial });
  await insertStateOutputIndex(transaction, values.id, values.workspaceId, values.jsonState ?? null, values.statePayload ?? null);
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
