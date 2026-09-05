import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureInterruptedApplyState,
  recoveryMarkerPathFor,
  recoveryStatePathFor,
  sweepIncompleteRecoveryCopies,
  writeFileDurable,
} from "../../src/lib/recovery-files";
import { decodeStatePayload, decryptStatePayload } from "../../src/lib/validation";

// Atomic interrupted-apply recovery coverage (issue #579): durable writes
// never leave a partial published file, captures are read-back verified,
// and the boot sweep adopts complete-but-unmarked copies while dropping
// unverifiable partials and staging temps.
//
// STORAGE_DIR is redirected per test (secrets/validation resolve it at call
// time) and restored afterwards; the backend runs suites single-worker so no
// parallel test can observe the redirect.

const savedStorageDir = process.env["STORAGE_DIR"];
let storageDir = "";

async function isolateStorage(): Promise<void> {
  storageDir = await mkdtemp(join(tmpdir(), "terrence-recovery-"));
  process.env["STORAGE_DIR"] = storageDir;
}

afterEach(async (): Promise<void> => {
  if (savedStorageDir === undefined) delete process.env["STORAGE_DIR"];
  else process.env["STORAGE_DIR"] = savedStorageDir;
  if (storageDir !== "") await rm(storageDir, { recursive: true, force: true });
  storageDir = "";
});

const STATE_JSON = JSON.stringify({
  version: 4,
  terraform_version: "1.9.3",
  serial: 7,
  lineage: "abc123",
  outputs: {},
  resources: [],
});

