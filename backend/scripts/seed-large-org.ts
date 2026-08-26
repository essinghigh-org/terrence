/**
 * seed-large-org.ts — large-org fixture generator (kanban 10.11).
 *
 * Seeds a single organization with N workspaces, per-workspace variables,
 * and projects in one pass so scaling regressions are reproducible: the
 * same arguments always produce the same shape, and per-phase timing makes
 * a regression measurable run to run.
 *
 * Uses direct batched inserts (no HTTP) — this is a fixture generator for
 * the app's own database, not an API exerciser. Point it at the target
 * database with DATABASE_URL/STORAGE_DIR exactly as the server uses them.
 *
 * Usage:
 *   DATABASE_URL=file:/path/terrence.db bun run scripts/seed-large-org.ts
 *   bun run scripts/seed-large-org.ts --workspaces 2000 --vars 4 --projects 10
 *
 * Options:
 *   --org=<name>        organization name (default perf-<epoch>)
 *   --workspaces=<n>    workspaces to create (default 500)
 *   --vars=<n>          terraform variables per workspace (default 3)
 *   --projects=<n>      projects to spread workspaces across (default 5)
 *   --batch=<n>         rows per insert statement (default 500)
 *   --user=<username>   owner user (default perf-<epoch>)
 *
 * Prints the created org/user names and a per-phase timing breakdown.
 */
import { performance } from "node:perf_hooks";
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import {
  organizationMemberships,
  organizations,
  projects,
  users,
  workspaceVariables,
  workspaces,
} from "../src/db/schema";

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function num(name: string, fallback: number): number {
  const raw = arg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--${name} must be a non-negative integer (got ${raw})`);
    process.exit(2);
  }
  return value;
}

const orgName = arg("org") ?? `perf-${Date.now()}`;
const workspaceCount = num("workspaces", 500);
const varsPerWorkspace = num("vars", 3);
const projectCount = Math.max(1, num("projects", 5));
const batchSize = Math.max(1, num("batch", 500));
const userName = arg("user") ?? `perf-${Date.now()}`;

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const orgId = `org-perf-${suffix}`;
const userId = `user-perf-${suffix}`;

function chunked<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const start = performance.now();
  const phases: { name: string; ms: number; count: number }[] = [];

  // --- user + org + ownership ------------------------------------------------
  let t0 = performance.now();
  await db.insert(users).values({ id: userId, username: userName, passwordHash: "unused-seed-password" });
  await db.insert(organizations).values({ id: orgId, name: orgName });
  await db.insert(organizationMemberships).values({
    id: `membership-perf-${suffix}`,
    userId,
    orgId,
    role: "owner",
    status: "active",
  });
  phases.push({ name: "user+org", ms: performance.now() - t0, count: 1 });

  // --- projects ----------------------------------------------------------------
  t0 = performance.now();
  const projectRows = Array.from({ length: projectCount }, (_, i) => ({
    id: `proj-perf-${suffix}-${i}`,
    orgId,
    name: `project-${i + 1}`,
    isDefault: i === 0,
  }));
  for (const chunk of chunked(projectRows, batchSize)) {
    await db.insert(projects).values(chunk);
  }
  phases.push({ name: "projects", ms: performance.now() - t0, count: projectCount });

  // --- workspaces ---------------------------------------------------------------
  t0 = performance.now();
  const workspaceRows = Array.from({ length: workspaceCount }, (_, i) => ({
    id: `ws-perf-${suffix}-${i}`,
    orgId,
    projectId: projectRows[i % projectCount]!.id,
    name: `workspace-${i + 1}`,
    executionMode: "remote",
  }));
  for (const chunk of chunked(workspaceRows, batchSize)) {
    await db.insert(workspaces).values(chunk);
  }
  phases.push({ name: "workspaces", ms: performance.now() - t0, count: workspaceCount });

  // --- variables ----------------------------------------------------------------
  t0 = performance.now();
  const variableRows = [];
  for (let w = 0; w < workspaceCount; w++) {
    for (let v = 0; v < varsPerWorkspace; v++) {
      variableRows.push({
        id: `var-perf-${suffix}-${w}-${v}`,
        workspaceId: workspaceRows[w]!.id,
        key: `perf_var_${v}`,
        value: `value-${w}-${v}`,
        category: "terraform",
      });
    }
  }
  for (const chunk of chunked(variableRows, batchSize)) {
    await db.insert(workspaceVariables).values(chunk);
  }
  phases.push({ name: "variables", ms: performance.now() - t0, count: variableRows.length });

  // --- verify counts --------------------------------------------------------------
  t0 = performance.now();
  const [wsCount, varCount, projCount] = await Promise.all([
    db.select({ n: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, orgId)),
    db.select({ n: workspaceVariables.id }).from(workspaceVariables).where(inArray(workspaceVariables.workspaceId, workspaceRows.map((r) => r.id))),
    db.select({ n: projects.id }).from(projects).where(eq(projects.orgId, orgId)),
  ]);
  const ok = wsCount.length === workspaceCount && varCount.length === variableRows.length && projCount.length === projectCount;
  phases.push({ name: "verify", ms: performance.now() - t0, count: wsCount.length + varCount.length + projCount.length });

  console.log(`org:  ${orgName} (${orgId})`);
  console.log(`user: ${userName} (${userId}, owner)`);
  for (const phase of phases) {
    console.log(`  ${phase.name.padEnd(10)} ${phase.count.toString().padStart(7)} rows  ${phase.ms.toFixed(1).padStart(8)} ms`);
  }
  console.log(`total: ${(performance.now() - start).toFixed(1)} ms`);
  if (!ok) {
    console.error(`COUNT MISMATCH: expected ${workspaceCount} workspaces / ${variableRows.length} variables / ${projectCount} projects`);
    process.exit(1);
  }
  console.log("verification: OK");
}

void main().catch((err: unknown) => {
  console.error("seed failed:", err);
  process.exit(1);
});
