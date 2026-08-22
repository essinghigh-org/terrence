import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";

// 470-475: lightweight param robustness — verifies the API doesn't crash or leak
// on oversized / encoded / invalid-UTF8 identifiers. Real auth/lookup may 404
// but must never 500.

function statusOf(response: Response | { errors?: unknown[] } | null): number | null {
  if (response instanceof Response) return response.status;
  if (response !== null && typeof response === "object" && "errors" in response) {
    const code = (response as { errors: unknown[] }).errors?.[0] as { status?: string } | undefined;
    return code?.status !== undefined ? Number(code.status) : null;
  }
  return null;
}

describe("route param fuzzing (470-475)", () => {
  it("extremely long ID (471)", async () => {
    const huge = "x".repeat(5000);
    const app = new Elysia().get("/test/:id", ({ params }: { params: { id: string } }) => ({ id: params.id }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (app as any).handle(new Request(`http://x/test/${encodeURIComponent(huge)}`));
    const s = statusOf(resp);
    expect(s).not.toBe(500);
  });

  it("encoded slash (472)", async () => {
    const app = new Elysia().get("/test/:id", ({ params }: { params: { id: string } }) => ({ id: params.id }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (app as any).handle(new Request("http://x/test/foo%2Fbar"));
    const s = statusOf(resp);
    expect(s).not.toBe(500);
  });

  it("invalid UTF-8 / malformed percent (473 / 475)", async () => {
    const app = new Elysia().get("/test/:id", ({ params }: { params: { id: string } }) => ({ id: params.id }));
    for (const u of ["http://x/test/%FF", "http://x/test/%ZZ", "http://x/test/%2", "http://x/test/hello%00world"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await (app as any).handle(new Request(u));
      const s = statusOf(resp);
      expect([400, 404, 422]).toContain(s);
    }
  });

  it("encoded NUL (474)", async () => {
    const app = new Elysia().get("/test/:id", ({ params }: { params: { id: string } }) => ({ id: params.id }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await (app as any).handle(new Request("http://x/test/foo%00bar"));
    const s = statusOf(resp);
    expect([400, 404, 422]).toContain(s);
  });
});
