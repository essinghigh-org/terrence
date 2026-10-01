import { expect, test } from "bun:test";
import { resolveSsoReturnTarget } from "../../src/lib/return-target";
import { resolveReturnTarget } from "../../../frontend/src/lib/return-to";

test("backend SSO and frontend login accept the same return-target contract", () => {
  const cases: readonly unknown[] = [
    "/app",
    "/app/account",
    "/app/account?tab=security",
    null,
    undefined,
    "",
    "https://evil.example/app",
    "//evil.example/app",
    "/app/../admin",
    "/app/account\r\nSet-Cookie: x",
    42,
  ];
  for (const value of cases) {
    expect(resolveSsoReturnTarget(value) ?? "/app").toBe(resolveReturnTarget(value));
  }
});
