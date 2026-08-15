import { afterEach, describe, expect, it } from "bun:test";
import {
  isDiskFullError,
  isStorageDegraded,
  markStorageDegraded,
  resetStorageHealthForTests,
  storageDegradedReason,
} from "../../src/lib/storage-health";

describe("storage health (kanban 3.23)", () => {
  afterEach(() => {
    resetStorageHealthForTests();
  });

  it("classifies ENOSPC, EDQUOT and SQLITE_FULL as disk-full errors", () => {
    expect(isDiskFullError(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }))).toBe(true);
    expect(isDiskFullError(Object.assign(new Error("quota exceeded"), { code: "EDQUOT" }))).toBe(true);
    expect(isDiskFullError(new Error("database or disk is full (code 13 SQLITE_FULL)"))).toBe(true);
  });

  it("does not classify other errors as disk-full", () => {
    expect(isDiskFullError(Object.assign(new Error("permission denied"), { code: "EACCES" }))).toBe(false);
    expect(isDiskFullError(new Error("broken pipe"))).toBe(false);
    expect(isDiskFullError(null)).toBe(false);
    expect(isDiskFullError("just a string")).toBe(false);
  });

  it("latches the degraded state on the first mark", () => {
    expect(isStorageDegraded()).toBe(false);
    markStorageDegraded("disk full");
    expect(isStorageDegraded()).toBe(true);
    expect(storageDegradedReason()).toBe("disk full");
    // Second mark is a no-op: the first reason is preserved.
    markStorageDegraded("something else");
    expect(storageDegradedReason()).toBe("disk full");
  });

  it("clears only via the test reset", () => {
    markStorageDegraded("disk full");
    resetStorageHealthForTests();
    expect(isStorageDegraded()).toBe(false);
    expect(storageDegradedReason()).toBeNull();
  });
});
