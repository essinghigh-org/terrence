import { rejects } from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { app } from "../../src/app";
import { db, isPostgres, rawQueryAll } from "../../src/db";
import { adminSettings, apiTokens, auditLogs, users } from "../../src/db/schema";
import { getPolicyEnforcementSettings } from "../../src/lib/policy-enforcement";
import { getSettings, invalidateSettingsCache } from "../../src/lib/settings";
import { hashAuthenticationToken } from "../../src/lib/token-service";

const group = "policy-enforcement";
const suffix = crypto.randomUUID();
const principals = ["admin", "member", "auditor"] as const;
const userId = (principal: string): string => `policy-settings-${principal}-${suffix}`;
const token = (principal: string): string => `policy-settings-token-${principal}-${suffix}`;
const whereAudit = and(eq(auditLogs.userId, userId("admin")), eq(auditLogs.resourceType, group));
let originalSettings: typeof adminSettings.$inferSelect | undefined;

async function request(method = "GET", attrs?: unknown, principal: string | null = "admin"): Promise<Response> {
  return app.handle(
    new Request(`http://terrence.test/api/v2/admin/${group}`, {
      method,
      headers: {
        ...(principal === null ? {} : { Authorization: `Bearer ${token(principal)}` }),
        "Content-Type": "application/vnd.api+json",
      },
      ...(attrs === undefined ? {} : { body: JSON.stringify({ data: { type: group, attributes: attrs } }) }),
    }),
  );
}

beforeAll(async () => {
  originalSettings = await db.query.adminSettings.findFirst({ where: eq(adminSettings.id, group) });
  await db.insert(users).values(
    principals.map((principal) => ({
      id: userId(principal),
      username: userId(principal),
      passwordHash: "unused",
      isSiteAdmin: principal === "admin",
      isSiteAuditor: principal === "auditor",
    })),
  );
  await db.insert(apiTokens).values(
    principals.map((principal) => ({
      id: crypto.randomUUID(),
      userId: userId(principal),
      token: hashAuthenticationToken(token(principal)),
    })),
  );
});

beforeEach(async () => {
  await db.delete(adminSettings).where(eq(adminSettings.id, group));
  await db.delete(auditLogs).where(whereAudit);
  invalidateSettingsCache();
});

afterAll(async () => {
  await db.delete(adminSettings).where(eq(adminSettings.id, group));
  if (originalSettings !== undefined) await db.insert(adminSettings).values(originalSettings);
  invalidateSettingsCache();
  await db.delete(auditLogs).where(whereAudit);
  await db.delete(apiTokens).where(inArray(apiTokens.userId, principals.map(userId)));
  await db.delete(users).where(inArray(users.id, principals.map(userId)));
});

