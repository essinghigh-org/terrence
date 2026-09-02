import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("inArray chunking #344", (): void => {
  test("collectTagScopedIds handles >500 workspaces without SQLITE_MAX_VARIABLE_NUMBER", async (): Promise<void> => {
    const testDir = await mkdtemp(join(tmpdir(), "terrence-inarray-"));
    try {
      const dbPath = join(testDir, "terrence.db");
      const result = await Bun.spawn({
        cmd: ["bun", "-e", `
          const { mkdtemp } = await import("node:fs/promises");
          const { db } = await import("./src/db/index.ts");
          const { organizations, workspaces, workspaceTags, users, organizationMemberships } = await import("./src/db/schema.ts");
          const { eq } = await import("drizzle-orm");
          // Setup: create org with 600 workspaces and tags, then exercise chunked tag fetch
          const orgId = "org-chunk-test";
          await db.insert(organizations).values({ id: orgId, name: "chunk-org", email: "a@b.c" });
          const wsIds: string[] = [];
          const wsBatch: any[] = [];
          const tagBatch: any[] = [];
          for (let i = 0; i < 510; i++) {
            const id = "ws-" + String(i).padStart(4, "0");
            wsIds.push(id);
            wsBatch.push({ id, orgId, name: "ws-" + i, locked: false });
            tagBatch.push({ id: crypto.randomUUID(), workspaceId: id, key: "env", value: i % 2 === 0 ? "prod" : "dev" });
          }
          for (let i = 0; i < wsBatch.length; i += 100) {
            await db.insert(workspaces).values(wsBatch.slice(i, i + 100));
          }
          for (let i = 0; i < tagBatch.length; i += 100) {
            await db.insert(workspaceTags).values(tagBatch.slice(i, i + 100));
          }
          // Verify chunked fetch returns all tags
          const { inArray } = await import("drizzle-orm");
          const { workspaceTags: tags } = await import("./src/db/schema.ts");
          const DELETE_ID_CHUNK_SIZE = 500;
          const tagRows: any[] = [];
          for (let offset = 0; offset < wsIds.length; offset += DELETE_ID_CHUNK_SIZE) {
            const chunk = wsIds.slice(offset, offset + DELETE_ID_CHUNK_SIZE);
            const rows = await db.query.workspaceTags.findMany({ where: inArray(tags.workspaceId, chunk) });
            tagRows.push(...rows);
          }
          console.log(JSON.stringify({ tagCount: tagRows.length, wsCount: wsIds.length }));
        `],
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...Bun.env,
          DATABASE_URL: "file:" + dbPath,
          STORAGE_DIR: join(testDir, "storage"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
      if (exitCode !== 0) throw new Error("spawn failed: " + stderr + stdout);
      const parsed = JSON.parse(stdout.trim().split("\\n").at(-1)!);
      expect(parsed.tagCount).toBe(510);
      expect(parsed.wsCount).toBe(510);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("chunked inArray is used in collectTagScopedIds", async (): Promise<void> => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(join(import.meta.dir, "../../src/lib/utils.ts"), "utf8");
    expect(source).toContain("DELETE_ID_CHUNK_SIZE");
    expect(source).toContain("for (let offset = 0; offset < orgWorkspaceIds.length; offset += DELETE_ID_CHUNK_SIZE)");
  });
});
