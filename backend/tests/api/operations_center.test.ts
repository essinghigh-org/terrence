import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users, adminSettings, auditLogs } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { invalidateSettingsCache } from "../../src/lib/settings";
import { rehearsalFreshness } from "../../src/routes/admin/operations-center";
import { readinessNodeId } from "../../src/routes/health";

const suffix = crypto.randomUUID();
const adminId = `ops-admin-${suffix}`;
const memberId = `ops-member-${suffix}`;
const adminToken = `ops-admin-token-${suffix}`;
const memberToken = `ops-member-token-${suffix}`;
let originalSettings: typeof adminSettings.$inferSelect | undefined;
const request = (path: string, token: string | null = adminToken, method = "GET", body?: unknown): Promise<Response> =>
  app.handle(
    new Request(`http://terrence.test/api/v2${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

beforeAll(async () => {
  originalSettings = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, "operations-center") });
  await db.insert(users).values([
    { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
    { id: memberId, username: memberId, passwordHash: "unused" },
  ]);
  await db.insert(apiTokens).values([
    { id: `ops-at-${suffix}`, userId: adminId, token: hashAuthenticationToken(adminToken) },
    { id: `ops-mt-${suffix}`, userId: memberId, token: hashAuthenticationToken(memberToken) },
  ]);
});

afterAll(async () => {
  await db.delete(adminSettings).where(eq(adminSettings.id, "operations-center"));
  if (originalSettings !== undefined) await db.insert(adminSettings).values(originalSettings);
  invalidateSettingsCache();
  await db
    .delete(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, adminId),
        eq(auditLogs.action, "update"),
        eq(auditLogs.resourceType, "operations-center-settings"),
        eq(auditLogs.resourceId, "operations-center"),
      ),
    );
  await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, memberId]));
  await db.delete(users).where(inArray(users.id, [adminId, memberId]));
});

test("restore freshness distinguishes absent, invalid, future, current and overdue evidence", () => {
  const now = Date.parse("2026-09-19T12:00:00Z");
  for (const date of [null, "invalid", new Date(now + 1).toISOString()])
    expect(rehearsalFreshness(date, 30, now).status).toBe("unknown");
  expect(rehearsalFreshness(new Date(now - 30 * 86_400_000).toISOString(), 30, now).status).toBe("current");
  expect(rehearsalFreshness(new Date(now - 31 * 86_400_000).toISOString(), 30, now)).toEqual({
    status: "overdue",
    ageDays: 31,
  });
});

test("operations center and browser support routes require a site administrator", async () => {
  for (const path of [
    "/admin/operations-center",
    "/admin/support-bundles",
    "/admin/support-bundles/missing",
    "/admin/support-bundles/missing/download",
  ]) {
    expect([401, 404]).toContain((await request(path, null)).status);
    expect((await request(path, memberToken)).status).toBe(404);
  }
  expect((await request("/admin/support-bundles", memberToken, "POST", { data: { attributes: {} } })).status).toBe(404);
  expect(
    (
      await request("/admin/operations-center/settings", memberToken, "PATCH", {
        data: { attributes: { "rehearsal-max-age-days": 14 } },
      })
    ).status,
  ).toBe(404);
  expect((await request("/admin/operations-center/settings", memberToken, "PATCH", {})).status).toBe(404);
});

test("rehearsal threshold persists, validates the envelope, and records an audit event", async () => {
  const update = await request("/admin/operations-center/settings", adminToken, "PATCH", {
    data: { attributes: { "rehearsal-max-age-days": 14 } },
  });
  expect(update.status).toBe(200);
  const response = await request("/admin/operations-center");
  const attrs = (await response.json()).data.attributes;
  expect(attrs["rehearsal-max-age-days"]).toBe(14);
  expect(attrs["supported-topology"]).toBe("single-active-control-plane");
  expect(["unknown", "current", "overdue"]).toContain(attrs.backup.status);
  expect(Array.isArray(attrs.nodes)).toBe(true);
  expect(attrs["execution-leases"]).toMatchObject({
    active: expect.any(Number),
    expired: expect.any(Number),
  });
  expect(
    await db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.userId, adminId),
        eq(auditLogs.action, "update"),
        eq(auditLogs.resourceType, "operations-center-settings"),
        eq(auditLogs.resourceId, "operations-center"),
      ),
    }),
  ).toBeDefined();
  for (const value of [null, [], "14", 0, 3651, 1.5]) {
    const invalid = await request("/admin/operations-center/settings", adminToken, "PATCH", {
      data: { attributes: { "rehearsal-max-age-days": value } },
    });
    expect(invalid.status).toBe(422);
  }
  for (const body of [{ data: { attributes: null } }, { data: { attributes: [] } }, { data: null }, {}]) {
    expect((await request("/admin/operations-center/settings", adminToken, "PATCH", body)).status).toBe(422);
  }
});

test("browser support generation is local-only, downloadable with admin auth, and deletable", async () => {
  const created = await request("/admin/support-bundles", adminToken, "POST", {
    data: { attributes: { nodes: ["not-local"], all: true } },
  });
  expect(created.status).toBe(202);
  const resource = (await created.json()).data;
  expect(resource.attributes.nodes.map((node: { node: string }) => node.node)).toEqual([readinessNodeId()]);
  expect(resource.links.self).toBe(`/api/v2/admin/support-bundles/${resource.id}`);
  const id = resource.id;
  try {
    let latest = resource;
    for (let index = 0; index < 100 && latest.attributes.status === "generating"; index++) {
      await Bun.sleep(50);
      latest = (await (await request(`/admin/support-bundles/${id}`)).json()).data;
    }
    expect(latest.attributes.status).toBe("finished");
    expect(latest.links.self).toBe(`/api/v2/admin/support-bundles/${id}`);
    expect(latest.links.download).toBe(`/api/v2/admin/support-bundles/${id}/download`);
    const listed = await (await request("/admin/support-bundles")).json();
    expect(listed.links.self).toBe("/api/v2/admin/support-bundles?page[number]=1&page[size]=20");
    expect(listed.data.some((bundle: { id: string }) => bundle.id === id)).toBe(true);
    expect(JSON.stringify(latest)).not.toContain(adminToken);
    const download = await request(`/admin/support-bundles/${id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toContain("application/gzip");
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await request(`/admin/support-bundles/${id}`, memberToken, "DELETE")).status).toBe(404);
  } finally {
    expect((await request(`/admin/support-bundles/${id}`, adminToken, "DELETE")).status).toBe(204);
  }
  expect((await request(`/admin/support-bundles/${id}`)).status).toBe(410);
}, 15000);

test("browser support routes hide multi-node System API bundle records", async () => {
  const id = crypto.randomUUID();
  const storage = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
  const directory = join(storage, "support-bundles");
  const path = join(directory, `${id}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    JSON.stringify({
      id,
      status: "finished",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nodes: [
        { node: readinessNodeId(), status: "finished", error: null },
        { node: "remote-control-plane", status: "finished", error: null },
      ],
    }),
    { mode: 0o600 },
  );
  try {
    const listed = await (await request("/admin/support-bundles")).json();
    expect(listed.data.some((bundle: { id: string }) => bundle.id === id)).toBe(false);
    expect((await request(`/admin/support-bundles/${id}`)).status).toBe(404);
    expect((await request(`/admin/support-bundles/${id}/download`)).status).toBe(404);
    expect((await request(`/admin/support-bundles/${id}`, adminToken, "DELETE")).status).toBe(404);
  } finally {
    await unlink(path).catch((): undefined => undefined);
  }
});
