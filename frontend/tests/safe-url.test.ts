import { describe, test, expect } from "bun:test";
import { safeHttpUrl } from "@/lib/safe-url";

describe("safeHttpUrl #365", (): void => {
  test("accepts http and https", (): void => {
    expect(safeHttpUrl("https://example.com/foo")).toBe("https://example.com/foo");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com");
    expect(safeHttpUrl("https://github.com/owner/repo/commit/abc123")).toBeTruthy();
  });
  test("rejects javascript, data, blob, file", (): void => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpUrl("blob:https://example.com/uuid")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("vbscript:msgbox(1)")).toBeNull();
  });
  test("rejects relative and empty", (): void => {
    expect(safeHttpUrl("/api/v2/provider-icons/hashicorp/aws")).toBe("/api/v2/provider-icons/hashicorp/aws");
    expect(safeHttpUrl("//example.com/foo")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
  test("rejects invalid urls", (): void => {
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("https://")).toBeNull();
  });
});
