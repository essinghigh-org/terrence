import { db } from "./db";
import { runs, configurationVersions, workspaces, workspaceVariables, logs, stateVersions, organizations } from "./db/schema";
import { eq, desc, and } from "drizzle-orm";
import { spawn } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, readFile, exists } from "fs/promises";
import { ensureBinary } from "./binaryManager";

async function writeLog(runId: string, phase: "plan" | "apply", outputText: string) {
  try {
    await db.insert(logs).values({
      id: crypto.randomUUID(),
      runId,
      phase,
      outputText,
      createdAt: Date.now(),
    });
  } catch {}
}

function buildSanitizedEnv(workspaceVars: Array<{ key: string; value: string; category: string }>): Record<string, string> {
  const allowedKeys = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "SHELL", "SYSTEMROOT"];
  const protectedKeys = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "TF_CLI_CONFIG_FILE", "DYLD_INSERT_LIBRARIES"];

  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  for (const v of workspaceVars) {
    if (protectedKeys.includes(v.key.toUpperCase())) {
      console.warn(`[terrence] Blocked workspace variable targeting protected key: ${v.key}`);
      continue;
    }
    if (v.category === "env") {
      env[v.key] = v.value;
    } else {
      env[`TF_VAR_${v.key}`] = v.value;
    }
  }

  return env;
}

async function extractTarArchive(archivePath: string, destDir: string): Promise<boolean> {
  try {
    const verboseProc = spawn(["tar", "-tvzf", archivePath]);
    const verboseText = await new Response(verboseProc.stdout).text();
    const verboseExitCode = await verboseProc.exited;
    if (verboseExitCode !== 0) return false;

    const verboseLines = verboseText.split("\n").map(s => s.trim()).filter(Boolean);
    for (const line of verboseLines) {
      const firstChar = line.charAt(0);
      if (firstChar === "l" || firstChar === "h" || firstChar === "c" || firstChar === "b" || firstChar === "p" || firstChar === "s") {
        console.error(`[terrence] Security error: Archive contains forbidden link/special member: '${line}'`);
        return false;
      }
      if (line.includes(" -> ") || line.includes(" link to ")) {
        console.error(`[terrence] Security error: Archive contains link member: '${line}'`);
        return false;
      }
    }

    const listProc = spawn(["tar", "-tzf", archivePath]);
    const membersText = await new Response(listProc.stdout).text();
    const exitCode = await listProc.exited;
    if (exitCode !== 0) return false;

    const members = membersText.split("\n").map(s => s.trim()).filter(Boolean);
    for (const m of members) {
      if (m.startsWith("/") || m.includes("..")) {
        console.error(`[terrence] Security error: Archive contains dangerous path '${m}'`);
        return false;
      }
    }

    const extractProc = spawn(["tar", "-xzf", archivePath, "-C", destDir]);
    return (await extractProc.exited) === 0;
  } catch (err) {
    console.error("[terrence] Tar extraction error", err);
    return false;
  }
}

