import { expect, test } from "bun:test";
import { join } from "node:path";

const BACKEND_ROOT = join(import.meta.dir, "../..");

test("SQLite Drizzle config selects the static SQLite schema under a PostgreSQL URL", async () => {
  const script = `
    const config = (await import("./drizzle.config.ts")).default;
    if (config.schema !== "./src/db/schema-sqlite.ts") {
      throw new Error("SQLite Drizzle config loaded the dialect selector");
    }
    console.log(config.schema);
  `;
  const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
    cwd: BACKEND_ROOT,
    env: {
      ...Bun.env,
      DATABASE_URL: "postgres://example.invalid/terrence",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  expect(stdout.trim()).toBe("./src/db/schema-sqlite.ts");
});