describe("site-admin policy enforcement", () => {
  test("requires site admin for reads and writes, including site auditors", async () => {
    for (const principal of ["member", "auditor", null]) {
      const read = await request("GET", undefined, principal);
      const write = await request("PATCH", { revision: 0, reason: "Unauthorized bypass", opa: false }, principal);
      expect(principal === null ? [401, 404] : [404]).toContain(read.status);
      expect(principal === null ? [401, 404] : [404]).toContain(write.status);
    }
    expect(await getPolicyEnforcementSettings()).toEqual({ revision: 0, opa: true, sentinel: true });
    expect(await db.query.auditLogs.findMany({ where: whereAudit })).toHaveLength(0);
  });

  test("defaults to enforced and atomically audits independent changes and re-enabling", async () => {
    const initial = await request();
    expect(initial.status).toBe(200);
    expect((await initial.json()).data.attributes).toEqual({ revision: 0, opa: true, sentinel: true });
    const changed = await request("PATCH", { revision: 0, reason: "  Emergency OPA maintenance  ", opa: false });
    expect(changed.status).toBe(200);
    expect((await changed.json()).data.attributes).toEqual({ revision: 1, opa: false, sentinel: true });
    expect(await getPolicyEnforcementSettings()).toEqual({ revision: 1, opa: false, sentinel: true });
    const audit = await db.query.auditLogs.findFirst({ where: whereAudit });
    expect(audit).toMatchObject({
      action: "update",
      resourceType: group,
      resourceId: group,
      userId: userId("admin"),
      orgId: null,
    });
    expect(audit?.details).toMatchObject({
      reason: "Emergency OPA maintenance",
      immutable: true,
      scope: "site",
      before: { revision: 0, opa: true, sentinel: true },
      after: { revision: 1, opa: false, sentinel: true },
      bypass: { opa: true, sentinel: false },
      actor: { userId: userId("admin") },
    });
    const enabled = await request("PATCH", { revision: 1, reason: "Maintenance complete", opa: true, sentinel: false });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).data.attributes).toEqual({ revision: 2, opa: true, sentinel: false });
    expect((await request("PATCH", { revision: 0, reason: "Stale retry", opa: false })).status).toBe(409);
    expect(await db.query.auditLogs.findMany({ where: whereAudit })).toHaveLength(2);
  });

  test("requires reason, supported booleans and an explicit revision", async () => {
    const valid = { revision: 0, reason: "Incident mitigation", opa: false };
    for (const invalid of [
      { ...valid, reason: undefined },
      { ...valid, reason: " \n " },
      { ...valid, reason: "x".repeat(2001) },
      { ...valid, reason: "bad\u0000reason" },
      { ...valid, reason: 5 },
      { ...valid, revision: undefined },
      { ...valid, revision: -1 },
      { ...valid, revision: 1.5 },
      { ...valid, revision: "0" },
      { ...valid, opa: null },
      { ...valid, opa: "false" },
      { ...valid, sentinel: 0 },
      { ...valid, tfpolicy: false },
      { ...valid, opa: undefined },
      null,
      [],
      {},
    ])
      expect((await request("PATCH", invalid)).status).toBe(422);
    expect(await getPolicyEnforcementSettings()).toEqual({ revision: 0, opa: true, sentinel: true });
    expect(await db.query.auditLogs.findMany({ where: whereAudit })).toHaveLength(0);
  });

  test("allows only one concurrent update of a revision", async () => {
    const responses = await Promise.all([
      request("PATCH", { revision: 0, reason: "OPA maintenance", opa: false }),
      request("PATCH", { revision: 0, reason: "Sentinel maintenance", sentinel: false }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const settings = await getPolicyEnforcementSettings();
    expect(settings.revision).toBe(1);
    expect([settings.opa, settings.sentinel].filter((enabled) => !enabled)).toHaveLength(1);
    expect(await db.query.auditLogs.findMany({ where: whereAudit })).toHaveLength(1);
    expect(await responses.find((response) => response.status === 409)?.text()).toContain("Reload");
  });

  test("fresh gate reads observe other replicas and reject invalid persisted bypass values", async () => {
    await getSettings(group);
    await db
      .update(adminSettings)
      .set({ values: { revision: 1, opa: false, sentinel: true } })
      .where(eq(adminSettings.id, group));
    expect(await getPolicyEnforcementSettings()).toEqual({ revision: 1, opa: false, sentinel: true });
    expect((await (await request()).json()).data.attributes).toEqual({ revision: 1, opa: false, sentinel: true });
    await db
      .update(adminSettings)
      .set({ values: { revision: 1, opa: "false", sentinel: true } })
      .where(eq(adminSettings.id, group));
    await rejects(getPolicyEnforcementSettings(), /Invalid policy-enforcement.opa/);
    expect((await request()).status).toBe(503);
  });

  test("rolls back bypass and revision when mandatory audit persistence fails", async () => {
    await getSettings(group);
    if (isPostgres) {
      await rawQueryAll(
        sql.raw(
          "CREATE FUNCTION fail_policy_enforcement_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_type = 'policy-enforcement' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$",
        ),
      );
      await rawQueryAll(
        sql.raw(
          "CREATE TRIGGER fail_policy_enforcement_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_policy_enforcement_audit()",
        ),
      );
    } else {
      await rawQueryAll(
        sql.raw(
          "CREATE TRIGGER fail_policy_enforcement_audit BEFORE INSERT ON audit_logs WHEN NEW.resource_type = 'policy-enforcement' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
        ),
      );
    }
    try {
      expect((await request("PATCH", { revision: 0, reason: "Audit must persist", opa: false })).status).toBe(500);
      expect(await getPolicyEnforcementSettings()).toEqual({ revision: 0, opa: true, sentinel: true });
      expect(await db.query.auditLogs.findMany({ where: whereAudit })).toHaveLength(0);
    } finally {
      await rawQueryAll(sql.raw(`DROP TRIGGER fail_policy_enforcement_audit${isPostgres ? " ON audit_logs" : ""}`));
      if (isPostgres) await rawQueryAll(sql.raw("DROP FUNCTION fail_policy_enforcement_audit()"));
    }
    expect((await request("PATCH", { revision: 0, reason: "Audit restored", opa: false })).status).toBe(200);
  });
});
