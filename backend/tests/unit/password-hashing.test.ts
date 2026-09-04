import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import {
  hashPassword,
  needsPasswordHashUpgrade,
  PASSWORD_HASH_COST,
  verifyAndUpgradePassword,
} from "../../src/lib/password-hashing";

const createdUserIds: string[] = [];

afterEach(async (): Promise<void> => {
  for (const userId of createdUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("password hashing policy", (): void => {
  it("uses the current bcrypt cost and identifies legacy hashes", async (): Promise<void> => {
    const currentHash = await hashPassword("current-password");
    expect(currentHash).toMatch(new RegExp(`^\\$2[aby]\\$${PASSWORD_HASH_COST}\\$`));
    expect(needsPasswordHashUpgrade(currentHash)).toBe(false);

    const legacyHash = await Bun.password.hash("legacy-password", { algorithm: "bcrypt", cost: 10 });
    expect(needsPasswordHashUpgrade(legacyHash)).toBe(true);
  });

  it("upgrades a valid legacy hash after successful verification", async (): Promise<void> => {
    const userId = `password-upgrade-${crypto.randomUUID()}`;
    const password = "legacy-password-to-upgrade";
    const legacyHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    createdUserIds.push(userId);
    await db.insert(users).values({ id: userId, username: userId, passwordHash: legacyHash });

    expect(await verifyAndUpgradePassword(userId, password, legacyHash)).toBe(true);

    const upgraded = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(upgraded?.passwordHash).toBeDefined();
    expect(upgraded?.passwordHash).not.toBe(legacyHash);
    expect(upgraded?.passwordHash).toMatch(new RegExp(`^\\$2[aby]\\$${PASSWORD_HASH_COST}\\$`));
    expect(await Bun.password.verify(password, upgraded!.passwordHash)).toBe(true);
  });
});
