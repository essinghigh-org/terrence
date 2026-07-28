import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runWorkerScript(script: string, env: Readonly<Record<string, string>> = {}): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-cost-estimate-"));
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
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
    if (exitCode !== 0) throw new Error(stderr === "" ? stdout : stderr);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

test("invokes Infracost with the persisted Terraform plan and stores its resource-level estimate", async () => {
  const result = await runWorkerScript(`
    const { chmod, mkdir, readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const testDir = process.env.TEST_DIR;
    const recordDir = join(testDir, "record");
    const terraformDir = join(process.env.STORAGE_DIR, "binaries", "tofu", "1.2.3");
    const terraformBinary = join(terraformDir, "tofu");
    const infracostBinary = join(testDir, "infracost");
    await mkdir(recordDir, { recursive: true });
    await mkdir(terraformDir, { recursive: true });

    const planJson = {
      format_version: "1.2",
      terraform_version: "1.2.3",
      planned_values: {
        root_module: {
          resources: [{ address: "aws_instance.web", mode: "managed", type: "aws_instance" }],
        },
      },
      resource_changes: [{
        address: "aws_instance.web",
        mode: "managed",
        type: "aws_instance",
        change: { actions: ["create"] },
      }],
    };
    const infracostOutput = {
      version: "0.2",
      currency: "USD",
      pastTotalMonthlyCost: "10.00",
      totalMonthlyCost: "25.50",
      diffTotalMonthlyCost: "15.50",
      summary: {
        totalDetectedResources: 2,
        totalSupportedResources: 1,
        totalUnsupportedResources: 1,
      },
      projects: [{
        name: "workspace",
        pastBreakdown: {
          resources: [{ name: "aws_instance.web", resourceType: "aws_instance", monthlyCost: "10.00" }],
        },
        breakdown: {
          resources: [{ name: "aws_instance.web", resourceType: "aws_instance", monthlyCost: "25.50" }],
        },
        diff: {
          resources: [{
            name: "aws_instance.web",
            resourceType: "aws_instance",
            monthlyCost: "15.50",
            action: "modify",
          }],
        },
      }],
    };
    await writeFile(join(recordDir, "plan.json"), JSON.stringify(planJson));
    await writeFile(join(recordDir, "infracost-output.json"), JSON.stringify(infracostOutput));
    await writeFile(terraformBinary, [
      "#!/bin/sh",
      "record_dir=" + JSON.stringify(recordDir),
      'case "$1" in',
      '  init) exit 0 ;;',
      '  plan) echo "Plan: 1 to add, 0 to change, 0 to destroy."; : > tfplan ;;',
      '  show) cat "$record_dir/plan.json" ;;',
      '  *) exit 2 ;;',
      "esac",
    ].join("\\n"));
    await writeFile(infracostBinary, [
      "#!/bin/sh",
      "record_dir=" + JSON.stringify(recordDir),
      'echo "$@" > "$record_dir/infracost-args"',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--path" ]; then cp "$2" "$record_dir/infracost-input.json"; shift 2; else shift; fi',
      "done",
      'cat "$record_dir/infracost-output.json"',
    ].join("\\n"));
    await Promise.all([chmod(terraformBinary, 0o755), chmod(infracostBinary, 0o755)]);
    process.env.INFRACOST_BINARY = infracostBinary;

    const configDir = join(testDir, "config");
    const archivePath = join(testDir, "config.tar.gz");
    await mkdir(configDir);
    await writeFile(join(configDir, "main.tf"), 'resource "aws_instance" "web" {}');
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
    if (await tar.exited !== 0) throw new Error("tar failed");

    const { db } = await import("./src/db/index.ts");
    const { configurationVersions, organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");
    const { readCostEstimateArtifact } = await import("./src/lib/cost-estimate.ts");
    const { readPlanJsonArtifact } = await import("./src/lib/plan-json.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({
      id: "workspace",
      name: "workspace",
      orgId: "org",
      iacBinary: "tofu",
      terraformVersion: "1.2.3",
    });
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
      planOnly: true,
      createdAt: Date.now(),
    });

    await executeRun("run");
    const completed = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    const persistedPlan = await readPlanJsonArtifact("run");
    const capturedPlan = JSON.parse(await readFile(join(recordDir, "infracost-input.json"), "utf8"));
    const estimate = await readCostEstimateArtifact("run");
    console.log(JSON.stringify({
      status: completed?.status,
      statusKeys: Object.keys(completed?.statusTimestamps ?? {}),
      args: (await readFile(join(recordDir, "infracost-args"), "utf8")).trim(),
      persistedPlan,
      capturedPlan,
      estimate,
    }));
  `, { NODE_ENV: "production", SIMULATED_RUNS: "false" });

  expect(result["status"]).toBe("planned_and_finished");
  expect(result["capturedPlan"]).toEqual(result["persistedPlan"]);
  expect(result["args"]).toContain("breakdown");
  expect(result["args"]).toContain("--format json");
  expect(result["statusKeys"]).toContain("cost-estimated-at");
  const estimate = result["estimate"] as Record<string, unknown>;
  expect(estimate["status"]).toBe("finished");
  expect(estimate["prior-monthly-cost"]).toBe("10.00");
  expect(estimate["proposed-monthly-cost"]).toBe("25.50");
  expect(estimate["delta-monthly-cost"]).toBe("15.50");
  expect(estimate["resources-count"]).toBe(2);
  expect(estimate["matched-resources-count"]).toBe(1);
  expect(estimate["unmatched-resources-count"]).toBe(1);
  const resources = estimate["resources"] as { projects: { diff: { resources: { action: string }[] } }[] };
  expect(resources.projects[0]?.diff.resources[0]?.action).toBe("modify");
});

