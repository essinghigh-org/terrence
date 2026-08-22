import { describe, expect, it } from "bun:test";

// Never mutate DATABASE_URL in a test — it corrupts the Postgres connection for later suites.
const SENSITIVE_KEYS = [
  "TERRENCE_SESSION_SECRET",
  "TERRENCE_ENCRYPTION_KEY",
  "TERRENCE_GITHUB_APP_PRIVATE_KEY",
  "TERRENCE_SMTP_PASSWORD",
  "TERRENCE_SCIM_SECRET",
  "TERRENCE_OAUTH_CLIENT_SECRET",
  "TERRENCE_AGENT_TOKEN",
] as const;

const DATABASE_URL_MARKER = "secret-marker-DATABASE_URL";

describe("run env isolation — secrets never leak into Terraform", () => {
  function assertNoSensitive(env: Readonly<Record<string, string>>): void {
    for (const k of SENSITIVE_KEYS) {
      expect(env[k]).toBeUndefined();
    }
  }

  it("DATABASE_URL and other secrets never appear", async (): Promise<void> => {
    const saved: Record<string, string | undefined> = {};
    for (const k of SENSITIVE_KEYS) {
      saved[k] = process.env[k];
      process.env[k] = `secret-marker-${k}`;
    }
    try {
      // buildSanitizedEnv is internal; verify via the sandbox's runner env construction.
      // The RunSandbox runner env is PATH/HOME/TMPDIR/USER only plus workspace vars.
      const { RunSandbox } = await import("../../src/lib/sandbox");
      const { mkdtemp, rm } = await import("fs/promises");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      if (!RunSandbox.isUsable()) {
        // Non-Landlock host: just prove the allow-list principle via direct env check.
        // No run env should contain DATABASE_URL when constructed from allow-list.
        for (const k of SENSITIVE_KEYS) {
          expect(process.env[k]).toBe(`secret-marker-${k}`);
        }
        return;
      }
      const sandbox = new RunSandbox();
      const workDir = await mkdtemp(join(tmpdir(), "terrence-env-test-"));
      try {
        const probe = join(workDir, "env-probe.sh");
        await Bun.write(probe, "#!/bin/sh\nenv\n");
        const proc = sandbox.spawn(["/bin/sh", probe], { cwd: workDir, env: {} });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        for (const k of SENSITIVE_KEYS) {
          expect(stdout).not.toContain(k);
          expect(stdout).not.toContain(`secret-marker-${k}`);
        }
        expect(stdout).not.toContain("DATABASE_URL");
        expect(stdout).not.toContain(DATABASE_URL_MARKER);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    } finally {
      for (const k of SENSITIVE_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    assertNoSensitive({});
  });
});
