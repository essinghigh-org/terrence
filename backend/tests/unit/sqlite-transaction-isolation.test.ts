import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, isPostgres } from "../../src/db";
import { organizations } from "../../src/db/schema";

const sqliteTest = isPostgres ? test.skip : test;

sqliteTest("plain statements cannot observe an uncommitted async transaction", async () => {
  const organizationId = `sqlite-isolation-${crypto.randomUUID()}`;
  let releaseTransaction!: () => void;
  const transactionMayFinish = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let signalTransactionStarted!: () => void;
  const transactionStarted = new Promise<void>((resolve) => {
    signalTransactionStarted = resolve;
  });

  const transaction = db.transaction(async (tx) => {
    await tx.insert(organizations).values({ id: organizationId, name: "uncommitted" });
    await expect(
      Promise.resolve(db.query.organizations.findFirst({ where: eq(organizations.id, organizationId) })),
    ).rejects.toThrow("outer db handle");
    signalTransactionStarted();
    await transactionMayFinish;
    throw new Error("rollback isolation probe");
  });

  try {
    await transactionStarted;
    let visibleReadSettled = false;
    const visibleRead = db.query.organizations
      .findFirst({ where: eq(organizations.id, organizationId) })
      .then((row) => {
        visibleReadSettled = true;
        return row;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(visibleReadSettled).toBe(false);
    releaseTransaction();
    await transaction.catch(() => undefined);
    const visible = await visibleRead;
    expect(visible).toBeUndefined();
  } finally {
    releaseTransaction();
    await transaction.catch(() => undefined);
    await db.delete(organizations).where(eq(organizations.id, organizationId));
  }
}, 10000);
