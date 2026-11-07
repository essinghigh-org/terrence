import { expect, test } from "bun:test";
import { chmod, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { storageDir } from "../../src/db/driver";
import { organizations, runs, workspaces } from "../../src/db/schema";
import { cleanupSavedPlan, reconcileInterruptedLocalRuns } from "../../src/worker";
import { captureRecoveryStatePayload, recoveryStatePathFor } from "../../src/lib/recovery-files";

test("retention prunes terminal and deleted native artifacts while preserving live plans and recovery state", async () => {
  const id = crypto.randomUUID(),
    org = `org-${id}`,
    workspace = `ws-${id}`;
  const names = ["terminal", "paired", "live", "recent", "deleted"].map((mode) => `run-${mode}-${id}`);
  const old = new Date(Date.now() - 365 * 86400000);
  await db.insert(organizations).values({ id: org, name: `native-lifecycle-${id}` });
  await db.insert(workspaces).values({ id: workspace, orgId: org, name: `native-lifecycle-${id}` });
  try {
    for (const [index, runId] of names.entries()) {
      if (index !== 4)
        await db
          .insert(runs)
          .values({
            id: runId,
            workspaceId: workspace,
            status: index === 2 ? "planned_and_saved" : "applied",
            createdAt: Date.now(),
          });
      const directory = join(storageDir, "native-policy", runId),
        source = join(directory, "generation", "source");
      await mkdir(source, { recursive: true, mode: 0o700 });
      await writeFile(join(source, "proof.policy.hcl"), "# frozen policy source\n", { mode: 0o400 });
      await chmod(source, 0o500);
      await chmod(join(directory, "generation"), 0o500);
      if (index !== 3) await utimes(directory, old, old);
      if (index === 1) {
        const saved = join(storageDir, "saved-plans", runId);
        await mkdir(saved, { recursive: true, mode: 0o700 });
        await writeFile(join(saved, "tfplan"), "opaque encrypted plan", { mode: 0o600 });
        await utimes(saved, old, old);
      }
    }
    const terminal = names[0] ?? "";
    await captureRecoveryStatePayload(
      storageDir,
      terminal,
      JSON.stringify({ version: 4, terraform_version: "1.17.1", serial: 1, lineage: id, resources: [] }),
    );
    await reconcileInterruptedLocalRuns();
    for (const index of [0, 1, 4])
      expect(
        await stat(join(storageDir, "native-policy", names[index] ?? "")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    expect(
      await stat(join(storageDir, "saved-plans", names[1] ?? "")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    for (const index of [2, 3])
      expect(
        await stat(join(storageDir, "native-policy", names[index] ?? "")).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    expect(await Bun.file(recoveryStatePathFor(storageDir, terminal)).exists()).toBe(true);
    // Explicit discard/delete uses this same paired cleanup, including frozen sources.
    await cleanupSavedPlan(names[2] ?? "");
    expect(
      await stat(join(storageDir, "native-policy", names[2] ?? "")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    for (const runId of names) await cleanupSavedPlan(runId);
    await db.delete(runs).where(eq(runs.workspaceId, workspace));
    await db.delete(workspaces).where(eq(workspaces.id, workspace));
    await db.delete(organizations).where(eq(organizations.id, org));
  }
});
