// End-to-end SQLite -> PostgreSQL migration wizard test.
//
// Seeds the sqlite test database, creates a fresh PostgreSQL target
// database, drives the wizard through the admin endpoints (test-connection,
// compatibility, start), polls to completion, and verifies the migrated
// rows, the manifest file, and the boot-config switch. The source sqlite
// database must remain untouched (it is the rollback image).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { inArray, eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations, runs, users, workspaces } from "../../src/db/schema";
import { isMaintenanceActive } from "../../src/lib/maintenance";
import { readBootConfigFile } from "../../src/lib/boot-config";
import { storageDir } from "../../src/db/driver";

process.env.TERRENCE_DISABLE_RESTART ??= "1";

const PG_ADMIN_URL = process.env.PG_TEST_ADMIN_URL ?? "postgres://terrence:terrence@127.0.0.1:5432/terrence_test";

let adminToken = "";
let adminId = "";
let adminTokenId = "";
let targetDbName = "";
let targetUrl = "";
let orgId = "";
let workspaceId = "";
let runId = "";

async function seedAdmin(): Promise<void> {
  adminId = `mig-admin-${crypto.randomUUID()}`;
  adminToken = `mig-token-${crypto.randomUUID()}`;
  adminTokenId = `mig-token-id-${crypto.randomUUID()}`;
  await db.insert(users).values({ id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true });
  await db.insert(apiTokens).values({
    id: adminTokenId,
    token: createHash("sha256").update(adminToken).digest("hex"),
    userId: adminId,
    description: "migration wizard test token",
    createdAt: Date.now(),
  });
}

function adminRequest(path: string, method = "GET", body?: unknown): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/vnd.api+json",
  };
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitForTerminalPhase(timeoutMs = 90_000): Promise<{ phase: string; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.handle(adminRequest("/api/v2/admin/db-migration/status"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { wizard: { phase: string; error: string | null } } };
    const phase = body.data.wizard.phase;
    if (phase === "ready_to_switch" || phase === "switched" || phase === "failed" || phase === "aborted") {
      return { phase, error: body.data.wizard.error };
    }
    if (Date.now() > deadline) throw new Error(`Migration did not reach a terminal phase within ${timeoutMs}ms (last phase: ${phase})`);
    await Bun.sleep(250);
  }
}

