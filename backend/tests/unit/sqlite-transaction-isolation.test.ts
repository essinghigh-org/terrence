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

sqliteTest("nested async sqlite transactions roll back rejected savepoints", async () => {
  const outerOrganizationId = `sqlite-nested-outer-${crypto.randomUUID()}`;
  const nestedOrganizationId = `sqlite-nested-inner-${crypto.randomUUID()}`;

  try {
    await db.transaction(async (tx) => {
      await tx.insert(organizations).values({ id: outerOrganizationId, name: "outer" });
      await expect(
        Promise.resolve(tx.transaction(async (nestedTx) => {
          await nestedTx.insert(organizations).values({ id: nestedOrganizationId, name: "nested" });
          throw new Error("nested rollback probe");
        })),
      ).rejects.toThrow("nested rollback probe");

      const nestedRow = await tx.query.organizations.findFirst({
        where: eq(organizations.id, nestedOrganizationId),
      });
      expect(nestedRow).toBeUndefined();
      await tx.insert(organizations).values({ id: `${outerOrganizationId}-after`, name: "outer after" });
    });

    const outerRow = await db.query.organizations.findFirst({ where: eq(organizations.id, outerOrganizationId) });
    const outerAfterRow = await db.query.organizations.findFirst({ where: eq(organizations.id, `${outerOrganizationId}-after`) });
    const nestedRow = await db.query.organizations.findFirst({ where: eq(organizations.id, nestedOrganizationId) });
    expect(outerRow).toBeDefined();
    expect(outerAfterRow).toBeDefined();
    expect(nestedRow).toBeUndefined();
  } finally {
    await db.delete(organizations).where(eq(organizations.id, nestedOrganizationId));
    await db.delete(organizations).where(eq(organizations.id, `${outerOrganizationId}-after`));
    await db.delete(organizations).where(eq(organizations.id, outerOrganizationId));
  }
}, 10000);
