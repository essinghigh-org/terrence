// End-to-end SQLite -> PostgreSQL migration wizard test.
//
// Seeds the sqlite test database, creates a fresh PostgreSQL target
// database, drives the wizard through the admin endpoints (test-connection,
// compatibility, start), polls to completion, and verifies the migrated
// rows, the manifest file, and the boot-config switch. The source sqlite
// database must remain untouched (it is the rollback image).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runDbExport } from "../../src/lib/db-export";
import { encryptSecret, decryptSecret } from "../../src/lib/secrets";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inArray, eq, count } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, configurationVersions, organizationMemberships, organizations, runs, users, workspaceVariables, workspaces } from "../../src/db/schema";
import { isMaintenanceActive, exitMaintenance } from "../../src/lib/maintenance";
import { readBootConfigFile } from "../../src/lib/boot-config";
import { storageDir } from "../../src/db/driver";
import { makeTestDbName } from "../setup";
const isPostgresEnv = process.env["PG_TEST_ADMIN_URL"] !== undefined || process.env["PG_ADMIN_URL"] !== undefined || (process.env["DATABASE_URL"]?.startsWith("postgres") ?? false);


process.env["TERRENCE_DISABLE_RESTART"] ??= "1";
process.env["MIGRATION_SKIP_DRAIN"] = "true";

const PG_ADMIN_URL = process.env["PG_TEST_ADMIN_URL"] ?? process.env["PG_ADMIN_URL"] ?? (process.env["DATABASE_URL"]?.startsWith("postgres") === true ? process.env["DATABASE_URL"] : undefined) ?? "postgres://terrence:terrence@127.0.0.1:5432/terrence_test";

let adminToken = "";
let adminId = "";
let adminTokenId = "";
let targetDbName = "";
let targetUrl = "";
let orgId = "";
let workspaceId = "";
let runId = "";
let encryptedValue = "";
const fixtureTimestamp = 1_788_000_123_456;
const fixtureMetadata = { identifier: "example/infrastructure", branch: "main", tags: ["one", "two"], enabled: false, nested: { value: null } };

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

let postgresAvailable = false;

beforeAll(async (): Promise<void> => {
  const { rmSync } = await import("node:fs");
  rmSync(join(storageDir, "migration-wizard.json"), { force: true });
  rmSync(join(storageDir, "terrence.json"), { force: true });
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
    vcsRepo: fixtureMetadata,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
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

  const archivePath = join(storageDir, "round-trip-configuration.tar.gz");
  writeFileSync(archivePath, "retained-configuration-fixture");
  await db.insert(configurationVersions).values({ id: `cv-${orgId}`, workspaceId, status: "uploaded", archivePath });
  await db.insert(organizationMemberships).values({ id: `membership-${orgId}`, orgId, userId: adminId, role: "member", status: "active", ssoSource: null });
  encryptedValue = await encryptSecret("round-trip-test-secret", { force: true });
  await db.insert(workspaceVariables).values({ id: `variable-${orgId}`, workspaceId, key: "credential", value: "", valueEncrypted: encryptedValue, sensitive: true, hcl: false, category: "env", description: null });

  if (!isPostgresEnv) return;
  try {
    // Fresh PostgreSQL target database (mirrors the per-file setup pattern).
    const { SQL } = await import("bun");
    targetDbName = makeTestDbName("terrence_migrate");
    const admin = new SQL(PG_ADMIN_URL);
    try {
      await admin.unsafe(`CREATE DATABASE "${targetDbName}"`);
    } finally {
      await admin.close();
    }
    const target = new URL(PG_ADMIN_URL);
    target.pathname = `/${targetDbName}`;
    targetUrl = target.toString();
    postgresAvailable = true;
  } catch (error: unknown) {
    if (isPostgresEnv) throw new Error("Required PostgreSQL migration fixture failed to initialize", { cause: error });
    postgresAvailable = false;
  }
});

