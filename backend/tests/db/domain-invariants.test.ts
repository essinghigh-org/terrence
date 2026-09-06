import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, isPostgres } from "../../src/db";
import { organizationMemberships, users } from "../../src/db/schema";
import { databaseConstraint } from "../../src/lib/database-errors";
import { handleAppError } from "../../src/app";

async function failure(operation: () => PromiseLike<unknown>): Promise<unknown> {
  try { await operation(); } catch (error: unknown) { return error; }
  throw new Error("Expected the database to enforce its constraint");
}

describe(`domain invariants on ${isPostgres ? "PostgreSQL" : "SQLite"}`, () => {
  test("uniqueness and missing relationships produce portable, redacted conflicts", async () => {
    const id = `invariant-${crypto.randomUUID()}`;
    await db.insert(users).values({ id, username: id, passwordHash: "fixture-only" });
    try {
      const unique = await failure(() => db.insert(users).values({ id: `${id}-second`, username: id, passwordHash: "fixture-only" }));
      const foreign = await failure(() => db.insert(organizationMemberships).values({ id: `${id}-membership`, userId: id, orgId: `${id}-missing` }));
      expect(databaseConstraint(unique)).toBe("unique");
      expect(databaseConstraint(foreign)).toBe("foreign-key");
      for (const error of [unique, foreign]) {
        const set = { status: 200, headers: {} };
        const body = handleAppError({ code: "UNKNOWN", error, set, request: { url: "http://localhost/api/v2/invariant" } });
        expect(set.status).toBe(409);
        expect(JSON.stringify(body)).not.toContain(id);
        expect(JSON.stringify(body)).not.toContain("fixture-only");
      }
    } finally {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  test("an asynchronous transaction rolls back all prior writes after a conflict", async () => {
    const id = `rollback-${crypto.randomUUID()}`;
    const error = await failure(() => db.transaction(async (tx) => {
      await tx.insert(users).values({ id, username: id, passwordHash: "fixture-only" });
      await Promise.resolve();
      await tx.insert(users).values({ id: `${id}-second`, username: id, passwordHash: "fixture-only" });
    }));
    expect(databaseConstraint(error)).toBe("unique");
    expect(await db.query.users.findFirst({ where: eq(users.id, id) })).toBeUndefined();
  });

  test("unknown and cyclic driver errors remain server errors", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(databaseConstraint(cyclic)).toBeNull();
    expect(databaseConstraint(new Error("unique words are not driver codes"))).toBeNull();
  });
});
