import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The named local profiles supported by the operational test runner. */
export const operationalTestProfileNames = [
  "unit-api",
  "sqlite-cli",
  "postgres-cli",
  "sandbox",
  "browser",
] as const;

export type OperationalTestProfileName = (typeof operationalTestProfileNames)[number];
export type OperationalTestExecutionMode = "simulated" | "real-cli" | "browser";
export type OperationalTestDatabase = "none" | "sqlite" | "postgres";
export type OperationalTestSandbox = "none" | "disabled" | "required";

export type OperationalTestProfile = Readonly<{
  name: OperationalTestProfileName;
  description: string;
  mode: OperationalTestExecutionMode;
  database: OperationalTestDatabase;
  sandbox: OperationalTestSandbox;
  command: readonly string[];
  cwd: "repo" | "backend";
}>;

/**
 * Keep this list deliberately small. Each profile is a named contract that
 * can be printed in a failure artifact and rerun from a fresh checkout.
 */
export const operationalTestProfiles: Readonly<Record<OperationalTestProfileName, OperationalTestProfile>> = {
  "unit-api": {
    name: "unit-api",
    description: "Fast backend unit/API coverage with explicitly simulated runs",
    mode: "simulated",
    database: "sqlite",
    sandbox: "disabled",
    command: [
      "bun",
      "test",
      "--max-concurrency=1",
      "--no-orphans",
      "tests/unit",
      "tests/api/e2e_full_flow.test.ts",
      "tests/api/oauth-login-flow.test.ts",
    ],
    cwd: "backend",
  },
  "sqlite-cli": {
    name: "sqlite-cli",
    description: "Pinned Terraform/OpenTofu provider lifecycle against an isolated SQLite backend",
    mode: "real-cli",
    database: "sqlite",
    sandbox: "disabled",
    command: ["bun", "test", "--bail=5", "--max-concurrency=1", "--no-orphans", "backend/tests/e2e/provider_e2e.test.ts"],
    cwd: "repo",
  },
  "postgres-cli": {
    name: "postgres-cli",
    description: "Pinned Terraform/OpenTofu provider lifecycle against an isolated PostgreSQL database",
    mode: "real-cli",
    database: "postgres",
    sandbox: "disabled",
    command: ["bun", "test", "--bail=5", "--max-concurrency=1", "--no-orphans", "backend/tests/e2e/provider_e2e.test.ts"],
    cwd: "repo",
  },
  sandbox: {
    name: "sandbox",
    description: "Pinned Terraform provider lifecycle with the production-required Landlock sandbox",
    mode: "real-cli",
    database: "sqlite",
    sandbox: "required",
    command: ["bun", "test", "--bail=5", "--max-concurrency=1", "--no-orphans", "backend/tests/e2e/provider_e2e.test.ts"],
    cwd: "repo",
  },
  browser: {
    name: "browser",
    description: "Frontend browser and accessibility journeys with an ephemeral WebView server",
    mode: "browser",
    database: "none",
    sandbox: "none",
    command: ["bun", "run", "--cwd", "frontend", "test:browser"],
    cwd: "repo",
  },
};

export const DEFAULT_OPERATIONAL_TEST_SEED = "eng21";

/** Parse a profile name without allowing an arbitrary command to masquerade as a profile. */
export function parseOperationalTestProfile(value: string): OperationalTestProfile {
  const profile = operationalTestProfiles[value as OperationalTestProfileName];
  if (profile === undefined) {
    throw new Error(`Unknown operational test profile "${value}". Choose one of: ${operationalTestProfileNames.join(", ")}`);
  }
  return profile;
}

/**
 * Fixture seeds are deliberately boring identifiers. They are written into
 * resource names, so accepting arbitrary shell or URL text would make a
 * reproduction less deterministic and could leak an operator's input.
 */