afterAll(async (): Promise<void> => {
  const { rmSync } = await import("node:fs");
  exitMaintenance();
  rmSync(join(storageDir, "migration-wizard.json"), { force: true });
  rmSync(join(storageDir, "terrence.json"), { force: true });
  rmSync(join(storageDir, "maintenance.json"), { force: true });
  await db.delete(runs).where(eq(runs.id, runId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiTokens).where(inArray(apiTokens.id, [adminTokenId]));
  await db.delete(users).where(inArray(users.id, [adminId]));
  if (targetUrl !== "") {
    const { SQL } = await import("bun");
    const cleanup = new SQL(PG_ADMIN_URL);
    try {
      await cleanup`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${targetDbName} AND pid <> pg_backend_pid()`;
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${targetDbName}"`);
    } catch {
      // Best-effort cleanup.
    } finally {
      await cleanup.close();
    }
  }
});

describe.skipIf(!isPostgresEnv)("SQLite -> PostgreSQL migration wizard", () => {
  test("rejects non-admin callers", async (): Promise<void> => {
    const response = await app.handle(new Request("http://localhost/api/v2/admin/db-migration/status"));
    expect(response.status).toBe(404);
  });

  test("reports status with the source database and guard rails", async (): Promise<void> => {
    const response = await app.handle(adminRequest("/api/v2/admin/db-migration/status"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { "source-database": { path: string; memory: boolean } | null; "restart-disabled": boolean };
    };
    // The wizard is SQLite->Postgres only; on Postgres DATABASE_URL the
    // source is null (no sqlite file to migrate).
    const isPg = (process.env["DATABASE_URL"] ?? "").startsWith("postgres");
    if (isPg) {
      expect(body.data["source-database"]).toBeNull();
    } else {
      expect((body.data["source-database"] as { path: string }).path).toContain("terrence.db");
    }
    expect(body.data["restart-disabled"]).toBe(true);
  });

  test("validates a connection URL and reports failure for garbage", async (): Promise<void> => {
    const bad = await app.handle(adminRequest("/api/v2/admin/db-migration/test-connection", "POST", {
      data: { attributes: { url: "not a url" } },
    }));
    expect(bad.status).toBe(200);
    const body = (await bad.json()) as { data: { ok: boolean; error: string } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error.toLowerCase()).toMatch(/postgres|invalid url|cannot be parsed/);

    if (postgresAvailable) {
      const ok = await app.handle(adminRequest("/api/v2/admin/db-migration/test-connection", "POST", {
        data: { attributes: { url: targetUrl } },
      }));
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { data: { ok: boolean } };
      expect(okBody.data.ok).toBe(true);
    }
  });

  test("checks target compatibility on an empty database", async (): Promise<void> => {
    if (!postgresAvailable) return;
    const response = await app.handle(adminRequest("/api/v2/admin/db-migration/compatibility", "POST", {
      data: { attributes: { url: targetUrl } },
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } };
    expect(body.data.ok).toBe(true);
    expect(body.data.checks.every((check): boolean => check.ok)).toBe(true);
  });

  test("missing artifacts prevent switching and persisted interruption remains resumable", async (): Promise<void> => {
    if (!postgresAvailable || (process.env["DATABASE_URL"] ?? "").startsWith("postgres")) return;
    const archivePath = join(storageDir, "round-trip-configuration.tar.gz");
    rmSync(archivePath);
    const start = await app.handle(adminRequest("/api/v2/admin/db-migration/start", "POST", { data: { attributes: { url: targetUrl } } }));
    expect(start.status).toBe(202);
    const terminal = await waitForTerminalPhase();
    expect(terminal.phase).toBe("failed");
    expect(terminal.error).toContain("Artifact verification failed");
    const switchResponse = await app.handle(adminRequest("/api/v2/admin/db-migration/switch", "POST"));
    expect(switchResponse.status).toBe(409);
    expect(readBootConfigFile(storageDir).database).toBeUndefined();
    writeFileSync(archivePath, "retained-configuration-fixture");
    // Reconstruct the durable state a process exit during verification leaves.
    // The following API read must identify interruption; the next test resumes
    // against the populated target and runs the entire integrity gate again.
    const statePath = join(storageDir, "migration-wizard.json");
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    writeFileSync(statePath, JSON.stringify({ ...stored, phase: "verifying" }));
    const response = await app.handle(adminRequest("/api/v2/admin/db-migration/status"));
    const body = await response.json() as { data: { wizard: { phase: string } } };
    expect(body.data.wizard.phase).toBe("interrupted");
  }, 90_000);

  test("runs the full migration, verifies, switches the backend, and writes the manifest", async (): Promise<void> => {
    if (!postgresAvailable) return;
    // Wizard is SQLite->Postgres only; skip when already on Postgres.
    if ((process.env["DATABASE_URL"] ?? "").startsWith("postgres")) return;
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
    expect(maintenanceObserved).toBe(true);

    const terminal = await waitForTerminalPhase();
    expect(terminal.error).toBeNull();
    expect(terminal.phase).toBe("ready_to_switch");
    expect(isMaintenanceActive()).toBe(false);

    const [sourceOrgs, sourceWorkspaces, sourceRuns] = await Promise.all([
      db.select({ val: count() }).from(organizations),
      db.select({ val: count() }).from(workspaces),
      db.select({ val: count() }).from(runs),
    ]);
    const expectedOrgs = sourceOrgs[0]?.val ?? 1;
    const expectedWorkspaces = sourceWorkspaces[0]?.val ?? 1;
    const expectedRuns = sourceRuns[0]?.val ?? 1;

    // The target now holds the migrated rows.
    const { SQL } = await import("bun");
    const target = new SQL(targetUrl);
    try {
      const orgs = await target`SELECT COUNT(*)::int AS n FROM organizations`;
      expect(orgs[0]?.n).toBe(expectedOrgs);
      const workspaces = await target`SELECT COUNT(*)::int AS n FROM workspaces`;
      expect(workspaces[0]?.n).toBe(expectedWorkspaces);
      const runs = await target`SELECT COUNT(*)::int AS n FROM runs`;
      expect(runs[0]?.n).toBe(expectedRuns);
      const copied = await target`SELECT id, status FROM runs WHERE id = ${runId}`;
      expect(copied[0]?.status).toBe("applied");
    } finally {
      await target.end({ timeout: 1 });
    }

    // Export the migrated target through the supported exporter, then compare
    // domain values rather than PostgreSQL/SQLite physical representations.
    const exported = await runDbExport({ pgUrl: targetUrl, outputName: "migration-round-trip.db" });
    expect(exported.verification.allPassed).toBe(true);
    const restored = new Database(exported.filePath, { readonly: true });
    try {
      const workspace = restored.query("SELECT vcs_repo, created_at, updated_at FROM workspaces WHERE id = ?").get(workspaceId) as { vcs_repo: string; created_at: number; updated_at: number };
      expect(JSON.parse(workspace.vcs_repo)).toEqual(fixtureMetadata);
      expect(workspace.created_at).toBe(fixtureTimestamp);
      expect(workspace.updated_at).toBe(fixtureTimestamp);
      const membership = restored.query("SELECT user_id, role, status, sso_source FROM organization_memberships WHERE org_id = ?").get(orgId);
      expect(membership).toEqual({ user_id: adminId, role: "member", status: "active", sso_source: null });
      const variable = restored.query("SELECT value, value_encrypted, sensitive, hcl, description FROM workspace_variables WHERE workspace_id = ?").get(workspaceId) as { value: string; value_encrypted: string; sensitive: number; hcl: number; description: null };
      expect(variable).toEqual({ value: "", value_encrypted: encryptedValue, sensitive: 1, hcl: 0, description: null });
      expect(await decryptSecret(variable.value_encrypted)).toBe("round-trip-test-secret");
      expect(restored.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const copiedToken = restored.query("SELECT token, user_id FROM api_tokens WHERE id = ?").get(adminTokenId);
      const sourceToken = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, adminTokenId) });
      expect(copiedToken).toEqual({ token: sourceToken?.token, user_id: adminId });
    } finally {
      restored.close();
    }

    // Manifest exists with per-table counts.
    const manifestPath = join(storageDir, `migration-${new Date().toISOString().slice(0, 10)}.json`);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      source: string;
      destination: string;
      tables: Record<string, number>;
      artifact_references: { table: string; checked: number; unavailable: number }[];
    };
    expect(manifest.source).toBe("sqlite");
    expect(manifest.destination).toBe("postgres");
    expect(manifest.artifact_references.find((check) => check.table === "configuration_versions")).toMatchObject({ checked: 1, unavailable: 0 });
    expect(manifest.tables["organizations"]).toBe(expectedOrgs);
    expect(manifest.tables["workspaces"]).toBe(expectedWorkspaces);
    expect(manifest.tables["runs"]).toBe(expectedRuns);

    // Switch writes the boot config. The wizard refuses while DATABASE_URL
    // is set (it would override the boot config at startup), so the switch
    // must run with the env override removed, as in a real deployment.
    delete process.env["DATABASE_URL"];
    const switched = await app.handle(adminRequest("/api/v2/admin/db-migration/switch", "POST"));
    expect(switched.status).toBe(200);
    const config = readBootConfigFile(storageDir);
    expect(config.database?.driver).toBe("postgres");
    expect(config.database?.url).toBe(targetUrl);
    expect(isMaintenanceActive()).toBe(false);
  }, 90_000);

  test("cannot start a second migration after switching", async (): Promise<void> => {
    if (!postgresAvailable) return;
    if ((process.env["DATABASE_URL"] ?? "").startsWith("postgres")) return;
    const second = await app.handle(adminRequest("/api/v2/admin/db-migration/start", "POST", {
      data: { attributes: { url: targetUrl } },
    }));
    expect(second.status).toBe(409);
  });
});