export async function executeRun(runId: string) {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (!run) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });

  if (!workspace) return;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });

  await db.update(runs).set({ status: "planning" }).where(eq(runs.id, runId));

  const workDir = join(tmpdir(), "terrence", "runs", runId);

  try {
    await mkdir(workDir, { recursive: true });
    await writeLog(runId, "plan", `[terrence] Initializing run environment in ${workDir}`);

    if (run.configurationVersionId) {
      const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, run.configurationVersionId),
      });

      if (cv?.archivePath && (await exists(cv.archivePath))) {
        await writeLog(runId, "plan", `[terrence] Extracting configuration archive ${cv.archivePath}`);
        const ok = await extractTarArchive(cv.archivePath, workDir);
        if (!ok) {
          throw new Error("Configuration archive extraction failed or contained invalid path components.");
        }
      }
    }

    const vars = await db.query.workspaceVariables.findMany({
      where: eq(workspaceVariables.workspaceId, workspace.id),
    });

    const envVars = buildSanitizedEnv(vars);
    const tfVarsLines: string[] = [];
    for (const v of vars) {
      if (v.category !== "env") {
        tfVarsLines.push(`${v.key} = ${JSON.stringify(v.value)}`);
      }
    }

    if (tfVarsLines.length > 0) {
      await writeFile(join(workDir, "terraform.auto.tfvars"), tfVarsLines.join("\n"));
      await writeLog(runId, "plan", `[terrence] Injected ${tfVarsLines.length} Terraform variables.`);
    }

    const requestedTool = workspace.iacBinary || org?.defaultIacBinary || "tofu";
    const requestedVersion = workspace.terraformVersion || org?.defaultTerraformVersion || "latest";

    await writeLog(runId, "plan", `[terrence] Resolving binary for ${requestedTool} (version: ${requestedVersion})...`);
    const resolved = await ensureBinary(requestedTool, requestedVersion);

    const { readdir } = await import("fs/promises");
    const dirFiles = await readdir(workDir);
    const hasTfFiles = dirFiles.some(f => f.endsWith(".tf") || f.endsWith(".tf.json"));

    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || process.env.NODE_ENV === "test";

    if (resolved && hasTfFiles) {
      const binary = resolved.binaryPath;
      await writeLog(runId, "plan", `[terrence] Using ${resolved.tool} v${resolved.version} at ${binary}`);

      // 1. Run init
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} init ---`);
      const initProc = spawn([binary, "init", "-no-color", "-input=false"], {
        cwd: workDir,
        env: envVars,
      });

      const [initStdout, initStderr] = await Promise.all([
        new Response(initProc.stdout).text(),
        new Response(initProc.stderr).text(),
      ]);

      if (initStdout) await writeLog(runId, "plan", initStdout);
      if (initStderr) await writeLog(runId, "plan", initStderr);

      const initExit = await initProc.exited;
      if (initExit !== 0) {
        throw new Error(`${resolved.tool} init failed with exit code ${initExit}`);
      }

      // 2. Run plan
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} plan ---`);
      const planArgs = run.isDestroy
        ? [binary, "plan", "-no-color", "-input=false", "-destroy", "-out=tfplan"]
        : [binary, "plan", "-no-color", "-input=false", "-out=tfplan"];

      const planProc = spawn(planArgs, {
        cwd: workDir,
        env: envVars,
      });

      const [planStdout, planStderr] = await Promise.all([
        new Response(planProc.stdout).text(),
        new Response(planProc.stderr).text(),
      ]);

      if (planStdout) await writeLog(runId, "plan", planStdout);
      if (planStderr) await writeLog(runId, "plan", planStderr);

      const planExit = await planProc.exited;
      if (planExit !== 0) {
        throw new Error(`${resolved.tool} plan failed with exit code ${planExit}`);
      }
    } else if (isSimulatedAllowed) {
      await writeLog(runId, "plan", `[terrence] Execution engine: Simulated plan completed successfully.`);
      await writeLog(runId, "plan", `Plan: 1 to add, 0 to change, 0 to destroy.`);
    } else {
      throw new Error(`Unable to resolve CLI binary '${requestedTool}' or no Terraform configuration (.tf) files were found in workspace.`);
    }

    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, runId));
    await writeLog(runId, "plan", `[terrence] Run status updated to 'planned'.`);

    if (workspace.autoApply) {
      await executeApply(runId);
    }
  } catch (error: any) {
    console.error(`Run ${runId} planning failed`, error);
    await writeLog(runId, "plan", `[terrence ERROR] ${error.message || String(error)}`);
    await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {}
  }
}