test("records missing and failed Infracost tooling as errored estimates while runs continue", async () => {
  const result = await runWorkerScript(`
    const { chmod, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const testDir = process.env.TEST_DIR;
    process.env.SIMULATED_PLAN_JSON = JSON.stringify({
      format_version: "1.2",
      planned_values: { root_module: { resources: [] } },
      resource_changes: [],
    });

    const { db } = await import("./src/db/index.ts");
    const { organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");
    const { readCostEstimateArtifact } = await import("./src/lib/cost-estimate.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({ id: "workspace", name: "workspace", orgId: "org" });
    await db.insert(runs).values([
      { id: "missing", workspaceId: "workspace", status: "pending", planOnly: true, createdAt: Date.now() },
      { id: "failed", workspaceId: "workspace", status: "pending", planOnly: true, createdAt: Date.now() + 1 },
    ]);

    process.env.INFRACOST_BINARY = join(testDir, "does-not-exist");
    await executeRun("missing");

    const failingBinary = join(testDir, "failing-infracost");
    await writeFile(failingBinary, [
      "#!/bin/sh",
      'echo "pricing unavailable" >&2',
      "exit 23",
    ].join("\\n"));
    await chmod(failingBinary, 0o755);
    process.env.INFRACOST_BINARY = failingBinary;
    await executeRun("failed");

    const [missingRun, failedRun, missingEstimate, failedEstimate] = await Promise.all([
      db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "missing") }),
      db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "failed") }),
      readCostEstimateArtifact("missing"),
      readCostEstimateArtifact("failed"),
    ]);
    console.log(JSON.stringify({
      missingStatus: missingRun?.status,
      failedStatus: failedRun?.status,
      missingEstimate,
      failedEstimate,
    }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result["missingStatus"]).toBe("planned_and_finished");
  expect(result["failedStatus"]).toBe("planned_and_finished");
  const missingEstimate = result["missingEstimate"] as Record<string, unknown>;
  const failedEstimate = result["failedEstimate"] as Record<string, unknown>;
  expect(missingEstimate["status"]).toBe("errored");
  expect(String(missingEstimate["error-message"])).toContain("does-not-exist");
  expect(failedEstimate["status"]).toBe("errored");
  expect(failedEstimate["error-message"]).toBe("Infracost exited with code 23: pricing unavailable");
});
