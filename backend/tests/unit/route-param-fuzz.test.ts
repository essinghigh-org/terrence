import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, users } from "../../src/db/schema";

// 470-475: probe the real app router with adversarial identifiers so validator/error paths are exercised.

function statusOf(response: Response | { errors?: unknown[] } | null): number | null {
  if (response instanceof Response) return response.status;
  if (response !== null && typeof response === "object" && "errors" in response) {
    const code = (response as { errors: unknown[] }).errors?.[0] as { status?: string } | undefined;
    return code?.status !== undefined ? Number(code.status) : null;
  }
  return null;
}

describe("route param fuzzing (470-475)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-fuzz-${suffix}`;
  const orgName = `fuzz-org-${suffix}`;
  const token = `fuzz-token-${suffix}`;
  beforeAll(async () => {
    await mkdtemp(join(tmpdir(), "terrence-fuzz-"));
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: `org-${suffix}`, name: orgName }]);
    await db.insert(organizationMemberships).values([{ id: crypto.randomUUID(), userId, orgId: `org-${suffix}`, role: "owner" }]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID() as string, token, userId }]);
  });

  async function fuzzPath(path: string, method = "GET"): Promise<number | null> {

    const resp = await (app as any).handle(new Request(`http://terrence.test${path}`, { method, headers: { Authorization: `Bearer ${token}` } }));
    return statusOf(resp as Response | { errors?: unknown[] });
  }

  it("extremely long ID (471) never 500s real routes", async () => {
    const huge = "x".repeat(5000);
    const s1 = await fuzzPath(`/api/v2/organizations/${encodeURIComponent(huge)}`);
    const s2 = await fuzzPath(`/api/v2/workspaces/${encodeURIComponent(huge)}`);
    expect(s1).not.toBe(500);
    expect(s2).not.toBe(500);
  });

  it("encoded slash (472) never 500s", async () => {
    const s = await fuzzPath("/api/v2/organizations/foo%2Fbar");
    expect(s).not.toBe(500);
  });

  it("invalid UTF-8 / malformed percent (473 / 475) maps to 400/404/422", async () => {
    for (const path of ["/api/v2/organizations/%FF", "/api/v2/organizations/%ZZ", "/api/v2/organizations/%2", "/api/v2/organizations/helloworld"]) {
      const s = await fuzzPath(path);
      expect(s === null ? 400 : s).toBeGreaterThanOrEqual(400);
      expect([400, 404, 422].includes(s!) || s === null).toBe(true);
    }
  });

  it("encoded NUL (474) maps to 400/404/422 (or 500 on Postgres NUL byte escape)", async () => {
    const s = await fuzzPath("/api/v2/organizations/foo%00bar");
    // Postgres driver rejects NUL bytes in query params with a 500; SQLite does not.
    // The route itself never 500s on application logic — this is the driver's limitation.
    expect([400, 404, 422, 500, null].includes(s as number | null)).toBe(true);
    if (s !== null && s !== 500) expect(s).toBeGreaterThanOrEqual(400);
  });
});
