import { expect, test } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { db } from "../../src/db";
import { organizations, workspaces, configurationVersions, runs, logs, githubAppInstallations } from "../../src/db/schema";
import { eq, and } from "drizzle-orm";
import { executeRun } from "../../src/worker";

/**
 * Regression coverage for the VCS push-webhook race (kanban defect report):
 * push webhooks insert the run BEFORE the tarball download settles, so a
 * worker that claims the run first must WAIT for the configuration version
 * instead of planning against an empty workdir (which produced a
 * destroy-everything plan). Three failure modes are pinned:
 *   1. the download errored -> the run must fail loudly with the CV error
 *   2. the download is still "pending" -> the run must wait for the archive
 *      to settle, then plan normally once it is uploaded
 *   3. a settled status without a readable archive -> the run must fail
 *      loudly instead of planning empty
 *
 * All synchronization with the in-flight worker uses observable signals
 * (run status / plan-log markers) rather than fixed sleeps.
 */

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function seedVcsFixtures(): Promise<Readonly<{ orgId: string; workspaceId: string; cvId: string; runId: string }>> {
  const orgId = uniqueId("org");
  await db.insert(organizations).values({ id: orgId, name: `vcs-fetch-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  const installationId = uniqueId("ghain");
  await db.insert(githubAppInstallations).values({
    id: installationId,
    orgId,
    name: "fixture",
    installationId: 1,
    // The workspaces_vcs_repo_reference_check trigger enforces that any
    // vcsRepo.githubAppInstallationId actually resolves.
  });
  const workspaceId = uniqueId("ws");
  await db.insert(workspaces).values({
    id: workspaceId,
    orgId,
    name: "vcs-fetch-ws",
    source: "github",
    vcsRepo: { identifier: "acme/infra", branch: "main", githubAppInstallationId: installationId },
  });
  const cvId = uniqueId("cv");
  const runId = uniqueId("run");
  return { orgId, workspaceId, cvId, runId };
}

async function createRun(runId: string, workspaceId: string, cvId: string): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    workspaceId,
    configurationVersionId: cvId,
    status: "pending",
    createdAt: Date.now(),
  });
}

/** Bounded poll for a plan-log line instead of assuming a flush timing. */
async function waitForPlanLog(runId: string, needle: string, deadlineMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const planLogs = await db.query.logs.findMany({
      where: and(eq(logs.runId, runId), eq(logs.phase, "plan")),
    });
    if (planLogs.some((log): boolean => log.outputText.includes(needle))) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function makeTarball(archivePath: string): Promise<void> {
  const configDir = `${archivePath}.d`;
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "main.tf"), "terraform {}\n");
  const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
  expect(await tar.exited).toBe(0);
}

test("a run whose VCS configuration download errored fails loudly instead of planning empty", async () => {
  const { workspaceId, cvId, runId } = await seedVcsFixtures();
  await db.insert(configurationVersions).values({
    id: cvId,
    workspaceId,
    status: "errored",
    source: "github",
    error: "tarball fetch rejected: 401",
  });
  await createRun(runId, workspaceId, cvId);

  await executeRun(runId);

  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  expect(run?.status).toBe("errored");

  // The plan log must surface the underlying download error (and the run must
  // never reach a terminal "planned" state with zero configuration).
  expect(await waitForPlanLog(runId, "VCS configuration download failed: tarball fetch rejected: 401")).toBe(true);
});

test("a run claimed while the VCS tarball is still pending waits for the archive, then plans", async () => {
  const { workspaceId, cvId, runId } = await seedVcsFixtures();
  await db.insert(configurationVersions).values({
    id: cvId,
    workspaceId,
    status: "pending",
    source: "github",
    error: null,
  });
  await createRun(runId, workspaceId, cvId);

  // Start the run; the worker must be observably inside the pending-wait
  // (marker log) before the simulated download settles, so this test fails
  // if the wait logic is removed.
  const running = executeRun(runId);
  expect(await waitForPlanLog(runId, "Waiting for VCS configuration download to complete")).toBe(true);

  // The webhook download "settles" mid-flight: real tarball lands on disk
  // and the CV transitions to uploaded.
  const archivePath = join(process.env.TEST_DIR ?? "/tmp", `vcs-config-${Date.now()}.tar.gz`);
  await makeTarball(archivePath);
  await db.update(configurationVersions)
    .set({ status: "uploaded", archivePath })
    .where(eq(configurationVersions.id, cvId));

  await running;

  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  // Simulated plan (test mode) reports 1 addition, so the run reaches
  // "planned" - it must NOT have errored from a missing configuration.
  expect(run?.status).toBe("planned");
});

test("a settled configuration version without a readable archive fails loudly", async () => {
  const { workspaceId, cvId, runId } = await seedVcsFixtures();
  await db.insert(configurationVersions).values({
    id: cvId,
    workspaceId,
    status: "uploaded",
    source: "github",
    archivePath: join(process.env.TEST_DIR ?? "/tmp", "does-not-exist.tar.gz"),
    error: null,
  });
  await createRun(runId, workspaceId, cvId);

  await executeRun(runId);

  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  expect(run?.status).toBe("errored");
  expect(await waitForPlanLog(runId, "completed without a readable archive")).toBe(true);
});