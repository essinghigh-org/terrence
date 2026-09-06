import { rejects } from "node:assert/strict";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedProcess } from "../../src/lib/bounded-process";

const script = (source: string): string[] => [process.execPath, "-e", source];

describe("bounded subprocess supervision", () => {
  it("drains both streams concurrently", async () => {
    const output = await runBoundedProcess(script("process.stdout.write('o'.repeat(200000)); process.stderr.write('e'.repeat(200000))"), { maxStderrBytes: 250_000 });
    expect(output.stdout.length).toBe(200_000);
    expect(output.stderr.length).toBe(200_000);
  });

  it("rejects noisy stderr and stdout overflow", async () => {
    await rejects(runBoundedProcess(script("setInterval(() => process.stderr.write('x'.repeat(10000)), 1)"), { maxStderrBytes: 1000 }), /byte limit/);
    await rejects(runBoundedProcess(script("process.stdout.write('x'.repeat(10000))"), { maxStdoutBytes: 1000 }), /byte limit/);
  });

  it("reaps a hanging process on deadline and propagates cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terrence-bounded-process-"));
    const pidFile = join(directory, "pid");
    const start = Date.now();
    try {
      await rejects(runBoundedProcess(script(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`), { timeoutMs: 50 }));
      expect(Date.now() - start).toBeLessThan(2000);
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isInteger(pid)).toBeTrue();
      expect(() => process.kill(pid, 0)).toThrow();

      const controller = new AbortController();
      const pending = runBoundedProcess(script("setInterval(() => {}, 1000)"), { signal: controller.signal });
      controller.abort(new Error("cancel archive"));
      await rejects(pending, /cancel archive/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