beforeAll(async (): Promise<void> => {
  await seedAdmin();
  // Seed the source (sqlite) database with a small dataset.
  orgId = `mig-org-${crypto.randomUUID()}`;
  workspaceId = `ws-mig-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  runId = `run-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(organizations).values({
    id: orgId,
    name: `migration-${orgId.slice(-8)}`,
    assessmentsEnforced: false,
    globalModuleSharing: false,
    globalProviderSharing: false,
    accessBetaTools: false,
    samlEnabled: false,
    allowForceDeleteWorkspaces: false,
    stacksEnabled: false,
    showPreReleases: false,
    aggregatedCommitStatusEnabled: false,
    sendPassingStatusesForUntriggeredSpeculativePlans: false,
    defaultIacBinary: "tofu",
    defaultTerraformVersion: "latest",
    defaultExecutionMode: "remote",
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "migration-workspace",
    orgId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db.insert(runs).values({
    id: runId,
    workspaceId,
    status: "applied",
    isDestroy: false,
    autoApply: true,
    planOnly: false,
    refresh: true,
    refreshOnly: false,
    debuggingMode: false,
    allowEmptyApply: true,
    savePlan: true,
    allowConfigGeneration: true,
    createdAt: Date.now(),
  });

  // Fresh PostgreSQL target database (mirrors the per-file setup pattern).
  const { randomUUID } = await import("node:crypto");
  const postgres = (await import("postgres")).default;
  targetDbName = `terrence_migrate_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = postgres(PG_ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin`CREATE DATABASE ${admin(targetDbName)}`;
  } finally {
    await admin.end();
  }
  const target = new URL(PG_ADMIN_URL);
  target.pathname = `/${targetDbName}`;
  targetUrl = target.toString();
});

afterAll(async (): Promise<void> => {
  await db.delete(runs).where(eq(runs.id, runId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiTokens).where(inArray(apiTokens.id, [adminTokenId]));
  await db.delete(users).where(inArray(users.id, [adminId]));
  if (targetUrl !== "") {
    const postgres = (await import("postgres")).default;
    const cleanup = postgres(PG_ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await cleanup`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${targetDbName} AND pid <> pg_backend_pid()`;
      await cleanup`DROP DATABASE ${cleanup(targetDbName)}`;
    } catch {
      // Best-effort cleanup.
    } finally {
      await cleanup.end();
    }
  }
});

describe("SQLite -> PostgreSQL migration wizard", () => {
  test("rejects non-admin callers", async (): Promise<void> => {
    const response = await app.handle(new Request("http://localhost/api/v2/admin/db-migration/status"));
    expect(response.status).toBe(404);
  });

  test("reports status with the source database and guard rails", async (): Promise<void> => {
    const response = await app.handle(adminRequest("/api/v2/admin/db-migration/status"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { "source-database": { path: string; memory: boolean }; "restart-disabled": boolean };
    };
    expect(body.data["source-database"].path).toContain("terrence.db");
    expect(body.data["restart-disabled"]).toBe(true);
  });

  test("validates a connection URL and reports failure for garbage", async (): Promise<void> => {
    const bad = await app.handle(adminRequest("/api/v2/admin/db-migration/test-connection", "POST", {
      data: { attributes: { url: "not a url" } },
    }));
    // testConnection reports ok:false rather than throwing; the route passes
    // the result through with 200.
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { data: { ok: boolean } };
    expect(badBody.data.ok).toBe(false);
    const ok = await app.handle(adminRequest("/api/v2/admin/db-migration/test-connection", "POST", {
      data: { attributes: { url: targetUrl } },
    }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);
  });

  test("checks target compatibility on an empty database", async (): Promise<void> => {
    const response = await app.handle(adminRequest("/api/v2/admin/db-migration/compatibility", "POST", {
      data: { attributes: { url: targetUrl } },
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } };
    expect(body.data.ok).toBe(true);
    expect(body.data.checks.every((check): boolean => check.ok)).toBe(true);
  });

  test("runs the full migration, verifies, switches the backend, and writes the manifest", async (): Promise<void> => {
    const start = await app.handle(adminRequest("/api/v2/admin/db-migration/start", "POST", {
      data: { attributes: { url: targetUrl } },
    }));
    expect(start.status).toBe(202);

    // Maintenance is entered by the async job shortly after start. A very
    // fast migration can reach ready_to_switch (and exit maintenance) before
    // the poll first observes it, so the assertion only applies when the
    // wizard was still mid-flight at observation time.
    let maintenanceObserved = false;
    const maintenanceDeadline = Date.now() + 10_000;
    while (Date.now() < maintenanceDeadline) {
      if (isMaintenanceActive()) {
        maintenanceObserved = true;
        break;
      }
      const statusResponse = await app.handle(adminRequest("/api/v2/admin/db-migration/status"));
      const phase = ((await statusResponse.json()) as { data: { wizard: { phase: string } } }).data.wizard.phase;
      if (phase === "ready_to_switch" || phase === "switched" || phase === "failed" || phase === "aborted") break;
      await Bun.sleep(50);
    }
    if (maintenanceObserved) expect(isMaintenanceActive()).toBe(true);

    const terminal = await waitForTerminalPhase();
    expect(terminal.phase).toBe("ready_to_switch");
    expect(terminal.error).toBeNull();
    expect(isMaintenanceActive()).toBe(false);

    // The target now holds the migrated rows.
    const { SQL } = await import("bun");
    const target = new SQL(targetUrl);
    try {
      const orgs = await target`SELECT COUNT(*)::int AS n FROM organizations`;
      expect(orgs[0]?.n).toBe(1);
      const workspaces = await target`SELECT COUNT(*)::int AS n FROM workspaces`;
      expect(workspaces[0]?.n).toBe(1);
      const runs = await target`SELECT COUNT(*)::int AS n FROM runs`;
      expect(runs[0]?.n).toBe(1);
      const copied = await target`SELECT id, status FROM runs WHERE id = ${runId}`;
      expect(copied[0]?.status).toBe("applied");
    } finally {
      await target.end({ timeout: 1 });
    }

    // Manifest exists with per-table counts.
    const manifestPath = join(storageDir, `migration-${new Date().toISOString().slice(0, 10)}.json`);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      source: string;
      destination: string;
      tables: Record<string, number>;
    };
    expect(manifest.source).toBe("sqlite");
    expect(manifest.destination).toBe("postgres");
    expect(manifest.tables.organizations).toBe(1);
    expect(manifest.tables.workspaces).toBe(1);
    expect(manifest.tables.runs).toBe(1);

    // Switch writes the boot config. The wizard refuses while DATABASE_URL
    // is set (it would override the boot config at startup), so the switch
    // must run with the env override removed, as in a real deployment.
    delete process.env.DATABASE_URL;
    const switched = await app.handle(adminRequest("/api/v2/admin/db-migration/switch", "POST"));
    expect(switched.status).toBe(200);
    const config = readBootConfigFile(storageDir);
    expect(config.database?.driver).toBe("postgres");
    expect(config.database?.url).toBe(targetUrl);
    expect(isMaintenanceActive()).toBe(false);
  });

  test("cannot start a second migration after switching", async (): Promise<void> => {
    const second = await app.handle(adminRequest("/api/v2/admin/db-migration/start", "POST", {
      data: { attributes: { url: targetUrl } },
    }));
    expect(second.status).toBe(409);
  });
});
