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
  policySets,
  policySetWorkspaces,
  policies,
  policyChecks,
} from "./db/schema";
import { eq, desc, asc, and, inArray, notInArray, sql } from "drizzle-orm";
import { spawn } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, readFile, exists, readdir } from "fs/promises";
import { ensureBinary } from "./binaryManager";
import { workspaceExecutionDirectory } from "./workspace";

async function writeLog(runId: string, phase: "plan" | "apply", outputText: string): Promise<void> {
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

async function updateRunStatus(runId: string, status: string, extra?: Readonly<Record<string, unknown>>): Promise<void> {
  const now = new Date().toISOString();
  const statusKey = status.replace(/_/g, "-") + "-at";
  try {
    const existing = await db.query.runs.findFirst({
      where: eq(runs.id, runId),
      columns: { statusTimestamps: true },
    });
    const existingTimestamps = typeof existing?.statusTimestamps === "object" && existing.statusTimestamps !== null
      ? (existing.statusTimestamps as Record<string, unknown>)
      : {};
    const timestamps = { ...existingTimestamps, [statusKey]: now };
    await db.update(runs).set({ status, statusTimestamps: timestamps, ...(extra ?? {}) }).where(eq(runs.id, runId));
  } catch (err: unknown) {
    console.error(`[terrence] Failed to update run ${runId} status to ${status}:`, err);
    await db.update(runs).set({ status, ...(extra ?? {}) }).where(eq(runs.id, runId));
  }
}

/** Parse Terraform plan output to extract resource change counts (1 to add, 0 to change, 1 to destroy) */
function parseResourceCounts(output: string): { additions: number; changes: number; destructions: number } {
  const additions = /Plan:\s+(\d+)\s+to add/.exec(output);
  const changes = /(\d+)\s+to change/.exec(output);
  const destructions = /(\d+)\s+to destroy/.exec(output);
  return {
    additions: additions !== null ? Number.parseInt(additions[1] ?? "0", 10) : 0,
    changes: changes !== null ? Number.parseInt(changes[1] ?? "0", 10) : 0,
    destructions: destructions !== null ? Number.parseInt(destructions[1] ?? "0", 10) : 0,
  };
}

async function streamLog(
  runId: string,
  phase: "plan" | "apply",
  stream: Readonly<ReadableStream<Uint8Array>>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastFlush = Date.now();
  const flushIntervalMs = 50;
  const bufferThreshold = 1024;

  const flush = async (): Promise<void> => {
    if (buffer.length > 0) {
      const textToFlush = buffer;
      buffer = "";
      lastFlush = Date.now();
      await writeLog(runId, phase, textToFlush);
    }
  };

  while (buffer.length >= 0) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text !== "") {
      buffer += text;
      if (buffer.length >= bufferThreshold || Date.now() - lastFlush >= flushIntervalMs) {
        await flush();
      }
    }
  }
  const tail = decoder.decode();
  if (tail !== "") buffer += tail;
  await flush();
}

function buildSanitizedEnv(workspaceVars: readonly (readonly { readonly key: string; readonly value: string; readonly category: string })[]): Record<string, string> {

  const allowedKeys = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "SHELL"];
  const protectedKeys = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "TF_CLI_CONFIG_FILE", "DYLD_INSERT_LIBRARIES"];

  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    const val = process.env[key];
    if (typeof val === "string" && val !== "") env[key] = val;
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

