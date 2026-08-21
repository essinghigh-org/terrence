import { describe, expect, test } from "bun:test";

// Time-bomb for dated TODO cleanup (todo 414). The refresh-session ghost-cookie
// relaxation was shipped 2026-08-19 with an explicit removal date of 2027-02-19.
// When this test fails, delete the relaxation branch in
// backend/src/routes/accounts.ts (the `if (current.rotatedAt !== null)` block
// annotated with TODO(remove after 2027-02-19)) and remove this test.
const GHOST_COOKIE_TODO_EXPIRY_MS = Date.parse("2027-02-19T00:00:00.000Z");

describe("dated TODO expiry", () => {
  test("ghost-cookie relaxation TODO has not yet expired", () => {
    expect(Date.now()).toBeLessThan(GHOST_COOKIE_TODO_EXPIRY_MS);
  });
});