describe("writeFileDurable (#579)", () => {
  it("publishes content with mode bits and no staging leftovers", async () => {
    await isolateStorage();
    const dir = join(storageDir, "w");
    await writeFileDurable(dir, "copy.json", STATE_JSON, 0o600);
    expect(await readFile(join(dir, "copy.json"), "utf8")).toBe(STATE_JSON);
    expect((await stat(join(dir, "copy.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["copy.json"]);
  });

  it("atomically replaces an existing file", async () => {
    await isolateStorage();
    const dir = join(storageDir, "w");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "copy.json"), "stale");
    await writeFileDurable(dir, "copy.json", STATE_JSON, 0o600);
    expect(await readFile(join(dir, "copy.json"), "utf8")).toBe(STATE_JSON);
    expect(await readdir(dir)).toEqual(["copy.json"]);
  });
});

describe("captureInterruptedApplyState (#579)", () => {
  it("captures, verifies, and marks a state file found in the work root", async () => {
    await isolateStorage();
    const workRoot = join(storageDir, "work");
    await mkdir(join(workRoot, "nested"), { recursive: true });
    await writeFile(join(workRoot, "nested", "terraform.tfstate"), STATE_JSON);
    expect(await captureInterruptedApplyState(storageDir, "run-1", workRoot)).toBe(true);
    const stored = await readFile(recoveryStatePathFor(storageDir, "run-1"), "utf8");
    expect(decodeStatePayload(stored)).toBe(STATE_JSON);
    expect(await readFile(recoveryMarkerPathFor(storageDir, "run-1"), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await stat(recoveryStatePathFor(storageDir, "run-1"))).mode & 0o777).toBe(0o600);
  });

  it("captures partial non-JSON bytes without parsing them (cancel path contract)", async () => {
    await isolateStorage();
    const workRoot = join(storageDir, "work");
    await mkdir(workRoot, { recursive: true });
    await writeFile(join(workRoot, "terraform.tfstate"), "partial-state");
    expect(await captureInterruptedApplyState(storageDir, "run-partial", workRoot)).toBe(true);
    const stored = await readFile(recoveryStatePathFor(storageDir, "run-partial"), "utf8");
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(decryptStatePayload(stored)).toBe("partial-state");
    expect(await readFile(recoveryMarkerPathFor(storageDir, "run-partial"), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects invalid UTF-8 sources instead of capturing replacement bytes", async () => {
    await isolateStorage();
    const workRoot = join(storageDir, "work");
    await mkdir(workRoot, { recursive: true });
    await writeFile(join(workRoot, "terraform.tfstate"), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    let threw = false;
    try {
      await captureInterruptedApplyState(storageDir, "run-bin", workRoot);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    let copyExists = true;
    try {
      await readdir(join(storageDir, "recovery", "run-bin"));
    } catch {
      copyExists = false;
    }
    expect(copyExists).toBe(false);
  });

  it("a failed retry keeps the previous complete copy readable", async () => {
    await isolateStorage();
    const workRoot = join(storageDir, "work");
    await mkdir(workRoot, { recursive: true });
    await writeFile(join(workRoot, "terraform.tfstate"), STATE_JSON);
    expect(await captureInterruptedApplyState(storageDir, "run-retry", workRoot)).toBe(true);
    // Second capture sees new bytes it cannot preserve: it must throw and
    // leave the previous complete copy (state + marker) untouched.
    await writeFile(join(workRoot, "terraform.tfstate"), Buffer.from([0xff, 0xfe]));
    let threw = false;
    try {
      await captureInterruptedApplyState(storageDir, "run-retry", workRoot);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const stored = await readFile(recoveryStatePathFor(storageDir, "run-retry"), "utf8");
    expect(decodeStatePayload(stored)).toBe(STATE_JSON);
    expect(await readFile(recoveryMarkerPathFor(storageDir, "run-retry"), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns false and writes nothing when no state file exists", async () => {
    await isolateStorage();
    const workRoot = join(storageDir, "work");
    await mkdir(workRoot, { recursive: true });
    await writeFile(join(workRoot, "other.txt"), "nothing stateful here");
    expect(await captureInterruptedApplyState(storageDir, "run-2", workRoot)).toBe(false);
    let recoveryRootExists = true;
    try {
      await readdir(join(storageDir, "recovery"));
    } catch {
      recoveryRootExists = false;
    }
    expect(recoveryRootExists).toBe(false);
  });

  it("throws and leaves no partial behind when the work root is unusable", async () => {
    await isolateStorage();
    const notADir = join(storageDir, "file-not-dir");
    await writeFile(notADir, "not a directory");
    let threw = false;
    try {
      await captureInterruptedApplyState(storageDir, "run-3", notADir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    let partialExists = true;
    try {
      await readdir(join(storageDir, "recovery", "run-3"));
    } catch {
      partialExists = false;
    }
    expect(partialExists).toBe(false);
  });
});

describe("sweepIncompleteRecoveryCopies (#579)", () => {
  it("adopts a complete-but-unmarked copy and drops partials and staging temps", async () => {
    await isolateStorage();
    // Complete copy: capture, then remove the marker to simulate a crash in
    // the rename-to-marker window.
    const workRoot = join(storageDir, "work");
    await mkdir(workRoot, { recursive: true });
    await writeFile(join(workRoot, "terraform.tfstate"), STATE_JSON);
    expect(await captureInterruptedApplyState(storageDir, "run-adopt", workRoot)).toBe(true);
    await rm(recoveryMarkerPathFor(storageDir, "run-adopt"), { force: true });
    // Unverifiable partial: garbage bytes, no marker.
    const partialDir = join(storageDir, "recovery", "run-partial");
    await mkdir(partialDir, { recursive: true });
    await writeFile(join(partialDir, "terraform.tfstate"), "truncated-ciphertext");
    // Staging leftover inside an otherwise complete copy.
    const stagedDir = join(storageDir, "recovery", "run-staged");
    await mkdir(stagedDir, { recursive: true });
    await writeFile(join(stagedDir, ".staging-terraform.tfstate-1-deadbeef"), "orphan");
    await writeFileDurable(stagedDir, "terraform.tfstate", "x", 0o600);
    await writeFileDurable(stagedDir, ".recovered", new Date().toISOString(), 0o600);

    const result = await sweepIncompleteRecoveryCopies(storageDir);
    expect(result).toEqual({ removedStaging: 1, adoptedComplete: 1, removedPartial: 1 });

    // Adopted copy reads back intact with its marker restored.
    const adopted = await readFile(recoveryStatePathFor(storageDir, "run-adopt"), "utf8");
    expect(decodeStatePayload(adopted)).toBe(STATE_JSON);
    expect(await readFile(recoveryMarkerPathFor(storageDir, "run-adopt"), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Partial is gone; staged copy kept its marker and lost the temp.
    let partialExists = true;
    try {
      await readdir(join(storageDir, "recovery", "run-partial"));
    } catch {
      partialExists = false;
    }
    expect(partialExists).toBe(false);
    expect(await readdir(stagedDir)).toEqual([".recovered", "terraform.tfstate"]);
  });

  it("is a no-op without a recovery root", async () => {
    await isolateStorage();
    expect(await sweepIncompleteRecoveryCopies(storageDir)).toEqual({
      removedStaging: 0,
      adoptedComplete: 0,
      removedPartial: 0,
    });
  });

  it("leaves chmod bits alone on adopted markers", async () => {
    await isolateStorage();
    const workRoot = join(storageDir, "work");
    await mkdir(workRoot, { recursive: true });
    await writeFile(join(workRoot, "terraform.tfstate"), STATE_JSON);
    await captureInterruptedApplyState(storageDir, "run-m", workRoot);
    await chmod(recoveryMarkerPathFor(storageDir, "run-m"), 0o600);
    await sweepIncompleteRecoveryCopies(storageDir);
    expect((await stat(recoveryMarkerPathFor(storageDir, "run-m"))).mode & 0o777).toBe(0o600);
  });
});
