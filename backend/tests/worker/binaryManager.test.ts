import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

test("downloads a verified binary once and reuses the cached copy", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-binary-"));

  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", `
      const { mkdir, readFile, stat, writeFile } = await import("fs/promises");
      const { join } = await import("path");

      const fixtureDir = join(process.env.TEST_DIR, "fixture");
      const fixturePath = join(fixtureDir, "tofu");
      const archivePath = join(process.env.TEST_DIR, "fixture.zip");
      await mkdir(fixtureDir);
      await writeFile(fixturePath, "#!/bin/sh\\nexit 99\\n");

      const zip = Bun.spawn(["zip", "-j", archivePath, fixturePath], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if (await zip.exited !== 0) throw new Error(await new Response(zip.stderr).text());

      const archive = await readFile(archivePath);
      const hash = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
      const arch = process.arch === "arm64" ? "arm64" : "amd64";
      const os = process.platform === "darwin" ? "darwin" : "linux";
      const filename = "tofu_1.2.3_" + os + "_" + arch + ".zip";
      const requests = [];

      globalThis.fetch = async input => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        requests.push(url);
        return url.endsWith("_SHA256SUMS")
          ? new Response(hash + "  " + filename + "\\n")
          : new Response(archive);
      };

      const { ensureBinary } = await import("./src/binaryManager.ts");
      const first = await ensureBinary("tofu", "1.2.3");
      const second = await ensureBinary("tofu", "1.2.3");
      const installed = await readFile(first.binaryPath, "utf8");
      const executable = (await stat(first.binaryPath)).mode & 0o111;

      console.log(JSON.stringify({ first, second, requests, installed, executable }));
    `], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        TEST_DIR: testDir,
        STORAGE_DIR: join(testDir, "storage"),
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
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);

    expect(result.first).toEqual(result.second);
    expect(result.first).toMatchObject({ tool: "tofu", version: "1.2.3" });
    expect(result.requests).toHaveLength(2);
    expect(result.requests.filter((url: string) => url.endsWith(".zip"))).toHaveLength(1);
    expect(result.installed).toBe("#!/bin/sh\nexit 99\n");
    expect(result.executable).not.toBe(0);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("does not silently substitute the system binary for an exact version", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-binary-exact-"));

  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", `
      const { chmod, mkdir, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const binDir = join(process.env.TEST_DIR, "bin");
      const binary = join(binDir, "terraform");
      await mkdir(binDir);
      await writeFile(binary, "#!/bin/sh\\nexit 0\\n");
      await writeFile(join(binDir, "which"), "#!/bin/sh\\necho " + JSON.stringify(binary) + "\\n");
      await chmod(binary, 0o755);
      await chmod(join(binDir, "which"), 0o755);
      process.env.PATH = binDir;
      globalThis.fetch = async () => new Response("", { status: 404 });

      const { ensureBinary } = await import("./src/binaryManager.ts");
      console.log(JSON.stringify({ result: await ensureBinary("terraform", "9.9.9") }));
    `], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        TEST_DIR: testDir,
        STORAGE_DIR: join(testDir, "storage"),
        ALLOW_TOOL_FALLBACK: "false",
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
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ result: null });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
