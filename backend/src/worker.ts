import { db } from "./db";
import {
  runs,
  configurationVersions,
  workspaces,
  workspaceVariables,
  logs,
  stateVersions,
  organizations,
  variableSets,
  variableSetWorkspaces,
  variableSetVariables,
} from "./db/schema";
import { eq, desc, asc, and, inArray } from "drizzle-orm";
import { spawn } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, readFile, exists } from "fs/promises";
import { ensureBinary } from "./binaryManager";
import { workspaceExecutionDirectory } from "./workspace";

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

async function streamLog(
  runId: string,
  phase: "plan" | "apply",
  stream: ReadableStream<Uint8Array>,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) await writeLog(runId, phase, text);
  }
  const tail = decoder.decode();
  if (tail) await writeLog(runId, phase, tail);
}

function buildSanitizedEnv(workspaceVars: Array<{ key: string; value: string; category: string }>): Record<string, string> {
  const allowedKeys = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "SHELL"];
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
    }
  }

  return env;
}

async function executionVariables(workspaceId: string, orgId: string) {
  const [workspaceVars, links, orgVariableSets] = await Promise.all([
    db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, workspaceId) }),
    db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.workspaceId, workspaceId) }),
    db.query.variableSets.findMany({
      where: eq(variableSets.orgId, orgId),
      orderBy: [asc(variableSets.id)],
    }),
  ]);
  const attached = new Set(links.map(link => link.variableSetId));
  const activeSetIds = orgVariableSets
    .filter(variableSet => variableSet.global || attached.has(variableSet.id))
    .map(variableSet => variableSet.id);
  const setVars = activeSetIds.length === 0
    ? []
    : await db.query.variableSetVariables.findMany({
        where: inArray(variableSetVariables.variableSetId, activeSetIds),
        orderBy: [asc(variableSetVariables.id)],
      });
  const effective = new Map<string, { key: string; value: string; category: string; hcl: boolean }>();
  for (const variable of setVars) {
    effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: false });
  }
  for (const variable of workspaceVars) {
    effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: variable.hcl === true });
  }
  return [...effective.values()];
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
  let keepPlan = false;

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

    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    const { readdir } = await import("fs/promises");
    let dirFiles: string[];
    try {
      dirFiles = await readdir(executionDir);
    } catch {
      throw new Error(`Working directory '${workspace.workingDirectory}' does not exist in the configuration.`);
    }
    await writeLog(runId, "plan", `[terrence] Executing from ${executionDir}`);
    await writeFile(
      join(executionDir, "terrence_backend_override.tf"),
      'terraform {\n  backend "local" {}\n}\n',
    );

    const latestState = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspace.id),
      orderBy: [desc(stateVersions.serial)],
    });
    if (latestState?.statePayload) {
      await writeFile(join(executionDir, "terraform.tfstate"), latestState.statePayload);
      await writeLog(runId, "plan", `[terrence] Seeded workspace state serial #${latestState.serial}.`);
    }

    const vars = await executionVariables(workspace.id, workspace.orgId);

    const envVars = buildSanitizedEnv(vars);
    if (run.debuggingMode) envVars.TF_LOG = "TRACE";
    const tfVarsLines = vars
      .filter(variable => variable.category === "terraform")
      .map(variable => `${variable.key} = ${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);

    if (tfVarsLines.length > 0) {
      await writeFile(join(executionDir, "terrence.workspace.tfvars"), tfVarsLines.join("\n"));
      await writeLog(runId, "plan", `[terrence] Injected ${tfVarsLines.length} workspace Terraform variables.`);
    }

    const requestedTool = workspace.iacBinary || org?.defaultIacBinary || "tofu";
    const requestedVersion = run.terraformVersion || workspace.terraformVersion || org?.defaultTerraformVersion || "latest";

    const hasTfFiles = dirFiles.some(f => f.endsWith(".tf") || f.endsWith(".tf.json"));

    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || process.env.NODE_ENV === "test";
    if (!isSimulatedAllowed) {
      await writeLog(runId, "plan", `[terrence] Resolving binary for ${requestedTool} (version: ${requestedVersion})...`);
    }
    const resolved = isSimulatedAllowed ? null : await ensureBinary(requestedTool, requestedVersion);

    if (resolved && hasTfFiles) {
      const binary = resolved.binaryPath;
      await writeLog(runId, "plan", `[terrence] Using ${resolved.tool} v${resolved.version} at ${binary}`);

      // 1. Run init
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} init ---`);
      const initProc = spawn([binary, "init", "-reconfigure", "-no-color", "-input=false"], {
        cwd: executionDir,
        env: envVars,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [initExit] = await Promise.all([
        initProc.exited,
        streamLog(runId, "plan", initProc.stdout),
        streamLog(runId, "plan", initProc.stderr),
      ]);

      if (initExit !== 0) {
        throw new Error(`${resolved.tool} init failed with exit code ${initExit}`);
      }

      // 2. Run plan
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} plan ---`);
      const planArgs = [binary, "plan", "-no-color", "-input=false"];
      if (!run.refresh) planArgs.push("-refresh=false");
      if (run.refreshOnly) planArgs.push("-refresh-only");
      if (run.isDestroy) planArgs.push("-destroy");
      for (const target of run.targetAddrs || []) planArgs.push(`-target=${target}`);
      for (const replacement of run.replaceAddrs || []) planArgs.push(`-replace=${replacement}`);
      if (tfVarsLines.length > 0) planArgs.push("-var-file=terrence.workspace.tfvars");
      for (const variable of run.variables || []) planArgs.push(`-var=${variable.key}=${variable.value}`);
      planArgs.push("-out=tfplan");

      const planProc = spawn(planArgs, {
        cwd: executionDir,
        env: envVars,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [planExit] = await Promise.all([
        planProc.exited,
        streamLog(runId, "plan", planProc.stdout),
        streamLog(runId, "plan", planProc.stderr),
      ]);

      if (planExit !== 0) {
        throw new Error(`${resolved.tool} plan failed with exit code ${planExit}`);
      }
    } else if (isSimulatedAllowed) {
      await writeLog(runId, "plan", `[terrence] Execution engine: Simulated plan completed successfully.`);
      await writeLog(runId, "plan", `Plan: 1 to add, 0 to change, 0 to destroy.`);
    } else {
      throw new Error(`Unable to resolve CLI binary '${requestedTool}' or no Terraform configuration (.tf) files were found in workspace.`);
    }

    const plannedStatus = run.planOnly ? "planned_and_finished" : "planned";
    await db.update(runs).set({ status: plannedStatus }).where(eq(runs.id, runId));
    await writeLog(runId, "plan", `[terrence] Run status updated to '${plannedStatus}'.`);

    if (run.planOnly) {
      keepPlan = false;
    } else if (workspace.autoApply || run.autoApply) {
      await executeApply(runId);
    } else {
      keepPlan = true;
    }
  } catch (error: any) {
    console.error(`Run ${runId} planning failed`, error);
    await writeLog(runId, "plan", `[terrence ERROR] ${error.message || String(error)}`);
    await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
  } finally {
    if (!keepPlan) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {}
    }
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
    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    await writeLog(runId, "apply", `[terrence] Starting apply phase for run ${runId}`);

    const requestedTool = workspace.iacBinary || org?.defaultIacBinary || "tofu";
    const requestedVersion = run.terraformVersion || workspace.terraformVersion || org?.defaultTerraformVersion || "latest";

    const { readdir } = await import("fs/promises");
    const dirFiles = (await exists(executionDir)) ? await readdir(executionDir) : [];
    const hasTfFiles = dirFiles.some(f => f.endsWith(".tf") || f.endsWith(".tf.json"));
    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || process.env.NODE_ENV === "test";
    const resolved = isSimulatedAllowed ? null : await ensureBinary(requestedTool, requestedVersion);

    if (resolved && (await exists(executionDir)) && hasTfFiles) {
      const binary = resolved.binaryPath;
      const vars = await executionVariables(workspace.id, workspace.orgId);
      const envVars = buildSanitizedEnv(vars);
      if (run.debuggingMode) envVars.TF_LOG = "TRACE";

      await writeLog(runId, "apply", `\n--- Executing ${resolved.tool} apply ---`);
      const hasPlanFile = await exists(join(executionDir, "tfplan"));
      const applyArgs = hasPlanFile
        ? [binary, "apply", "-no-color", "-input=false", "tfplan"]
        : [binary, "apply", "-no-color", "-input=false", "-auto-approve"];

      const applyProc = spawn(applyArgs, {
        cwd: executionDir,
        env: envVars,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [applyExit] = await Promise.all([
        applyProc.exited,
        streamLog(runId, "apply", applyProc.stdout),
        streamLog(runId, "apply", applyProc.stderr),
      ]);

      if (applyExit !== 0) {
        throw new Error(`${resolved.tool} apply failed with exit code ${applyExit}`);
      }

      const stateFilePath = join(executionDir, "terraform.tfstate");
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

export async function pollWorkerQueue(): Promise<string[]> {
  // ponytail: scan the pending queue in-process; replace with a grouped SQL claim if queue volume matters.
  const pendingRuns = await db.query.runs.findMany({
    where: eq(runs.status, "pending"),
    orderBy: [asc(runs.createdAt)],
  });
  const claimedRunIds: string[] = [];
  const claimedWorkspaceIds = new Set<string>();

  for (const run of pendingRuns) {
    if (claimedRunIds.length === 5) break;
    if (claimedWorkspaceIds.has(run.workspaceId)) continue;

    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, run.workspaceId),
    });
    if (!workspace || workspace.locked) continue;

    const activeRun = await db.query.runs.findFirst({
      where: and(
        eq(runs.workspaceId, run.workspaceId),
        inArray(runs.status, ["planning", "planned", "applying"]),
      ),
    });
    if (activeRun) continue;

    const claimed = await db.update(runs)
      .set({ status: "planning" })
      .where(and(eq(runs.id, run.id), eq(runs.status, "pending")))
      .returning({ id: runs.id });

    if (claimed.length > 0) {
      claimedRunIds.push(run.id);
      claimedWorkspaceIds.add(run.workspaceId);
      executeRun(run.id).catch(err => console.error(`Worker error on run ${run.id}`, err));
    }
  }

  return claimedRunIds;
}

export async function startWorkerQueue() {
  if (isWorkerLoopRunning) return;
  isWorkerLoopRunning = true;

  const poll = async () => {
    try {
      await pollWorkerQueue();
    } catch (err) {
      console.error("[terrence worker] Queue error", err);
    } finally {
      setTimeout(poll, 1500);
    }
  };

  poll();
}
