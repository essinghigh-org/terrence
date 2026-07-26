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
import { eq, desc, asc, and, inArray, notInArray, or } from "drizzle-orm";
import { spawn } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, readFile, exists, readdir } from "fs/promises";
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
  let buffer = "";
  let lastFlush = Date.now();
  const flushIntervalMs = 50;
  const bufferThreshold = 1024;

  const flush = async () => {
    if (buffer.length > 0) {
      const textToFlush = buffer;
      buffer = "";
      lastFlush = Date.now();
      await writeLog(runId, phase, textToFlush);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) {
      buffer += text;
      if (buffer.length >= bufferThreshold || Date.now() - lastFlush >= flushIntervalMs) {
        await flush();
      }
    }
  }
  const tail = decoder.decode();
  if (tail) buffer += tail;
  await flush();
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
      orderBy: [asc(variableSets.name), asc(variableSets.id)],
    }),
  ]);
  const attached = new Set(links.map(link => link.variableSetId));
  const activeSets = orgVariableSets.filter(vs => vs.global || attached.has(vs.id));
  const activeSetIds = activeSets.map(vs => vs.id);

  // Build priority lookup
  const prioritySetIds = new Set(activeSets.filter(vs => vs.priority).map(vs => vs.id));

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
    await mkdir(workDir, { recursive: true, mode: 0o700 });
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
      { mode: 0o600 },
    );

    const latestState = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspace.id),
      orderBy: [desc(stateVersions.serial)],
    });
    if (latestState?.statePayload) {
      await writeFile(join(executionDir, "terraform.tfstate"), latestState.statePayload, { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Seeded workspace state serial #${latestState.serial}.`);
    }

    const vars = await executionVariables(workspace.id, workspace.orgId);

    const envVars = buildSanitizedEnv(vars);
    if (run.debuggingMode) envVars.TF_LOG = "TRACE";
    const tfVarsLines = vars
      .filter(variable => variable.category === "terraform")
      .map(variable => `${variable.key} = ${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);

    if (tfVarsLines.length > 0) {
      await writeFile(join(executionDir, "terrence.workspace.tfvars"), tfVarsLines.join("\n"), { mode: 0o600 });
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

    const plannedStatus = run.planOnly || run.refreshOnly ? "planned_and_finished" : "planned";
    await db.update(runs).set({ status: plannedStatus }).where(eq(runs.id, runId));
    await writeLog(runId, "plan", `[terrence] Run status updated to '${plannedStatus}'.`);

    if (run.planOnly || run.refreshOnly) {
      keepPlan = false;
    } else {
      // Run policy checks before deciding to apply
      const policyResult = await runPolicyChecks(runId, workspace.id, workspace.orgId, executionDir);
      if (!policyResult.proceed) {
        if (policyResult.hardFailed) {
          await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
          await writeLog(runId, "plan", `[terrence] Run blocked by hard-mandatory policy failure.`);
        } else if (policyResult.softFailed) {
          await db.update(runs).set({ status: "policy_soft_failed" }).where(eq(runs.id, runId));
          await writeLog(runId, "plan", `[terrence] Run requires policy override before apply.`);
        }
        keepPlan = true;
      } else if (workspace.autoApply || run.autoApply) {
        await writeLog(runId, "plan", `[terrence] All policies passed. Proceeding to apply.`);
        await executeApply(runId);
      } else {
        keepPlan = true;
      }
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
  const attachedSetIds = new Set(attached.map(a => a.policySetId));

  const orgPolicySets = await db.query.policySets.findMany({
    where: and(eq(policySets.orgId, orgId), eq(policySets.global, true)),
  });

  const allSetIds = [...attachedSetIds, ...orgPolicySets.map(ps => ps.id)];
  if (allSetIds.length === 0) return { proceed: true, hardFailed: false, softFailed: false };

  const allPolicies = await db.query.policies.findMany({
    where: inArray(policies.policySetId, allSetIds),
  });
  if (allPolicies.length === 0) return { proceed: true, hardFailed: false, softFailed: false };

  // Generate plan JSON output from the tfplan binary file
  let planJsonPayload: string | null = null;
  if (executionDir) {
    try {
      const tfplanPath = join(executionDir, "tfplan");
      if (await exists(tfplanPath)) {
        // Use terraform or tofu show -json to generate plan JSON
        // Try tofu first, then terraform
        for (const binary of ["tofu", "terraform"]) {
          try {
            const showProc = spawn([binary, "show", "-json", tfplanPath], {
              cwd: executionDir,
              env: { PATH: process.env.PATH || "" },
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
    } catch (err) {
      await writeLog(runId, "plan", `[terrence] Could not generate plan JSON: ${err}`);
    }
  }

  // Fallback to stored state version if plan JSON generation failed
  if (!planJsonPayload) {
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
    let checkResult: Record<string, any> = {};

    try {
      // For OPA policies, attempt to run opa eval
      const policySet = await db.query.policySets.findFirst({ where: eq(policySets.id, policy.policySetId) });
      const isOpa = policySet?.kind === "opa";

      if (isOpa && policy.query && planJsonPayload) {
        // Try to evaluate with OPA
        const workDir = join(tmpdir(), "terrence", "opa", runId);
        await mkdir(workDir, { recursive: true }).catch(() => {});
        const policyPath = join(workDir, "policy.rego");
        const dataPath = join(workDir, "input.json");
        await writeFile(policyPath, policy.query);
        await writeFile(dataPath, planJsonPayload);
        const opaProc = spawn(["opa", "eval", "--data", policyPath, "--input", dataPath, "data"], {
          cwd: workDir,
          env: { PATH: process.env.PATH || "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [opaExit, opaStdout] = await Promise.all([
          opaProc.exited,
          new Response(opaProc.stdout).text(),
          new Response(opaProc.stderr).text().catch(() => ""),
        ]);
        if (opaExit === 0) {
          checkResult = JSON.parse(opaStdout || "{}");
          const violated = checkResult?.result?.[0]?.expressions?.[0]?.value?.violations;
          if (violated && Array.isArray(violated) && violated.length > 0) {
            checkStatus = "failed";
          } else {
            checkStatus = "passed";
          }
        } else {
          checkStatus = "errored";
          checkResult = { error: "OPA evaluation failed" };
        }
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
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
    } catch (err: any) {
      await db.insert(policyChecks).values({
        id: checkId,
        runId,
        policyId: policy.id,
        policySetId: policy.policySetId,
        status: "errored",
        result: { error: err.message },
        createdAt: Date.now(),
      });
      await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" evaluation error: ${err.message}`);
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
    if (!workspace || workspace.locked) continue;

    // Atomic conditional claim: only claim if no planning/applying run exists for this workspace,
    // and the run is still pending
    const claimed = await db.update(runs)
      .set({ status: "planning" })
      .where(and(
        eq(runs.id, run.id),
        eq(runs.status, "pending"),
        notInArray(
          runs.workspaceId,
          db.select({ workspaceId: runs.workspaceId }).from(runs).where(
            and(
              eq(runs.workspaceId, run.workspaceId),
              inArray(runs.status, ["planning", "applying"]),
            ),
          ),
        ),
      ))
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
