// Opt-in local acceptance using the production worker, API, and operator binary.
import { appendFile, chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";

const root = resolve(process.argv[2] ?? "");
if ((await stat(root)).mode % 0o1000 !== 0o700 || process.env["DATABASE_URL"] !== `file:${join(root, "test.db")}`)
  throw new Error("A private isolated acceptance database is required");
let ready = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { key: Bun.file(join(root, "server.key")), cert: Bun.file(join(root, "server.crt")) },
  fetch: (request: Request): Promise<Response> | Response =>
    ready ? handler(request) : new Response(null, { status: 503 }),
});
process.env["PUBLIC_URL"] = `https://localhost:${server.port}`;
const [{ app }, { db }, s, { executeRun, executeApply }] = await Promise.all([
  import("../../../src/app"),
  import("../../../src/db"),
  import("../../../src/db/schema"),
  import("../../../src/worker"),
]);
const handler = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (
    request.method !== "GET" ||
    (!["/.well-known/terraform.json", "/api/v2/ping"].includes(path) &&
      !/^\/api\/v2\/organizations\/native-worker-[a-f0-9-]+\/entitlement-set$/.test(path))
  )
    return new Response(null, { status: 403 });
  const response = await app.handle(request);
  await appendFile(join(root, "requests.jsonl"), JSON.stringify({ path, status: response.status }) + "\n", {
    mode: 0o600,
  });
  return response;
};
ready = true;
const orgId = `org-${crypto.randomUUID()}`;
await db.insert(s.organizations).values({
  id: orgId,
  name: `native-worker-${crypto.randomUUID()}`,
  defaultIacBinary: "terraform",
  defaultTerraformVersion: "1.17.1",
});
const profile = (await Bun.file(process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"] ?? "").json()) as {
  catalogSha256: string;
  pluginVersion: string;
};
await db.insert(s.adminTfpolicyVersions).values({
  id: `tfp-${crypto.randomUUID()}`,
  version: profile.pluginVersion,
  archs: [
    {
      os: "linux",
      arch: process.arch === "arm64" ? "arm64" : "amd64",
      url: "https://example.invalid/operator.zip",
      sha: profile.catalogSha256,
    },
  ],
});
const rows: Record<string, unknown>[] = [];
const modes = [
  "allow",
  "auto-apply",
  "deny",
  "override",
  "legacy",
  "setup-error",
  "missing",
  "unknown",
  "plan-crash",
  "plan-cancel",
  "apply-crash",
  "apply-cancel",
  "saved-tamper",
  "stale-policy",
  "worker-death",
  "apply-force",
];
const selected = process.argv[3]?.split(",") ?? modes;
if (selected.some((mode) => !modes.includes(mode))) throw new Error("Unknown hosted acceptance case");
const fullProfile = await Bun.file(process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"] ?? "").json();
async function fault(mode: string): Promise<ReturnType<typeof Bun.spawn> | undefined> {
  if (!/^(plan|apply)-(crash|cancel)$/.test(mode)) return undefined;
  const command = mode.startsWith("plan-") ? "plan" : "apply";
  return Bun.spawn(
    [
      "python3",
      "-I",
      resolve(import.meta.dir, "../../../../tools/tfpolicy-supervisor/integration/agent-fault.py"),
      fullProfile.cgroupRoot,
      fullProfile.privateParent,
      mode.endsWith("crash") ? fullProfile.runtime.plugin.path : fullProfile.owner.path,
      mode.endsWith("crash") ? "crash" : "cancel",
      "--command",
      command,
    ],
    {
      stdout: Bun.file(join(root, mode, "fault.json")),
      stderr: Bun.file(join(root, mode, "fault.stderr")),
      timeout: 55000,
    },
  );
}
async function verifyFault(child: Awaited<ReturnType<typeof fault>>): Promise<void> {
  if (child !== undefined && (await child.exited) !== 0)
    throw new Error("Hosted fault did not reach an in-flight resource RPC");
}
async function recordCase(mode: string, runId: string): Promise<void> {
  rows.push({ mode, passed: true, runId });
  await writeFile(join(root, "summary.json"), JSON.stringify({ hostedWorkerCases: rows }), { mode: 0o600 });
}
async function noManagedState(workspaceId: string): Promise<void> {
  const state = await db.query.stateVersions.findFirst({ where: eq(s.stateVersions.workspaceId, workspaceId) });
  if (state !== undefined) throw new Error("Failed admission published managed state");
}
try {
  for (const mode of selected) {
    const id = crypto.randomUUID(),
      workspaceId = `ws-${id}`,
      runId = `run-${id}`,
      setId = `polset-${id}`,
      cvId = `cv-${id}`;
    const config = join(root, mode, "config"),
      policy = join(root, mode, "policy");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await mkdir(policy, { recursive: true, mode: 0o700 });
    await writeFile(
      join(config, "main.tf"),
      /^(plan|apply)-(crash|cancel)$/.test(mode) || ["worker-death", "apply-force"].includes(mode)
        ? 'resource "terraform_data" "proof" {\n count = 200\n input = "local-only"\n}\n'
        : 'resource "terraform_data" "proof" { input = "local-only" }\n',
      { mode: 0o600 },
    );
    if (mode === "allow") {
      for (const name of ["child", "inner", "empty"]) await mkdir(join(config, name), { mode: 0o700 });
      await appendFile(
        join(config, "main.tf"),
        'module "child" {\n source = "./child"\n count = 2\n}\nmodule "empty" {\n source = "./empty"\n count = 0\n}\n',
      );
      await writeFile(
        join(config, "child/main.tf"),
        'resource "terraform_data" "child" { input = "local-only" }\nmodule "inner" { source = "../inner" }\n',
        { mode: 0o600 },
      );
      await writeFile(join(config, "inner/main.tf"), 'resource "terraform_data" "inner" { input = "local-only" }\n', {
        mode: 0o600,
      });
      await writeFile(join(config, "empty/main.tf"), "# Empty local module\n", { mode: 0o600 });
    }
    const condition =
      mode === "setup-error"
        ? "attrs.input =="
        : mode === "unknown"
          ? 'attrs.id == "never"'
          : `attrs.input == "${["deny", "override"].includes(mode) ? "forbidden" : "local-only"}"`;
    await writeFile(
      join(policy, "proof.policy.hcl"),
      `policy {\n required_providers {\n terraform = { source = "terraform.io/builtin/terraform" }\n }\n}\nresource_policy "terraform_data" "proof" {\n enforcement_level = "${mode === "override" ? "mandatory_overridable" : "mandatory"}"\n enforce {\n condition = ${condition}\n error_message = "worker acceptance denial"\n }\n}\n`,
      { mode: 0o600 },
    );
    const archives = [join(root, mode, "config.tar.gz"), join(root, mode, "policy.tar.gz")];
    if (mode === "allow")
      await appendFile(
        join(policy, "proof.policy.hcl"),
        'provider_policy "terraform" "source" {\n enforce {\n condition = meta.source == "terraform.io/builtin/terraform"\n }\n}\nmodule_policy "*" "local" {\n enforce {\n condition = true\n }\n}\n',
      );
    for (const [index, source] of [config, policy].entries()) {
      const child = Bun.spawn(["tar", "-czf", archives[index] ?? "", "-C", source, "."], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
    }
    await db.insert(s.workspaces).values({
      id: workspaceId,
      orgId,
      name: `worker-${mode}`,
      iacBinary: "terraform",
      terraformVersion: "1.17.1",
      executionMode: "remote",
      autoApply: false,
    });
    await db
      .insert(s.configurationVersions)
      .values({ id: cvId, workspaceId, status: "uploaded", archivePath: archives[0] });
    await db
      .insert(s.policySets)
      .values({ id: setId, orgId, name: `worker-${mode}`, kind: "tfpolicy", policyToolVersion: profile.pluginVersion });
    await db.insert(s.policySetWorkspaces).values({ id: `psw-${id}`, policySetId: setId, workspaceId });
    await db
      .insert(s.policySetVersions)
      .values({ id: `psv-${id}`, policySetId: setId, status: "ready", archivePath: archives[1] });
    await db.insert(s.runs).values({
      id: runId,
      workspaceId,
      configurationVersionId: cvId,
      status: "pending",
      terraformVersion: "1.17.1",
      savePlan: mode !== "auto-apply",
      autoApply: mode === "auto-apply",
      createdAt: Date.now(),
    });
    const planFault = mode.startsWith("plan-") ? await fault(mode) : undefined;
    const originalProfilePath = process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"];
    if (mode === "missing") {
      const path = join(root, mode, "missing-profile.json");
      await writeFile(
        path,
        JSON.stringify({
          ...fullProfile,
          runtime: {
            ...fullProfile.runtime,
            plugin: { ...fullProfile.runtime.plugin, path: join(root, mode, "missing-plugin") },
          },
        }),
        { mode: 0o400 },
      );
      process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"] = path;
    }
    try {
      await executeRun(runId);
    } catch (error) {
      if (!["setup-error", "missing", "unknown", "plan-crash", "plan-cancel"].includes(mode)) throw error;
      await writeFile(join(root, mode, "failure.txt"), String(error), { mode: 0o600 });
    } finally {
      process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"] = originalProfilePath;
    }
    await verifyFault(planFault);
    const planned = await db.query.runs.findFirst({ where: eq(s.runs.id, runId) });
    const checks = await db.query.policyChecks.findMany({ where: eq(s.policyChecks.runId, runId) });
    await writeFile(join(root, mode, "checks.json"), JSON.stringify(checks, null, 2), { mode: 0o600 });
    if (["setup-error", "missing", "unknown", "plan-crash", "plan-cancel"].includes(mode)) {
      if (planned?.status !== "errored") throw new Error(`Hosted failed ${mode} admission: ${planned?.status}`);
      await noManagedState(workspaceId);
      if (checks.some((check) => check.result?.["native"] === true && check.status === "passed"))
        throw new Error("Failed hosted native stage produced passed admission");
      await recordCase(mode, runId);
      continue;
    }
    if (mode === "auto-apply") {
      const state = await db.query.stateVersions.findFirst({ where: eq(s.stateVersions.workspaceId, workspaceId) });
      if (
        planned?.status !== "applied" ||
        state === undefined ||
        !checks.some((check) => check.result?.["native"] === true && check.status === "passed")
      )
        throw new Error(`Native auto-apply did not persist its authenticated plan and state: ${planned?.status}`);
      await recordCase(mode, runId);
      continue;
    }
    if (mode === "allow") {
      const native = checks.find((check) => check.result?.["native"] === true);
      const policies = native?.result?.["nativePolicies"];
      if (
        !Array.isArray(policies) ||
        !policies.some((policy) => policy.address === "provider_policy.terraform.source") ||
        !policies.some((policy) => policy.address === "module_policy.*.local")
      )
        throw new Error("Hosted worker did not persist matched provider/module policies");
    }
    if (mode === "deny") {
      if (
        !checks.some((check) => check.status === "failed" && check.result?.["native"] === true) ||
        planned?.status !== "errored"
      )
        throw new Error(`Mandatory deny was not enforced: ${planned?.status}`);
    } else if (mode === "override") {
      if (planned?.status !== "policy_soft_failed") throw new Error(`Override not requested: ${planned?.status}`);
      const { overridableWorkspacePolicyChecks } = await import("../../../src/lib/workspace-policy-gate");
      const targets = await overridableWorkspacePolicyChecks(db, { id: workspaceId, orgId }, runId);
      if (targets.length !== 1) throw new Error("Native override target missing");
      for (const check of targets)
        await db
          .update(s.policyChecks)
          .set({
            status: "overridden",
            result: { ...check.result, overrideEvaluationId: check.result?.["policyEvaluationId"] },
          })
          .where(eq(s.policyChecks.id, check.id));
    } else if (planned?.status !== "planned_and_saved")
      throw new Error(`Native plan did not complete: ${planned?.status}`);
    const { workspacePolicyExecutionError } = await import("../../../src/lib/workspace-policy-gate");
    if (mode === "allow") {
      await db.update(s.policySets).set({ description: "changed after native plan" }).where(eq(s.policySets.id, setId));
      if ((await workspacePolicyExecutionError(db, { id: workspaceId, orgId }, runId)) === null)
        throw new Error("Changed native policy snapshot authorized apply");
      await db.update(s.policySets).set({ description: null }).where(eq(s.policySets.id, setId));
    }
    if (mode === "deny") {
      const denied = checks.find((check) => check.result?.["native"] === true);
      if (denied === undefined) throw new Error("Missing denial check");
      await db.update(s.policyChecks).set({ status: "passed" }).where(eq(s.policyChecks.id, denied.id));
      if ((await workspacePolicyExecutionError(db, { id: workspaceId, orgId }, runId)) === null)
        throw new Error("Forged passed row bypassed signed mandatory denial");
      await db.update(s.policyChecks).set({ status: denied.status }).where(eq(s.policyChecks.id, denied.id));
    }
    if (mode === "legacy") {
      const { claimAgentJob } = await import("../../../src/lib/agent-jobs");
      await db.insert(s.agentPools).values({ id, orgId, name: "legacy-native-control", organizationScoped: true });
      await db
        .insert(s.agents)
        .values({ id, agentPoolId: id, name: "legacy-native-control", status: "idle", lastPingAt: Date.now() });
      await db.insert(s.agentJobs).values({ id, runId, agentPoolId: id, phase: "apply", status: "queued" });
      await db.update(s.runs).set({ status: "apply_queued" }).where(eq(s.runs.id, runId));
      const agent = await db.query.agents.findFirst({ where: eq(s.agents.id, id) });
      if (agent === undefined || (await claimAgentJob(agent)) !== undefined)
        throw new Error("Legacy agent received hosted native admission");
      const job = await db.query.agentJobs.findFirst({ where: eq(s.agentJobs.id, id) });
      if (job?.status !== "errored" || !job.errorMessage?.includes("tfpolicy runtime is not supported"))
        throw new Error("Legacy claim did not fail at native admission");
    }
    if (mode !== "deny" && mode !== "legacy") {
      if (mode === "saved-tamper") {
        const path = join(root, "storage", "saved-plans", runId, "tfplan");
        await chmod(path, 0o600);
        const { encryptSecret, decryptSecret } = await import("../../../src/lib/secrets");
        const bytes = Buffer.from(await decryptSecret(await readFile(path, "utf8")), "base64");
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        await writeFile(path, await encryptSecret(bytes.toString("base64")), { mode: 0o600 });
      }
      if (mode === "stale-policy")
        await db.update(s.policySets).set({ description: "changed before apply" }).where(eq(s.policySets.id, setId));
      await db.update(s.runs).set({ status: "confirmed" }).where(eq(s.runs.id, runId));
      if (mode === "worker-death") {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "worker-task.ts"), runId, root], {
          env: process.env,
          stdout: Bun.file(join(root, mode, "worker.stdout")),
          stderr: Bun.file(join(root, mode, "worker.stderr")),
          timeout: 60000,
        });
        const killer = Bun.spawn(
          [
            "python3",
            "-I",
            resolve(import.meta.dir, "../../../../tools/tfpolicy-supervisor/integration/agent-fault.py"),
            fullProfile.cgroupRoot,
            fullProfile.privateParent,
            fullProfile.runtime.plugin.path,
            "parent-death",
            "--parent-pid",
            String(child.pid),
            "--parent-exe",
            await realpath(process.execPath),
            "--observe-cgroup",
            join(process.env["TERRENCE_RUN_CGROUP_ROOT"] ?? fullProfile.cgroupRoot, runId),
          ],
          {
            stdout: Bun.file(join(root, mode, "fault.json")),
            stderr: Bun.file(join(root, mode, "fault.stderr")),
            timeout: 55000,
          },
        );
        await child.exited;
        if ((await killer.exited) !== 0) throw new Error("Worker death did not interrupt a stopped native RPC");
        const observed = JSON.parse(await readFile(join(root, mode, "fault.json"), "utf8"));
        const runCgroup = join(process.env["TERRENCE_RUN_CGROUP_ROOT"] ?? fullProfile.cgroupRoot, runId);
        if (observed.observedCgroup !== runCgroup)
          throw new Error("Worker death did not observe the populated run cgroup");
        let empty = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          const events = await readFile(join(runCgroup, "cgroup.events"), "utf8").catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "populated 0";
            throw error;
          });
          if (events.includes("populated 0")) {
            empty = true;
            break;
          }
          await Bun.sleep(100);
        }
        if (!empty) throw new Error("Native execution outlived its dead worker with a stopped plugin");
        const { reconcileInterruptedLocalRuns } = await import("../../../src/worker");
        await reconcileInterruptedLocalRuns();
        const { recoveryStatePathFor } = await import("../../../src/lib/recovery-files");
        const { decryptStatePayload } = await import("../../../src/lib/validation");
        const actual = JSON.parse(
          decryptStatePayload(await readFile(recoveryStatePathFor(join(root, "storage"), runId), "utf8")),
        );
        const instances = (actual.resources ?? []).flatMap(
          (resource: { instances?: unknown[] }) => resource.instances ?? [],
        );
        const recovered = await db.query.runs.findFirst({ where: eq(s.runs.id, runId) });
        if (instances.length !== 200 || recovered?.status !== "errored")
          throw new Error("Worker death lost post-mutation recovery state");
        await writeFile(
          join(root, mode, "retained-state-summary.json"),
          JSON.stringify({
            instances: instances.length,
            status: recovered.status,
            ownerStopped: true,
            recoveryCaptured: true,
          }),
          { mode: 0o600 },
        );
        await recordCase(mode, runId);
        continue;
      }
      const forced =
        mode === "apply-force"
          ? Bun.spawn(
              [
                "python3",
                "-I",
                resolve(import.meta.dir, "../../../../tools/tfpolicy-supervisor/integration/agent-fault.py"),
                fullProfile.cgroupRoot,
                fullProfile.privateParent,
                fullProfile.runtime.plugin.path,
                "freeze",
              ],
              {
                stdout: Bun.file(join(root, mode, "fault.json")),
                stderr: Bun.file(join(root, mode, "fault.stderr")),
                timeout: 55000,
              },
            )
          : undefined;
      const applyFault = mode.startsWith("apply-") && forced === undefined ? await fault(mode) : undefined;
      try {
        const execution = executeApply(runId);
        if (forced !== undefined) {
          if ((await forced.exited) !== 0) throw new Error("Force cancellation did not reach a stopped native RPC");
          const { cancelRunExecution } = await import("../../../src/worker");
          cancelRunExecution(runId, true);
        }
        await execution;
      } catch (error) {
        if (!["apply-crash", "apply-cancel", "apply-force", "saved-tamper", "stale-policy"].includes(mode)) throw error;
        await writeFile(join(root, mode, "failure.txt"), String(error), { mode: 0o600 });
      }
      await verifyFault(applyFault);
      const applied = await db.query.runs.findFirst({ where: eq(s.runs.id, runId) });
      const state = await db.query.stateVersions.findFirst({ where: eq(s.stateVersions.workspaceId, workspaceId) });
      if (["saved-tamper", "stale-policy"].includes(mode)) {
        if (applied?.status !== "errored")
          throw new Error(`Changed admission authorized hosted apply: ${applied?.status}`);
        await noManagedState(workspaceId);
      } else if (mode.startsWith("apply-")) {
        if (applied?.status !== "errored" || state === undefined)
          throw new Error(`Hosted post-apply failure status: ${applied?.status}`);
        const messages = await db.query.logs.findMany({ where: eq(s.logs.runId, runId) });
        if (!messages.some((row) => row.phase === "apply" && row.outputText.includes("no rollback occurred")))
          throw new Error("Hosted native apply failure omitted the post-mutation warning");
        const { decryptStatePayload } = await import("../../../src/lib/validation");
        const actual = JSON.parse(decryptStatePayload(state.statePayload ?? ""));
        const instances = (actual.resources ?? []).flatMap(
          (resource: { instances?: unknown[] }) => resource.instances ?? [],
        );
        if (instances.length !== 200)
          throw new Error(`Hosted post-apply failure retained ${instances.length}/200 instances`);
        await writeFile(
          join(root, mode, "retained-state-summary.json"),
          JSON.stringify({ instances: instances.length, status: applied.status }),
          { mode: 0o600 },
        );
      } else if (applied?.status !== "applied" || state === undefined)
        throw new Error(`Native saved apply failed: ${applied?.status}`);
    }
    await recordCase(mode, runId);
  }
} finally {
  await server.stop(true);
}
console.log(JSON.stringify({ hostedWorkerCasesPassed: rows.length }));
process.exit(0);
