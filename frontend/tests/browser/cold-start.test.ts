import { expect, test } from "bun:test";
import { join } from "node:path";

// Every attempt must pass; these are separate cold-start regressions, not retries.
for (let attempt = 1; attempt <= 5; attempt++) {
  test(`fresh browser process completes startup and application navigation (${attempt}/5)`, async (): Promise<void> => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../scripts/browser-tests.ts"), "--cold-start"],
      {
        env: { ...process.env, CI: "true" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => {
      child.kill();
    }, 42_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toContain("Cold browser startup and application navigation passed");
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
    }
  }, 45_000);
}