async function executionVariables(workspaceId: string, orgId: string): Promise<{ key: string; value: string; category: string; hcl: boolean }[]> {
  const [workspaceVars, links, orgVariableSets] = await Promise.all([
    db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, workspaceId) }),
    db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.workspaceId, workspaceId) }),
    db.query.variableSets.findMany({
      where: eq(variableSets.orgId, orgId),
      orderBy: [asc(variableSets.name), asc(variableSets.id)],
    }),
  ]);
  const attached = new Set(links.map((link: { readonly variableSetId: string }): string => link.variableSetId));
  const activeSets = orgVariableSets.filter((vs: { readonly global: boolean | null; readonly id: string }): boolean => vs.global === true || attached.has(vs.id));
  const activeSetIds = activeSets.map((vs: { readonly id: string }): string => vs.id);

  // Build priority lookup
  const prioritySetIds = new Set(activeSets.filter((vs: { readonly priority: boolean | null; readonly id: string }): boolean => vs.priority === true).map((vs: { readonly id: string }): string => vs.id));

  const setVars = activeSetIds.length === 0
    ? []
    : await db.query.variableSetVariables.findMany({
        where: inArray(variableSetVariables.variableSetId, activeSetIds),
        orderBy: [asc(variableSetVariables.id)],
      });

  const effective = new Map<string, { key: string; value: string; category: string; hcl: boolean }>();

  // 1. Non-priority variable set variables first
  for (const variable of setVars) {
    if (!prioritySetIds.has(variable.variableSetId)) {
      effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: false });
    }
  }

  // 2. Workspace variables override non-priority sets
  for (const variable of workspaceVars) {
    effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: variable.hcl === true });
  }

  // 3. Priority variable set variables override everything
  for (const variable of setVars) {
    if (prioritySetIds.has(variable.variableSetId)) {
      effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: false });
    }
  }

  return [...effective.values()];
}

async function extractTarArchive(archivePath: string, destDir: string): Promise<boolean> {
  try {
    const verboseProc = spawn(["tar", "-tvzf", archivePath]);
    const verboseText = await new Response(verboseProc.stdout).text();
    const verboseExitCode = await verboseProc.exited;
    if (verboseExitCode !== 0) return false;

    const verboseLines = verboseText.split("\n").map((s: string): string => s.trim()).filter((s: string): boolean => s !== "");
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

    const members = membersText.split("\n").map((s: string): string => s.trim()).filter((s: string): boolean => s !== "");
    for (const m of members) {
      if (m.startsWith("/") || m.includes("..")) {
        console.error(`[terrence] Security error: Archive contains dangerous path '${m}'`);
        return false;
      }
    }

    const extractProc = spawn(["tar", "-xzf", archivePath, "-C", destDir]);
    return (await extractProc.exited) === 0;
  } catch (err: unknown) {
    console.error("[terrence] Tar extraction error", err);
    return false;
  }
}