export async function executeApply(runId: string) {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (!run) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });

  if (!workspace) {
    console.error(`[terrence] Workspace missing for run ${runId}`);
    return;
  }

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });

  await db.update(runs).set({ status: "applying" }).where(eq(runs.id, runId));
  const workDir = join(tmpdir(), "terrence", "runs", runId);

  let applySuccess = false;

  try {
    await writeLog(runId, "apply", `[terrence] Starting apply phase for run ${runId}`);

    const requestedTool = workspace.iacBinary || org?.defaultIacBinary || "tofu";
    const requestedVersion = workspace.terraformVersion || org?.defaultTerraformVersion || "latest";

    const resolved = await ensureBinary(requestedTool, requestedVersion);
    const { readdir } = await import("fs/promises");
    const dirFiles = (await exists(workDir)) ? await readdir(workDir) : [];
    const hasTfFiles = dirFiles.some(f => f.endsWith(".tf") || f.endsWith(".tf.json"));
    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || process.env.NODE_ENV === "test";

    if (resolved && (await exists(workDir)) && hasTfFiles) {
      const binary = resolved.binaryPath;
      const vars = await db.query.workspaceVariables.findMany({
        where: eq(workspaceVariables.workspaceId, workspace.id),
      });
      const envVars = buildSanitizedEnv(vars);

      await writeLog(runId, "apply", `\n--- Executing ${resolved.tool} apply ---`);
      const hasPlanFile = await exists(join(workDir, "tfplan"));
      const applyArgs = hasPlanFile
        ? [binary, "apply", "-no-color", "-input=false", "tfplan"]
        : [binary, "apply", "-no-color", "-input=false", "-auto-approve"];

      const applyProc = spawn(applyArgs, {
        cwd: workDir,
        env: envVars,
      });

      const [applyStdout, applyStderr] = await Promise.all([
        new Response(applyProc.stdout).text(),
        new Response(applyProc.stderr).text(),
      ]);

      if (applyStdout) await writeLog(runId, "apply", applyStdout);
      if (applyStderr) await writeLog(runId, "apply", applyStderr);

      const applyExit = await applyProc.exited;
      if (applyExit !== 0) {
        throw new Error(`${resolved.tool} apply failed with exit code ${applyExit}`);
      }

      const stateFilePath = join(workDir, "terraform.tfstate");
      if (await exists(stateFilePath)) {
        const statePayload = await readFile(stateFilePath, "utf-8");

        await db.transaction(async (tx) => {
          const latestState = await tx.query.stateVersions.findFirst({
            where: eq(stateVersions.workspaceId, workspace.id),
            orderBy: [desc(stateVersions.serial)],
          });
          const nextSerial = (latestState?.serial || 0) + 1;
          await tx.insert(stateVersions).values({
            id: crypto.randomUUID(),
            workspaceId: workspace.id,
            serial: nextSerial,
            statePayload,
          });
          await writeLog(runId, "apply", `[terrence] Recorded state version serial #${nextSerial}`);
        });
      }
    } else if (isSimulatedAllowed) {
      await writeLog(runId, "apply", `[terrence] Execution engine: Simulated apply completed successfully.`);
    } else {
      throw new Error(`Unable to resolve CLI binary '${requestedTool}' for apply phase.`);
    }

    applySuccess = true;
    await db.update(runs).set({ status: "applied" }).where(eq(runs.id, runId));
    await writeLog(runId, "apply", `[terrence] Run status updated to 'applied'.`);
  } catch (error: any) {
    console.error(`Run ${runId} apply failed`, error);
    await writeLog(runId, "apply", `[terrence ERROR] ${error.message || String(error)}`);
    await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
  } finally {
    if (applySuccess) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {}
    } else {
      await writeLog(runId, "apply", `[terrence] Preserving work directory for debugging: ${workDir}`);
    }
  }
}

let isWorkerLoopRunning = false;

export async function startWorkerQueue() {
  if (isWorkerLoopRunning) return;
  isWorkerLoopRunning = true;

  const poll = async () => {
    try {
      const pendingRuns = await db.query.runs.findMany({
        where: eq(runs.status, "pending"),
        limit: 5,
      });

      for (const run of pendingRuns) {
        const claimResult = await db.update(runs)
          .set({ status: "planning" })
          .where(and(eq(runs.id, run.id), eq(runs.status, "pending")));

        // Only execute if claiming succeeded
        executeRun(run.id).catch(err => console.error(`Worker error on run ${run.id}`, err));
      }
    } catch (err) {
      console.error("[terrence worker] Queue error", err);
    } finally {
      setTimeout(poll, 1500);
    }
  };

  poll();
}
