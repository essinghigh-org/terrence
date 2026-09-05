import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { db } from "../../src/db";
import { organizations, workspaces } from "../../src/db/schema";

test("concurrent and repeated seeds reuse existing IDs", async (): Promise<void> => {
  const runSeed = async (): Promise<void> => {
    const child = Bun.spawn([process.execPath, "run", "seed.ts"], {
      cwd: resolve(import.meta.dir, "../.."),
      env: process.env,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
  };
  let organizationId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    await Promise.all([runSeed(), runSeed()]);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, "test-org") });
    expect(org?.id).toStartWith("org-");
    if (org === undefined) throw new Error("Missing seed organization");
    if (organizationId !== undefined) expect(org.id).toBe(organizationId);
    organizationId = org.id;
    const seededWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, org.id) });
    expect(seededWorkspaces).toHaveLength(1);
    expect(seededWorkspaces[0]?.id).toMatch(/^ws-[a-f0-9]{16}$/);
  }
});