export async function executeRun(runId: string): Promise<void> {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (run === undefined) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });

  if (workspace === undefined) return;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });

  // Advance through intermediate queuing states before planning
  await updateRunStatus(runId, "queuing");
  await updateRunStatus(runId, "plan_queued");
  await updateRunStatus(runId, "planning");

  const workDir = join(tmpdir(), "terrence", "runs", runId);
  let keepPlan = false;

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await writeLog(runId, "plan", `[terrence] Initializing run environment in ${workDir}`);

    if (run.configurationVersionId !== null) {
      const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, run.configurationVersionId),
      });

      if (cv !== undefined && typeof cv.archivePath === "string" && cv.archivePath !== "" && (await exists(cv.archivePath))) {
        await writeLog(runId, "plan", `[terrence] Extracting configuration archive ${cv.archivePath}`);
        const ok = await extractTarArchive(cv.archivePath, workDir);
        if (!ok) {
          throw new Error("Configuration archive extraction failed or contained invalid path components.");
        }
      }
    }

    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    let dirFiles: string[];
    try {
      dirFiles = await readdir(executionDir);
    } catch {
      throw new Error(`Working directory '${workspace.workingDirectory ?? ""}' does not exist in the configuration.`);
    }
    await writeLog(runId, "plan", `[terrence] Executing from ${executionDir}`);
    await writeFile(
      join(executionDir, "terrence_backend_override.tf"),
      'terraform {\n  backend "local" {}\n}\n',
      { mode: 0o600 },
    );

    const latestState = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspace.id),
      orderBy: [desc(stateVersions.serial)],
    });
    if (latestState !== undefined && typeof latestState.statePayload === "string" && latestState.statePayload !== "") {
      await writeFile(join(executionDir, "terraform.tfstate"), latestState.statePayload, { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Seeded workspace state serial #${latestState.serial}.`);
    }

    const vars = await executionVariables(workspace.id, workspace.orgId);

    const envVars = buildSanitizedEnv(vars);
    if (run.debuggingMode) envVars.TF_LOG = "TRACE";
    const tfVarsLines = vars
      .filter((variable: { readonly category: string }): boolean => variable.category === "terraform")
      .map((variable: { readonly key: string; readonly hcl: boolean; readonly value: string }): string => `${variable.key} = ${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);

    if (tfVarsLines.length > 0) {
      await writeFile(join(executionDir, "terrence.workspace.tfvars"), tfVarsLines.join("\n"), { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Injected ${tfVarsLines.length} workspace Terraform variables.`);
    }

    const requestedTool = workspace.iacBinary ?? org?.defaultIacBinary ?? "tofu";
    const requestedVersion = run.terraformVersion ?? workspace.terraformVersion ?? org?.defaultTerraformVersion ?? "latest";

    const hasTfFiles = dirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));

    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || process.env.NODE_ENV === "test";
    if (!isSimulatedAllowed) {
      await writeLog(runId, "plan", `[terrence] Resolving binary for ${requestedTool} (version: ${requestedVersion})...`);
    }
    const resolved = isSimulatedAllowed ? null : await ensureBinary(requestedTool, requestedVersion);

    if (resolved !== null && hasTfFiles) {
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
      if (run.isDestroy === true) planArgs.push("-destroy");
      for (const target of run.targetAddrs ?? []) planArgs.push(`-target=${target}`);
      for (const replacement of run.replaceAddrs ?? []) planArgs.push(`-replace=${replacement}`);
      if (tfVarsLines.length > 0) planArgs.push("-var-file=terrence.workspace.tfvars");
      for (const variable of run.variables ?? []) planArgs.push(`-var=${variable.key}=${variable.value}`);
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

    const plannedStatus = run.planOnly
      ? "planned_and_finished"
      : run.savePlan
        ? "planned_and_saved"
        : "planned";

    // Parse resource counts from plan log output
    const planLog = await db.query.logs.findFirst({
      where: and(eq(logs.runId, runId), eq(logs.phase, "plan")),
      orderBy: [desc(logs.createdAt)],
    });
    const resourceCounts = planLog !== undefined ? parseResourceCounts(planLog.outputText) : { additions: 0, changes: 0, destructions: 0 };

    await updateRunStatus(runId, plannedStatus, {
      planResourceAdditions: resourceCounts.additions,
      planResourceChanges: resourceCounts.changes,
      planResourceDestructions: resourceCounts.destructions,
    });
    await writeLog(runId, "plan", `[terrence] Run status updated to '${plannedStatus}'.`);

    if (run.planOnly) {
      keepPlan = false;
    } else {
      // Run policy checks before deciding to apply
      const policyResult = await runPolicyChecks(runId, workspace.id, workspace.orgId, executionDir);
      if (!policyResult.proceed) {
        if (policyResult.hardFailed) {
          await updateRunStatus(runId, "errored");
          await writeLog(runId, "plan", `[terrence] Run blocked by hard-mandatory policy failure.`);
        } else if (policyResult.softFailed) {
          await updateRunStatus(runId, "policy_soft_failed");
          await writeLog(runId, "plan", `[terrence] Run requires policy override before apply.`);
        }
        keepPlan = true;
      } else if (workspace.autoApply === true || run.autoApply || run.allowEmptyApply) {
        await writeLog(runId, "plan", `[terrence] All policies passed. Proceeding to apply.`);
        await executeApply(runId);
      } else {
        keepPlan = true;
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Run ${runId} planning failed`, error);
    await writeLog(runId, "plan", `[terrence ERROR] ${errMsg}`);
    await updateRunStatus(runId, "errored");
  } finally {
    if (!keepPlan) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function executeApply(runId: string): Promise<void> {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (run === undefined) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });

  if (workspace === undefined) {
    console.error(`[terrence] Workspace missing for run ${runId}`);
    return;
  }

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });

  // Advance through apply_queued before applying
  await updateRunStatus(runId, "apply_queued");
  await updateRunStatus(runId, "applying");
  const workDir = join(tmpdir(), "terrence", "runs", runId);

  let applySuccess = false;

  try {
    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    await writeLog(runId, "apply", `[terrence] Starting apply phase for run ${runId}`);

    const requestedTool = workspace.iacBinary ?? org?.defaultIacBinary ?? "tofu";
    const requestedVersion = run.terraformVersion ?? workspace.terraformVersion ?? org?.defaultTerraformVersion ?? "latest";

    const dirFiles = (await exists(executionDir)) ? await readdir(executionDir) : [];
    const hasTfFiles = dirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));
    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || process.env.NODE_ENV === "test";
    const resolved = isSimulatedAllowed ? null : await ensureBinary(requestedTool, requestedVersion);

    if (resolved !== null && (await exists(executionDir)) && hasTfFiles) {
      const binary = resolved.binaryPath;
      const vars = await executionVariables(workspace.id, workspace.orgId);
      const envVars = buildSanitizedEnv(vars);
      if (run.debuggingMode) envVars.TF_LOG = "TRACE";

      await writeLog(runId, "apply", `\n--- Executing ${resolved.tool} apply ---`);
      const hasPlanFile = await exists(join(executionDir, "tfplan"));
      if (!hasPlanFile) {
        throw new Error("Saved plan file 'tfplan' is missing; cannot apply run.");
      }
      const applyArgs = [binary, "apply", "-no-color", "-input=false", "tfplan"];

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

        await db.transaction(async (tx: unknown): Promise<void> => {
          const t = tx as typeof db;
          const latestState = await t.query.stateVersions.findFirst({
            where: eq(stateVersions.workspaceId, workspace.id),
            orderBy: [desc(stateVersions.serial)],
          });
          const nextSerial = (latestState?.serial ?? 0) + 1;
          await t.insert(stateVersions).values({
            id: crypto.randomUUID(),
            workspaceId: workspace.id,
            serial: nextSerial,
            statePayload,
            runId,
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

    // Parse resource counts from apply log output
    const applyLog = await db.query.logs.findFirst({
      where: and(eq(logs.runId, runId), eq(logs.phase, "apply")),
      orderBy: [desc(logs.createdAt)],
    });
    const applyResourceCounts = applyLog !== undefined ? parseResourceCounts(applyLog.outputText) : { additions: 0, changes: 0, destructions: 0 };

    await updateRunStatus(runId, "applied", {
      applyResourceAdditions: applyResourceCounts.additions,
      applyResourceChanges: applyResourceCounts.changes,
      applyResourceDestructions: applyResourceCounts.destructions,
    });
    await writeLog(runId, "apply", `[terrence] Run status updated to 'applied'.`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Run ${runId} apply failed`, error);
    await writeLog(runId, "apply", `[terrence ERROR] ${errMsg}`);
    await updateRunStatus(runId, "errored");
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

/**
 * Evaluate policies attached to a workspace after a plan completes.
 * Returns an object indicating whether the run should proceed to apply.
 */
async function runPolicyChecks(
  runId: string,
  workspaceId: string,
  orgId: string,
  executionDir?: string,
): Promise<{ proceed: boolean; hardFailed: boolean; softFailed: boolean }> {
  const attached = await db.query.policySetWorkspaces.findMany({
    where: eq(policySetWorkspaces.workspaceId, workspaceId),
  });
  const attachedSetIds = new Set(attached.map((a: { readonly policySetId: string }): string => a.policySetId));

  const orgPolicySets = await db.query.policySets.findMany({
    where: and(eq(policySets.orgId, orgId), eq(policySets.global, true)),
  });

  const allSetIds = [...attachedSetIds, ...orgPolicySets.map((ps: { readonly id: string }): string => ps.id)];
  if (allSetIds.length === 0) return { proceed: true, hardFailed: false, softFailed: false };

  const allPolicies = await db.query.policies.findMany({
    where: inArray(policies.policySetId, allSetIds),
  });
  if (allPolicies.length === 0) return { proceed: true, hardFailed: false, softFailed: false };

  // Generate plan JSON output from the tfplan binary file
  let planJsonPayload: string | null = null;
  if (executionDir !== undefined && executionDir !== "") {
    try {
      const tfplanPath = join(executionDir, "tfplan");
      if (await exists(tfplanPath)) {
        // Use terraform or tofu show -json to generate plan JSON
        // Try tofu first, then terraform
        for (const binary of ["tofu", "terraform"]) {
          try {
            const showProc = spawn([binary, "show", "-json", tfplanPath], {
              cwd: executionDir,
              env: { PATH: process.env.PATH ?? "" },
              stdout: "pipe",
              stderr: "pipe",
            });
            if ((await showProc.exited) === 0) {
              planJsonPayload = await new Response(showProc.stdout).text();
              break;
            }
          } catch {}
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeLog(runId, "plan", `[terrence] Could not generate plan JSON: ${errMsg}`);
    }
  }

  // Fallback to stored state version if plan JSON generation failed
  if (planJsonPayload === null || planJsonPayload === "") {
    const latestState = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspaceId),
      orderBy: [desc(stateVersions.serial)],
    });
    planJsonPayload = latestState?.statePayload ?? null;
  }

  await writeLog(runId, "plan", `[terrence] Evaluating ${allPolicies.length} policies across ${allSetIds.length} policy sets...`);

  let hardFailed = false;
  let softFailed = false;

  for (const policy of allPolicies) {
    const checkId = `pchk-${crypto.randomUUID()}`;
    let checkStatus = "unreachable";
    let checkResult: Record<string, unknown> = {};

    try {
      // For OPA policies, attempt to run opa eval
      const policySet = await db.query.policySets.findFirst({ where: eq(policySets.id, policy.policySetId) });
      const isOpa = policySet?.kind === "opa";

      if (isOpa && typeof policy.query === "string" && policy.query !== "" && planJsonPayload !== null && planJsonPayload !== "") {
        // Try to evaluate with OPA
        const workDir = join(tmpdir(), "terrence", "opa", runId);
        try {
          await mkdir(workDir, { recursive: true });
        } catch {}
        const policyPath = join(workDir, "policy.rego");
        const dataPath = join(workDir, "input.json");
        await writeFile(policyPath, policy.query);
        await writeFile(dataPath, planJsonPayload);
        const opaProc = spawn(["opa", "eval", "--data", policyPath, "--input", dataPath, "data"], {
          cwd: workDir,
          env: { PATH: process.env.PATH ?? "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [opaExit, opaStdout] = await Promise.all([
          opaProc.exited,
          new Response(opaProc.stdout).text(),
          new Response(opaProc.stderr).text().catch((): string => ""),
        ]);
        if (opaExit === 0) {
          checkResult = JSON.parse(opaStdout !== "" ? opaStdout : "{}") as Record<string, unknown>;
          const resultList = checkResult["result"] as Record<string, unknown>[] | undefined;
          const exprList = resultList?.[0]?.["expressions"] as Record<string, unknown>[] | undefined;
          const valObj = exprList?.[0]?.["value"] as Record<string, unknown> | undefined;
          const violated = valObj?.["violations"];
          if (violated !== undefined && Array.isArray(violated) && violated.length > 0) {
            checkStatus = "failed";
          } else {
            checkStatus = "passed";
          }
        } else {
          checkStatus = "errored";
          checkResult = { error: "OPA evaluation failed" };
        }
        try {
          await rm(workDir, { recursive: true, force: true });
        } catch {}
      } else if (!isOpa) {
        // Non-OPA policies (e.g. Sentinel) are not yet evaluated
        checkStatus = "unreachable";
        checkResult = { error: "Policy kind not supported for evaluation" };
      } else {
        // OPA policy but missing query or plan data
        checkStatus = "errored";
        checkResult = { error: "Missing policy query or plan data for evaluation" };
      }

      await db.insert(policyChecks).values({
        id: checkId,
        runId,
        policyId: policy.id,
        policySetId: policy.policySetId,
        status: checkStatus,
        result: checkResult,
        createdAt: Date.now(),
      });

      if (checkStatus === "failed") {
        if (policy.enforcementLevel === "hard-mandatory") {
          hardFailed = true;
          await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" HARD-FAILED (hard-mandatory). Blocking apply.`);
        } else if (policy.enforcementLevel === "soft-mandatory") {
          softFailed = true;
          await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" SOFT-FAILED (soft-mandatory). Override required.`);
        } else {
          await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" FAILED (advisory — not blocking).`);
        }
      } else if (checkStatus === "passed") {
        await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" PASSED.`);
      } else if (checkStatus === "errored") {
        await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" errored: ${JSON.stringify(checkResult)}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await db.insert(policyChecks).values({
        id: checkId,
        runId,
        policyId: policy.id,
        policySetId: policy.policySetId,
        status: "errored",
        result: { error: errMsg },
        createdAt: Date.now(),
      });
      await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" evaluation error: ${errMsg}`);
    }
  }

  // Both hard and soft failures block apply
  const proceed = !hardFailed && !softFailed;
  return { proceed, hardFailed, softFailed };
}

let isWorkerLoopRunning = false;

export async function pollWorkerQueue(): Promise<string[]> {
  // ponytail: scan the pending queue in-process; replace with a grouped SQL claim if queue volume matters.
  const pendingRuns = await db.query.runs.findMany({
    where: eq(runs.status, "pending"),
    orderBy: [asc(runs.createdAt)],
    limit: 50,
  });
  const claimedRunIds: string[] = [];
  const claimedWorkspaceIds = new Set<string>();

  for (const run of pendingRuns) {
    if (claimedRunIds.length === 5) break;
    if (claimedWorkspaceIds.has(run.workspaceId)) continue;

    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, run.workspaceId),
    });
    if (workspace === undefined || workspace.locked === true) continue;

    // Atomic conditional claim: only claim if no planning/applying run exists for this workspace,
    // and the run is still pending.
    // Speculative/plan-only runs do NOT block the queue — they can run alongside other runs.
    const blockerStatuses = run.planOnly
      ? []  // speculative runs don't block anything
      : ["planning", "planned", "planned_and_saved", "applying", "policy_soft_failed",
         "queuing", "plan_queued", "apply_queued"];

    // Claim the run atomically by moving it to `queuing`
    const claimed = await db.update(runs)
      .set({ status: "queuing" })
      .where(and(
        eq(runs.id, run.id),
        eq(runs.status, "pending"),
        blockerStatuses.length > 0
          ? notInArray(
              runs.workspaceId,
              db.select({ workspaceId: runs.workspaceId }).from(runs).where(
                and(
                  eq(runs.workspaceId, run.workspaceId),
                  inArray(runs.status, blockerStatuses),
                ),
              ),
            )
          : sql`1=1`,
      ))
      .returning({ id: runs.id });

    if (claimed.length > 0) {
      claimedRunIds.push(run.id);
      claimedWorkspaceIds.add(run.workspaceId);
      // Advance through plan_queued then dispatch to planning
      executeRun(run.id).catch((err: unknown): void => { console.error(`Worker error on run ${run.id}`, err); });
    }
  }

  return claimedRunIds;
}

export function startWorkerQueue(): void {
  if (isWorkerLoopRunning) return;
  isWorkerLoopRunning = true;

  const poll = async (): Promise<void> => {
    try {
      await pollWorkerQueue();
    } catch (err: unknown) {
      console.error("[terrence worker] Queue error", err);
    } finally {
      setTimeout((): void => { void poll(); }, 1500);
    }
  };

  void poll();
}
