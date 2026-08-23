import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { probeLandlockAbi } from "../../src/lib/sandbox";

// The sandboxed fake-tofu tests exercise real execution; on hosts without
// Landlock, explicitly opt out so the suite still runs (production fail-closed
// behaviour is covered by the sandbox + meta tests).
const TEST_RUN_SANDBOX = probeLandlockAbi() >= 1 ? "true" : "false";

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
        // These scripts fabricate a fake tofu under their own storage dir,
        // so pin the binary cache back to the per-test dir (setup.ts points
        // it at the shared disk cache by default).
        TERRENCE_BINARY_CACHE_DIR: join(testDir, "storage", "binaries"),
        // Let the sandboxed fake-tofu write its record files.
        TERRENCE_SANDBOX_EXTRA_RW_PATHS: join(testDir, "record"),
        TERRENCE_SANDBOX_EXTRA_RW_ALLOWED: "true",
        TERRENCE_RUN_SANDBOX: TEST_RUN_SANDBOX,
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
      projects,
      runs,
      stateVersions,
      variableSets,
      variableSetProjects,
      variableSetVariables,
      variableSetWorkspaces,
      workspaces,
      workspaceVariables,
    } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");
    const { readPlanJsonArtifact } = await import("./src/lib/plan-json.ts");
    const { decodeStatePayload } = await import("./src/lib/validation.ts");

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
    await writeFile(join(recordDir, "plan.json"), JSON.stringify({
      format_version: "1.2",
      terraform_version: "1.2.3",
      resource_changes: [{
        address: "test_resource.example",
        mode: "managed",
        change: { actions: ["no-op"], importing: { id: "existing-1" } },
      }, {
        address: "test_resource.updated_import",
        mode: "managed",
        change: { actions: ["update"], importing: { id: "existing-2" } },
      }, {
        address: "test_resource.created",
        mode: "managed",
        change: { actions: ["create"] },
      }, {
        address: "test_resource.replaced",
        mode: "managed",
        change: { actions: ["delete", "create"] },
      }, {
        address: "test_resource.deleted",
        mode: "managed",
        change: { actions: ["delete"] },
      }, {
        address: "data.test_resource.read",
        mode: "data",
        change: { actions: ["read"] },
      }],
    }));
    await writeFile(binaryPath, [
      "#!/bin/sh",
      "record_dir=" + JSON.stringify(recordDir),
      "case \\"$1\\" in",
      '  init) echo "$@" > "$record_dir/init-args"; cp terrence_backend_override.tf "$record_dir/backend-override" ;;',
      '  plan) printf "plan-first\\n"; touch "$record_dir/wait-sentinel"; while [ -f "$record_dir/wait-sentinel" ]; do sleep 0.01; done; printf "plan-second\\n"; printf "Plan: 9 to import, 9 to add, 9 to change, 9 to destroy.\\n"; echo "$@" > "$record_dir/plan-args"; echo "$PROVIDER_TOKEN" > "$record_dir/provider-token"; echo "$TF_LOG" > "$record_dir/plan-tf-log"; cp terraform.tfstate "$record_dir/planned-state"; cp terrence.workspace.tfvars "$record_dir/terrence.workspace.tfvars"; cp z.auto.tfvars "$record_dir/uploaded.auto.tfvars"; : > tfplan ;;',
      '  show) cat "$record_dir/plan.json" ;;',
      '  apply) printf "Apply complete! Resources: 2 imported, 3 added, 4 changed, 5 destroyed.\\n"; echo "$PROVIDER_TOKEN" > "$record_dir/apply-provider-token"; echo "$TF_LOG" > "$record_dir/apply-tf-log"; cp "$record_dir/applied-state" terraform.tfstate ;;',
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
    await db.insert(projects).values({ id: "project", orgId: "org", name: "project" });
    await db.insert(workspaces).values({
      id: "workspace",
      name: "workspace",
      orgId: "org",
      projectId: "project",
      iacBinary: "tofu",
      terraformVersion: "9.9.9",
      autoApply: false,
    });
    await db.insert(stateVersions).values([
      {
        id: "state",
        workspaceId: "workspace",
        serial: 7,
        statePayload: JSON.stringify({ version: 4, serial: 7, lineage: "lineage", resources: [] }),
      },
      {
        id: "pending-state",
        workspaceId: "workspace",
        serial: 8,
        status: "pending",
        statePayload: JSON.stringify({ version: 4, serial: 8, lineage: "pending", resources: [] }),
      },
      {
        id: "intermediate-state",
        workspaceId: "workspace",
        serial: 9,
        intermediate: true,
        statePayload: JSON.stringify({ version: 4, serial: 9, lineage: "intermediate", resources: [] }),
      },
      {
        id: "soft-deleted-state",
        workspaceId: "workspace",
        serial: 10,
        status: "backing_data_soft_deleted",
        statePayload: JSON.stringify({ version: 4, serial: 10, lineage: "soft-deleted", resources: [] }),
      },
    ]);
    await db.insert(workspaceVariables).values([
      { id: "plain-variable", workspaceId: "workspace", key: "plain", value: "hello" },
      { id: "hcl-variable", workspaceId: "workspace", key: "settings", value: "{ enabled = true }", hcl: true },
    ]);
    await db.insert(variableSets).values([
      { id: "global-set", orgId: "org", name: "global", global: true },
      { id: "attached-set", orgId: "org", name: "attached" },
      { id: "project-set", orgId: "org", name: "project" },
      { id: "priority-set", orgId: "org", name: "priority", priority: true },
    ]);
    await db.insert(variableSetWorkspaces).values({
      id: "attached-link",
      variableSetId: "attached-set",
      workspaceId: "workspace",
    });
    await db.insert(variableSetProjects).values([
      { id: "project-link", variableSetId: "project-set", projectId: "project" },
      { id: "priority-link", variableSetId: "priority-set", projectId: "project" },
    ]);
    await db.insert(variableSetVariables).values([
      { id: "global-plain", variableSetId: "global-set", key: "plain", value: "set-default" },
      { id: "global-only", variableSetId: "global-set", key: "global_only", value: "global" },
      { id: "global-env", variableSetId: "global-set", key: "PROVIDER_TOKEN", value: "from-set", category: "env" },
      { id: "attached-only", variableSetId: "attached-set", key: "attached_only", value: "attached" },
      { id: "project-only", variableSetId: "project-set", key: "project_only", value: "project" },
      { id: "priority-only", variableSetId: "priority-set", key: "priority_only", value: "set-priority" },
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
      variables: [
        { key: "plain", value: '"run"' },
        { key: "priority_only", value: '"run-priority"' },
      ],
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
    const persistedPlanJson = await readPlanJsonArtifact("run");
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
      planCounts: {
        additions: applied?.planResourceAdditions,
        changes: applied?.planResourceChanges,
        destructions: applied?.planResourceDestructions,
        imports: applied?.planResourceImports,
      },
      applyCounts: {
        additions: applied?.applyResourceAdditions,
        changes: applied?.applyResourceChanges,
        destructions: applied?.applyResourceDestructions,
        imports: applied?.applyResourceImports,
      },
      persistedPlanJson,
      stateSerials: recordedStates.map(state => state.serial),
      appliedState: JSON.parse(decodeStatePayload(recordedStates.at(-1)?.statePayload ?? "null")),
    }));
  `, { NODE_ENV: "production", SIMULATED_RUNS: "false" });

  expect(result).toMatchObject({
    seededSerial: 7,
    applied: "applied",
    streamedBeforeExit: true,
    planCounts: { additions: 2, changes: 1, destructions: 2, imports: 2 },
    applyCounts: { additions: 3, changes: 4, destructions: 5, imports: 2 },
  });
  expect(result.initArgs).toContain("-reconfigure");
  expect(result.planArgs).toContain("-refresh-only");
  expect(result.planArgs).toContain("-target=test_resource.target");
  expect(result.planArgs).toContain("-replace=test_resource.replace");
  expect(result.planArgs).toContain("-var-file=terrence.workspace.tfvars");
  expect(result.planArgs).toContain('-var=plain="run"');
  expect(result.planArgs).toContain('-var=priority_only="run-priority"');
  expect(result.planArgs).toContain('-var=priority_only="set-priority"');
  expect(result.planArgs.indexOf('-var=priority_only="run-priority"')).toBeLessThan(
    result.planArgs.indexOf('-var=priority_only="set-priority"'),
  );
  expect(result.backendOverride).toContain('backend "local"');
  expect(result.tfvars).toContain('plain = "hello"');
  expect(result.tfvars).toContain('global_only = "global"');
  expect(result.tfvars).toContain('attached_only = "attached"');
  expect(result.tfvars).toContain('project_only = "project"');
  expect(result.tfvars).toContain('priority_only = "set-priority"');
  expect(result.tfvars).toContain("settings = { enabled = true }");
  expect(result.uploadedTfvars).toBe('plain = "archive"');
  expect(result.providerToken).toBe("from-set");
  expect(result.applyProviderToken).toBe("from-set");
  expect(result.planTfLog).toBe("TRACE");
  expect(result.applyTfLog).toBe("TRACE");
  expect(result.stateSerials).toEqual([7, 8, 9, 10, 11]);
  expect(result.appliedState).toMatchObject({
    serial: 8,
    resources: [{ mode: "managed", type: "test_resource" }],
  });
  expect(result.persistedPlanJson).toMatchObject({
    format_version: "1.2",
  });
  expect(result.persistedPlanJson.resource_changes).toHaveLength(6);
  expect(result.persistedPlanJson.resource_changes[0]).toMatchObject({
    address: "test_resource.example",
    change: { actions: ["no-op"], importing: { id: "existing-1" } },
  });
}, 30_000);

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
    console.log(JSON.stringify({
      status: run?.status,
      planCounts: {
        additions: run?.planResourceAdditions,
        changes: run?.planResourceChanges,
        destructions: run?.planResourceDestructions,
        imports: run?.planResourceImports,
      },
    }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result).toEqual({
    status: "planned_and_finished",
    planCounts: { additions: 1, changes: 0, destructions: 0, imports: 0 },
  });
}, 30_000);

test("runs signed pre-plan and post-plan tasks around cost and policy stages", async () => {
  const result = await runWorkerScript(`\n    process.env.TERRENCE_ALLOW_PRIVATE_URLS = "true";
    const { createHmac } = await import("node:crypto");
    const { db } = await import("./src/db/index.ts");
    const {
      organizations,
      runs,
      runTaskResults,
      runTasks,
      workspaceRunTasks,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { app } = await import("./src/app.ts");
    const { executeRun } = await import("./src/worker.ts");

    const received = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.text();
        received.push({
          body,
          signature: request.headers.get("x-tfc-task-signature"),
        });
        const taskPayload = JSON.parse(body);
        const stage = taskPayload.stage;
        if (stage === "post_plan") {
          setTimeout(() => {
            void app.handle(new Request(taskPayload.task_result_callback_url, {
              method: "PATCH",
              headers: { "Content-Type": "application/vnd.api+json" },
              body: JSON.stringify({
                data: {
                  type: "task-results",
                  attributes: { status: "passed", message: "async " + stage },
                },
              }),
            }));
          }, 10);
          return new Response(null, { status: 202 });
        }
        return Response.json({ data: { attributes: { status: "passed", message: stage } } });
      },
    });
    const endpoint = server.url.toString().replace(/\\/$/, "");
    const hmacKey = "worker-task-secret";

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({
      id: "workspace",
      name: "workspace",
      orgId: "org",
      autoApply: true,
    });
    await db.insert(runTasks).values([
      { id: "pre-task", orgId: "org", name: "pre", url: endpoint + "/pre", hmacKey },
      { id: "post-task", orgId: "org", name: "post", url: endpoint + "/post", hmacKey },
    ]);
    await db.insert(workspaceRunTasks).values([
      { id: "pre-binding", workspaceId: "workspace", runTaskId: "pre-task", stage: "pre_plan", enforcementLevel: "mandatory" },
      { id: "post-binding", workspaceId: "workspace", runTaskId: "post-task", stage: "post_plan", enforcementLevel: "mandatory" },
    ]);
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      status: "pending",
      autoApply: true,
      statusTimestamps: { "pending-at": "2026-01-01T00:00:00.000Z" },
      createdAt: Date.now(),
    });

    await executeRun("run");
    server.stop(true);

    const completed = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    const taskResults = await db.query.runTaskResults.findMany({
      where: (row, { eq }) => eq(row.runId, "run"),
    });
    console.log(JSON.stringify({
      status: completed?.status,
      statusKeys: Object.keys(completed?.statusTimestamps ?? {}),
      tasks: received.map(({ body, signature }) => ({
        stage: JSON.parse(body).stage,
        hasCallback: new URL(JSON.parse(body).task_result_callback_url).pathname.endsWith("/callback"),
        signatureValid: signature === createHmac("sha512", hmacKey).update(body).digest("hex"),
      })),
      resultStatuses: taskResults.map(result => result.status).sort(),
    }));
    process.exit(0);
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true", RUN_TASK_TIMEOUT_MS: "1000" });

  expect(result.status).toBe("applied");
  expect(result.tasks).toEqual([
    { stage: "pre_plan", hasCallback: true, signatureValid: true },
    { stage: "post_plan", hasCallback: true, signatureValid: true },
  ]);
  expect(result.resultStatuses).toEqual(["passed", "passed"]);
  expect(result.statusKeys).toEqual([
    "pending-at",
    "fetching-at",
    "fetching-completed-at",
    "pre-plan-running-at",
    "pre-plan-completed-at",
    "queuing-at",
    "plan-queued-at",
    "planning-at",
    "planned-at",
    "input-state-serial",
    "cost-estimating-at",
    "cost-estimated-at",
    "policy-checking-at",
    "policy-checked-at",
    "post-plan-running-at",
    "post-plan-completed-at",
    "confirmed-at",
    "apply-queued-at",
    "applying-at",
    "applied-at",
  ]);
});

