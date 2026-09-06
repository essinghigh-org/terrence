import { afterEach, describe, expect, test } from "bun:test";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureProcessOutput,
  PROCESS_OUTPUT_PREVIEW_CHARS,
  writeProcessOutputFile,
} from "../../src/lib/process-output";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("process output capture", () => {
  test("spools large streams while keeping bounded previews and lossless files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terrence-process-output-test-"));
    temporaryDirectories.push(directory);
    const child = Bun.spawn([
      "python3",
      "-c",
      "import sys; sys.stdout.write('o' * 200000); sys.stderr.write('e' * 300000)",
    ], { stdout: "pipe", stderr: "pipe" });

    const captured = await captureProcessOutput(child.stdout, child.stderr, directory, "large-output");
    expect(await child.exited).toBe(0);
    expect(captured.stdout.bytes).toBe(200000);
    expect(captured.stderr.bytes).toBe(300000);
    expect(captured.stdout.preview).toHaveLength(PROCESS_OUTPUT_PREVIEW_CHARS);
    expect(captured.stderr.preview).toHaveLength(PROCESS_OUTPUT_PREVIEW_CHARS);
    expect(captured.stdout.truncated).toBe(true);
    expect(captured.stderr.truncated).toBe(true);
    expect((await readFile(captured.stdout.path, "utf8"))).toHaveLength(200000);
    expect((await readFile(captured.stderr.path, "utf8"))).toHaveLength(300000);

    const artifactPath = join(directory, "combined.log");
    await writeProcessOutputFile(artifactPath, [
      "stdout:\n",
      { path: captured.stdout.path },
      "\nstderr:\n",
      { path: captured.stderr.path },
    ]);
    const artifact = await readFile(artifactPath, "utf8");
    expect(artifact.startsWith("stdout:\n" + "o".repeat(200000) + "\nstderr:\n")).toBe(true);
    expect(artifact.endsWith("e".repeat(300000))).toBe(true);
  });

  test("cancellation stops a stalled capture and leaves no output files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terrence-process-output-cancel-"));
    temporaryDirectories.push(directory);
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => process.stdout.write('x'), 10)"], { stdout: "pipe", stderr: "pipe" });
    const controller = new AbortController();
    const capture = captureProcessOutput(child.stdout, child.stderr, directory, "cancel", { signal: controller.signal });
    await Bun.sleep(30);
    controller.abort(new Error("capture canceled"));
    const failure = await capture.catch((error: unknown): unknown => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("capture canceled");
    child.kill("SIGKILL");
    await child.exited;
    expect(await readdir(directory)).toEqual([]);
  });
});