export function normalizeOperationalTestSeed(value: string | undefined): string {
  const seed = (value ?? DEFAULT_OPERATIONAL_TEST_SEED).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(seed)) {
    throw new Error("Operational test seed must match [a-z0-9][a-z0-9_-]{0,31}");
  }
  return seed;
}

/** Stable fixture suffixes avoid UUID/time-derived names while staying short enough for API identifiers. */
export function operationalFixtureSuffix(seed: string, component?: string): string {
  const normalized = normalizeOperationalTestSeed(seed);
  const suffix = component === undefined ? normalized : `${normalized}-${component}`;
  // tfe_project names allow 40 characters including the pe2e-proj- prefix.
  if (suffix.length <= 30) return suffix;
  const digest = createHash("sha256").update(suffix).digest("hex").slice(0, 10);
  return `${suffix.slice(0, 19)}-${digest}`;
}

/** Create a unique directory below the supplied parent without touching normal instance storage. */
export function createOperationalTestDirectory(prefix: string, parent = tmpdir()): string {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

/** Ask the kernel for a free loopback port. Callers should bind immediately after this check. */
export async function freeOperationalTestPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error: Readonly<Error>): void => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("The operating system did not return an ephemeral test port"));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.port);
      });
    });
  });
}

/** Put a child in its own session on Linux so a failed test cannot orphan its CLI/plugin tree. */
export function managedCommand(command: readonly string[]): string[] {
  if (command.length === 0) throw new Error("Cannot spawn an empty command");
  return process.platform === "linux" && command[0] !== "setsid" ? ["setsid", ...command] : [...command];
}

type ManagedProcess = Pick<Bun.Subprocess, "exited" | "kill"> & Readonly<{ exitCode: number | null; pid?: number }>;

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Bun.Subprocess exposes a mutable process handle; this helper does not mutate its shape.
async function settled(process: Readonly<ManagedProcess>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    process.exited.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout((): void => { resolve(false); }, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Bun.Subprocess exposes a mutable process handle; this helper does not mutate its shape.
function signalManaged(child: Readonly<ManagedProcess>, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (globalThis.process.platform === "linux" && typeof pid === "number") {
    try {
      // Negative PIDs address the process group created by `setsid`.
      globalThis.process.kill(-pid, signal);
      return;
    } catch {
      // The group may already have exited. Fall back to the direct process.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A process that exited between the status check and signal is already reaped.
  }
}

/** Terminate a managed process and its descendants, then wait for the leader to be reaped. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Bun.Subprocess exposes a mutable process handle; this helper does not mutate its shape.
export async function terminateManagedProcess(child: Readonly<ManagedProcess>, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null) {
    // Bun can report a null exitCode for a just-reaped child. On Linux, only
    // signal a group that still exists; this avoids racing a reused PID after
    // a normally completed test command.
    if (globalThis.process.platform !== "linux" || child.pid === undefined) {
      await child.exited;
      return;
    }
    try {
      globalThis.process.kill(-child.pid, 0);
    } catch {
      await child.exited;
      return;
    }
  }
  signalManaged(child, "SIGTERM");
  if (!(await settled(child, graceMs))) {
    signalManaged(child, "SIGKILL");
    await child.exited;
  }
}

/** Redact common credential-shaped values before a diagnostic is persisted. */
export function redactOperationalDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s\r\n]+/gi, "$1[redacted]")
    .replace(/((?:password|token|secret|private[_-]?key|client[_-]?secret)\s*[=:]\s*["']?)[^\s"'&,}\r\n]+/gi, "$1[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^\s/@]+:)[^\s/@]+(@)/gi, "$1[redacted]$2");
}

/** Redact environment entries while preserving safe values useful for reruns. */
export function redactOperationalEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (/(?:PASSWORD|TOKEN|SECRET|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION)/i.test(name)) {
      redacted[name] = "[redacted]";
    } else {
      redacted[name] = redactOperationalDiagnostic(value);
    }
  }
  return redacted;
}