test("evaluates project policy sets after cost estimation and honors workspace exclusions", async () => {
  const result = await runWorkerScript(`
    const { chmod, mkdir, writeFile } = await import("fs/promises");
    const { join } = await import("path");
    const { db } = await import("./src/db/index.ts");
    const {
      organizations,
      policies,
      policyChecks,
      policySetExclusions,
      policySetProjects,
      policySets,
      projects,
      runs,
      stateVersions,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");

    const binDir = join(process.env.TEST_DIR, "bin");
    await mkdir(binDir);
    const opaPath = join(binDir, "opa");
    await writeFile(opaPath, [
      "#!/bin/sh",
      "printf '%s' '{\\"result\\":[{\\"expressions\\":[{\\"value\\":{\\"violations\\":[\\"blocked\\"]}}]}]}'",
    ].join("\\n"));
    await chmod(opaPath, 0o755);
    process.env.PATH = binDir + ":" + (process.env.PATH ?? "");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(projects).values({ id: "project", orgId: "org", name: "project" });
    await db.insert(workspaces).values({
      id: "workspace",
      name: "workspace",
      orgId: "org",
      projectId: "project",
    });
    await db.insert(policySets).values([
      { id: "project-set", orgId: "org", name: "project", kind: "opa" },
      { id: "excluded-global", orgId: "org", name: "excluded", kind: "sentinel", global: true },
    ]);
    await db.insert(policySetProjects).values({
      id: "project-link",
      policySetId: "project-set",
      projectId: "project",
    });
    await db.insert(policySetExclusions).values({
      id: "global-exclusion",
      policySetId: "excluded-global",
      workspaceId: "workspace",
    });
    await db.insert(policies).values([
      {
        id: "soft-policy",
        policySetId: "project-set",
        name: "soft",
        enforcementLevel: "soft-mandatory",
        query: "package terrence",
      },
      {
        id: "excluded-hard-policy",
        policySetId: "excluded-global",
        name: "excluded-hard",
        enforcementLevel: "hard-mandatory",
      },
    ]);
    await db.insert(stateVersions).values({
      id: "state",
      workspaceId: "workspace",
      serial: 1,
      statePayload: "{}",
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      status: "pending",
      createdAt: Date.now(),
    });

    await executeRun("run");
    const completed = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    const checks = await db.query.policyChecks.findMany({
      where: (row, { eq }) => eq(row.runId, "run"),
    });
    console.log(JSON.stringify({
      status: completed?.status,
      statusKeys: Object.keys(completed?.statusTimestamps ?? {}),
      checks: checks.map(check => ({ policyId: check.policyId, status: check.status })),
    }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result.status).toBe("policy_soft_failed");
  expect(result.checks).toEqual([{ policyId: "soft-policy", status: "soft_failed" }]);
  expect(result.statusKeys.indexOf("cost-estimated-at")).toBeLessThan(result.statusKeys.indexOf("policy-checking-at"));
  expect(result.statusKeys.slice(-2)).toEqual(["policy-override-at", "policy-soft-failed-at"]);
}, 30_000);

test("fails closed when plan JSON is unavailable instead of evaluating against state (kanban t_282cf10b)", async () => {
  const result = await runWorkerScript(`
    const { db } = await import("./src/db/index.ts");
    const {
      organizations,
      policies,
      policyChecks,
      policySetWorkspaces,
      policySets,
      runs,
      stateVersions,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { runPolicyChecks } = await import("./src/worker.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({ id: "workspace", name: "workspace", orgId: "org" });
    await db.insert(policySets).values({ id: "set", orgId: "org", name: "set", kind: "opa" });
    await db.insert(policySetWorkspaces).values({ id: "link", policySetId: "set", workspaceId: "workspace" });
    await db.insert(policies).values({
      id: "policy",
      policySetId: "set",
      name: "hard",
      enforcementLevel: "hard-mandatory",
      query: "package terrence",
    });
    // A finalized state version must NOT be used as the evaluation input.
    await db.insert(stateVersions).values({
      id: "state",
      workspaceId: "workspace",
      serial: 1,
      statePayload: "{\\"resources\\":[]}",
      status: "finalized",
      intermediate: false,
    });
    await db.insert(runs).values({ id: "run", workspaceId: "workspace", status: "pending", createdAt: Date.now() });

    const verdict = await runPolicyChecks("run", "workspace", "org");
    const checks = await db.query.policyChecks.findMany({ where: (row, { eq }) => eq(row.runId, "run") });
    console.log(JSON.stringify({
      verdict,
      checks: checks.map(check => ({ status: check.status, error: check.result?.error })),
    }));
  `, { NODE_ENV: "test" });

  expect(result.verdict).toEqual({ proceed: false, hardFailed: true, softFailed: false });
  expect(result.checks).toEqual([{ status: "errored", error: "Plan JSON is unavailable; policy evaluation failed closed" }]);
}, 30_000);

test("evaluates Sentinel policies and persists structured results", async () => {
  const result = await runWorkerScript(`
    const { chmod, mkdir, readFile, writeFile } = await import("fs/promises");
    const { join } = await import("path");
    const { db } = await import("./src/db/index.ts");
    const {
      organizations,
      policies,
      policyChecks,
      policySetParameters,
      policySets,
      runs,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");

    const binDir = join(process.env.TEST_DIR, "bin");
    await mkdir(binDir);
    const argsPath = join(process.env.TEST_DIR, "sentinel-args");
    const sentinelPath = join(binDir, "sentinel");
    await writeFile(sentinelPath, [
      "#!/bin/sh",
      "echo \\"$@\\" > " + JSON.stringify(argsPath),
      "printf '%s' '{\\"result\\":false,\\"duration\\":7,\\"trace\\":{\\"main\\":false}}'",
      "exit 1",
    ].join("\\n"));
    await chmod(sentinelPath, 0o755);
    process.env.SENTINEL_BINARY_PATH = sentinelPath;
    process.env.SIMULATED_PLAN_JSON = JSON.stringify({
      format_version: "1.2",
      resource_changes: [{ address: "terraform_data.example" }],
    });

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({ id: "workspace", name: "workspace", orgId: "org" });
    await db.insert(policySets).values({
      id: "sentinel-set",
      orgId: "org",
      name: "sentinel",
      kind: "sentinel",
      global: true,
    });
    await db.insert(policySetParameters).values({
      id: "parameter",
      policySetId: "sentinel-set",
      key: "environment",
      value: "production",
    });
    await db.insert(policies).values({
      id: "sentinel-policy",
      policySetId: "sentinel-set",
      name: "require-production",
      enforcementLevel: "hard-mandatory",
      query: "main = rule { false }",
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      status: "pending",
      createdAt: Date.now(),
    });

    await executeRun("run");
    const completed = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    const check = await db.query.policyChecks.findFirst({
      where: (row, { eq }) => eq(row.runId, "run"),
    });
    console.log(JSON.stringify({
      status: completed?.status,
      checkStatus: check?.status,
      result: check?.result,
      args: await readFile(argsPath, "utf8"),
    }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result.status).toBe("errored");
  expect(result.checkStatus).toBe("failed");
  expect(result.result).toMatchObject({
    result: false,
    passed: 0,
    "total-failed": 1,
    "hard-failed": 1,
    "duration-ms": 7,
    sentinel: { result: false, trace: { main: false } },
  });
  expect(result.args).toContain("-global tfplan=");
  expect(result.args).toContain('-param environment="production"');
}, 30_000);

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
}, 30_000);

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
      { id: "first", workspaceId: "queue-workspace", status: "pending", autoApply: true, createdAt: 1 },
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
}, 30_000);

test("scans past ineligible pending runs to reach newer eligible ones (kanban 1.5)", async () => {
  const result = await runWorkerScript(`
    const { db } = await import("./src/db/index.ts");
    const { organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { pollWorkerQueue } = await import("./src/worker.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    // 55 locked workspaces: SCAN_PAGE_SIZE is 50, so the eligible run lands
    // on the SECOND page. The pre-fix scan never looked past the first page.
    const lockedWorkspaces = Array.from({ length: 55 }, (_, i) => ({
      id: "locked-ws-" + i, name: "locked-" + i, orgId: "org", autoApply: true, locked: true,
    }));
    await db.insert(workspaces).values([
      ...lockedWorkspaces,
      { id: "eligible-ws", name: "eligible", orgId: "org", autoApply: true },
    ]);
    const lockedRuns = Array.from({ length: 55 }, (_, i) => ({
      id: "locked-run-" + i, workspaceId: "locked-ws-" + i, status: "pending", createdAt: i + 1,
    }));
    await db.insert(runs).values([
      ...lockedRuns,
      { id: "eligible-run", workspaceId: "eligible-ws", status: "pending", autoApply: true, createdAt: 100 },
    ]);

    const claimed = await pollWorkerQueue();
    // Generous budget: the simulated run applies inside the child process and
    // slow CI can exceed one second for the full child lifecycle.
    for (let attempt = 0; attempt < 500; attempt++) {
      const eligible = await db.query.runs.findFirst({ where: (run, { eq }) => eq(run.id, "eligible-run") });
      if (eligible?.status === "applied") break;
      await Bun.sleep(20);
    }
    const eligible = await db.query.runs.findFirst({ where: (run, { eq }) => eq(run.id, "eligible-run") });
    console.log(JSON.stringify({ claimed, eligibleStatus: eligible?.status }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result.claimed).toContain("eligible-run");
  expect(result.eligibleStatus).toBe("applied");
}, 30_000);
