import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function runWorkerScript(script: string, env: Record<string, string> = {}) {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-worker-"));

  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        TEST_DIR: testDir,
        DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
        STORAGE_DIR: join(testDir, "storage"),
        ...env,
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
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

test("plans uploaded cloud configuration against the latest local state and records applied state", async () => {
  const result = await runWorkerScript(`
    const { chmod, mkdir, readFile, writeFile, exists, rm } = await import("fs/promises");
    const { join } = await import("path");
    const { db } = await import("./src/db/index.ts");
    const {
      configurationVersions,
      organizations,
      runs,
      stateVersions,
      variableSets,
      variableSetVariables,
      variableSetWorkspaces,
      workspaces,
      workspaceVariables,
    } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");

    const testDir = process.env.TEST_DIR;
    const recordDir = join(testDir, "record");
    const binaryDir = join(process.env.STORAGE_DIR, "binaries", "tofu", "1.2.3");
    const binaryPath = join(binaryDir, "tofu");
    await mkdir(recordDir, { recursive: true });
    await mkdir(binaryDir, { recursive: true });
    await writeFile(join(recordDir, "applied-state"), JSON.stringify({
      version: 4,
      serial: 8,
      lineage: "lineage",
      resources: [{ mode: "managed", type: "test_resource" }],
    }));
    await writeFile(binaryPath, [
      "#!/bin/sh",
      "record_dir=" + JSON.stringify(recordDir),
      "case \\"$1\\" in",
      '  init) echo "$@" > "$record_dir/init-args"; cp terrence_backend_override.tf "$record_dir/backend-override" ;;',
      '  plan) printf "plan-first\\n"; touch "$record_dir/wait-sentinel"; while [ -f "$record_dir/wait-sentinel" ]; do sleep 0.01; done; printf "plan-second\\n"; echo "$@" > "$record_dir/plan-args"; echo "$PROVIDER_TOKEN" > "$record_dir/provider-token"; echo "$TF_LOG" > "$record_dir/plan-tf-log"; cp terraform.tfstate "$record_dir/planned-state"; cp terrence.workspace.tfvars "$record_dir/terrence.workspace.tfvars"; cp z.auto.tfvars "$record_dir/uploaded.auto.tfvars"; : > tfplan ;;',
      '  apply) echo "$PROVIDER_TOKEN" > "$record_dir/apply-provider-token"; echo "$TF_LOG" > "$record_dir/apply-tf-log"; cp "$record_dir/applied-state" terraform.tfstate ;;',
      "  *) exit 2 ;;",
      "esac",
    ].join("\\n"));
    await chmod(binaryPath, 0o755);

    const configDir = join(testDir, "config");
    const archivePath = join(testDir, "config.tar.gz");
    await mkdir(configDir);
    await writeFile(join(configDir, "main.tf"), 'terraform { cloud { organization = "example" workspaces { name = "example" } } }');
    await writeFile(join(configDir, "z.auto.tfvars"), 'plain = "archive"');
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
    if (await tar.exited !== 0) throw new Error("tar failed");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({
      id: "workspace",
      name: "workspace",
      orgId: "org",
      iacBinary: "tofu",
      terraformVersion: "9.9.9",
      autoApply: false,
    });
    await db.insert(stateVersions).values({
      id: "state",
      workspaceId: "workspace",
      serial: 7,
      statePayload: JSON.stringify({ version: 4, serial: 7, lineage: "lineage", resources: [] }),
    });
    await db.insert(workspaceVariables).values([
      { id: "plain-variable", workspaceId: "workspace", key: "plain", value: "hello" },
      { id: "hcl-variable", workspaceId: "workspace", key: "settings", value: "{ enabled = true }", hcl: true },
    ]);
    await db.insert(variableSets).values([
      { id: "global-set", orgId: "org", name: "global", global: true },
      { id: "attached-set", orgId: "org", name: "attached" },
    ]);
    await db.insert(variableSetWorkspaces).values({
      id: "attached-link",
      variableSetId: "attached-set",
      workspaceId: "workspace",
    });
    await db.insert(variableSetVariables).values([
      { id: "global-plain", variableSetId: "global-set", key: "plain", value: "set-default" },
      { id: "global-only", variableSetId: "global-set", key: "global_only", value: "global" },
      { id: "global-env", variableSetId: "global-set", key: "PROVIDER_TOKEN", value: "from-set", category: "env" },
      { id: "attached-only", variableSetId: "attached-set", key: "attached_only", value: "attached" },
    ]);
    await db.insert(configurationVersions).values({
      id: "configuration",
      workspaceId: "workspace",
      status: "uploaded",
      archivePath,
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      configurationVersionId: "configuration",
      status: "pending",
      autoApply: true,
      refreshOnly: true,
      targetAddrs: ["test_resource.target"],
      replaceAddrs: ["test_resource.replace"],
      variables: [{ key: "plain", value: '"run"' }],
      terraformVersion: "1.2.3",
      debuggingMode: true,
      createdAt: Date.now(),
    });

    const execution = executeRun("run");
    let streamedBeforeExit = false;
    const sentinelPath = join(recordDir, "wait-sentinel");
    for (let attempt = 0; attempt < 100; attempt++) {
      const planLogs = await db.query.logs.findMany({
        where: (log, { and, eq }) => and(eq(log.runId, "run"), eq(log.phase, "plan")),
      });
      if (planLogs.some(log => log.outputText.includes("plan-first")) || (await exists(sentinelPath))) {
        const active = await db.query.runs.findFirst({ where: (run, { eq }) => eq(run.id, "run") });
        streamedBeforeExit = active?.status === "planning";
        await rm(sentinelPath, { force: true });
        break;
      }
      await Bun.sleep(10);
    }
    await execution;
    const initArgs = await readFile(join(recordDir, "init-args"), "utf8");
    const planArgs = await readFile(join(recordDir, "plan-args"), "utf8");
    const backendOverride = await readFile(join(recordDir, "backend-override"), "utf8");
    const seededState = JSON.parse(await readFile(join(recordDir, "planned-state"), "utf8"));
    const tfvars = await readFile(join(recordDir, "terrence.workspace.tfvars"), "utf8");
    const uploadedTfvars = await readFile(join(recordDir, "uploaded.auto.tfvars"), "utf8");
    const providerToken = (await readFile(join(recordDir, "provider-token"), "utf8")).trim();
    const applyProviderToken = (await readFile(join(recordDir, "apply-provider-token"), "utf8")).trim();
    const planTfLog = (await readFile(join(recordDir, "plan-tf-log"), "utf8")).trim();
    const applyTfLog = (await readFile(join(recordDir, "apply-tf-log"), "utf8")).trim();
    const applied = await db.query.runs.findFirst({ where: (run, { eq }) => eq(run.id, "run") });
    const recordedStates = await db.query.stateVersions.findMany({
      where: (state, { eq }) => eq(state.workspaceId, "workspace"),
      orderBy: (state, { asc }) => [asc(state.serial)],
    });
    console.log(JSON.stringify({
      initArgs,
      planArgs,
      backendOverride,
      seededSerial: seededState.serial,
      tfvars,
      uploadedTfvars,
      providerToken,
      applyProviderToken,
      planTfLog,
      applyTfLog,
      streamedBeforeExit,
      applied: applied?.status,
      stateSerials: recordedStates.map(state => state.serial),
      appliedState: JSON.parse(recordedStates.at(-1)?.statePayload ?? "null"),
    }));
  `, { NODE_ENV: "production", SIMULATED_RUNS: "false" });

  expect(result).toMatchObject({
    seededSerial: 7,
    applied: "applied",
    streamedBeforeExit: true,
  });
  expect(result.initArgs).toContain("-reconfigure");
  expect(result.planArgs).toContain("-refresh-only");
  expect(result.planArgs).toContain("-target=test_resource.target");
  expect(result.planArgs).toContain("-replace=test_resource.replace");
  expect(result.planArgs).toContain("-var-file=terrence.workspace.tfvars");
  expect(result.planArgs).toContain('-var=plain="run"');
  expect(result.backendOverride).toContain('backend "local"');
  expect(result.tfvars).toContain('plain = "hello"');
  expect(result.tfvars).toContain('global_only = "global"');
  expect(result.tfvars).toContain('attached_only = "attached"');
  expect(result.tfvars).toContain("settings = { enabled = true }");
  expect(result.uploadedTfvars).toBe('plain = "archive"');
  expect(result.providerToken).toBe("from-set");
  expect(result.applyProviderToken).toBe("from-set");
  expect(result.planTfLog).toBe("TRACE");
  expect(result.applyTfLog).toBe("TRACE");
  expect(result.stateSerials).toEqual([7, 8]);
  expect(result.appliedState).toMatchObject({
    serial: 8,
    resources: [{ mode: "managed", type: "test_resource" }],
  });
});

test("finishes plan-only runs without applying even when the workspace auto-applies", async () => {
  const result = await runWorkerScript(`
    const { db } = await import("./src/db/index.ts");
    const { organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({
      id: "workspace",
      name: "workspace",
      orgId: "org",
      autoApply: true,
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      status: "pending",
      planOnly: true,
      createdAt: Date.now(),
    });

    await executeRun("run");
    const run = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    console.log(JSON.stringify({ status: run?.status }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result).toEqual({ status: "planned_and_finished" });
});

test("rejects configuration archives containing traversal paths or links", async () => {
  const result = await runWorkerScript(`
    const { mkdir, rm, writeFile, readFile, exists, symlink } = await import("fs/promises");
    const { join } = await import("path");
    const { db } = await import("./src/db/index.ts");
    const { configurationVersions, logs, organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");

    const testDir = process.env.TEST_DIR;
    const sourceDir = join(testDir, "archive-source");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "safe.txt"), "safe");
    await symlink("safe.txt", join(sourceDir, "link.txt"));

    const traversalArchive = join(testDir, "traversal.tar.gz");
    let traversalTar = Bun.spawn([
      "tar", "-czf", traversalArchive, "--transform=s|safe.txt|../escaped.txt|", "-C", sourceDir, "safe.txt",
    ], { stderr: "ignore" });
    if (await traversalTar.exited !== 0) {
      traversalTar = Bun.spawn([
        "tar", "-czf", traversalArchive, "-s", "|safe.txt|../escaped.txt|", "-C", sourceDir, "safe.txt",
      ], { stderr: "ignore" });
    }
    if (await traversalTar.exited !== 0) throw new Error("traversal tar failed");

    const linkArchive = join(testDir, "link.tar.gz");
    const linkTar = Bun.spawn(["tar", "-czf", linkArchive, "-C", sourceDir, "link.txt"]);
    if (await linkTar.exited !== 0) throw new Error("link tar failed");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values([
      { id: "traversal-workspace", name: "traversal", orgId: "org" },
      { id: "link-workspace", name: "link", orgId: "org" },
    ]);
    await db.insert(configurationVersions).values([
      { id: "traversal-cv", workspaceId: "traversal-workspace", status: "uploaded", archivePath: traversalArchive },
      { id: "link-cv", workspaceId: "link-workspace", status: "uploaded", archivePath: linkArchive },
    ]);
    await db.insert(runs).values([
      {
        id: "traversal-run",
        workspaceId: "traversal-workspace",
        configurationVersionId: "traversal-cv",
        status: "pending",
        createdAt: 1,
      },
      {
        id: "link-run",
        workspaceId: "link-workspace",
        configurationVersionId: "link-cv",
        status: "pending",
        createdAt: 2,
      },
    ]);

    await executeRun("traversal-run");
    await executeRun("link-run");
    const statuses = Object.fromEntries((await db.query.runs.findMany()).map(run => [run.id, run.status]));
    const errors = Object.fromEntries((await db.query.logs.findMany())
      .filter(log => log.outputText.includes("Configuration archive extraction failed"))
      .map(log => [log.runId, log.outputText]));
    console.log(JSON.stringify({ statuses, errors }));
  `, { NODE_ENV: "production", SIMULATED_RUNS: "false" });

  expect(result.statuses).toEqual({
    "traversal-run": "errored",
    "link-run": "errored",
  });
  expect(Object.keys(result.errors).sort()).toEqual(["link-run", "traversal-run"]);
});

test("queues one run per unlocked idle workspace without resolving a binary in simulated mode", async () => {
  const result = await runWorkerScript(`
    const { exists } = await import("fs/promises");
    const { join } = await import("path");
    const { db } = await import("./src/db/index.ts");
    const { organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { pollWorkerQueue } = await import("./src/worker.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values([
      { id: "queue-workspace", name: "queue", orgId: "org", autoApply: true },
      { id: "locked-workspace", name: "locked", orgId: "org", autoApply: true, locked: true },
      { id: "active-workspace", name: "active", orgId: "org", autoApply: true },
    ]);
    await db.insert(runs).values([
      { id: "first", workspaceId: "queue-workspace", status: "pending", createdAt: 1 },
      { id: "second", workspaceId: "queue-workspace", status: "pending", createdAt: 2 },
      { id: "locked", workspaceId: "locked-workspace", status: "pending", createdAt: 3 },
      { id: "active", workspaceId: "active-workspace", status: "planned", createdAt: 4 },
      { id: "blocked", workspaceId: "active-workspace", status: "pending", createdAt: 5 },
    ]);

    const claimed = await pollWorkerQueue();
    for (let attempt = 0; attempt < 100; attempt++) {
      const first = await db.query.runs.findFirst({ where: (run, { eq }) => eq(run.id, "first") });
      if (first?.status === "applied") break;
      await Bun.sleep(10);
    }

    const statuses = Object.fromEntries((await db.query.runs.findMany()).map(run => [run.id, run.status]));
    const binaryCacheCreated = await exists(join(process.env.STORAGE_DIR, "binaries"));
    console.log(JSON.stringify({ claimed, statuses, binaryCacheCreated }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result).toEqual({
    claimed: ["first"],
    statuses: {
      first: "applied",
      second: "pending",
      locked: "pending",
      active: "planned",
      blocked: "pending",
    },
    binaryCacheCreated: false,
  });
});
