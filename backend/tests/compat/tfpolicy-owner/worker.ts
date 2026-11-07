// Opt-in local acceptance using the production worker, API, and operator binary.
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
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
};
await db.insert(s.adminTfpolicyVersions).values({
  id: `tfp-${crypto.randomUUID()}`,
  version: "0.5.0",
  archs: [{ os: "linux", arch: "amd64", url: "https://example.invalid/operator.zip", sha: profile.catalogSha256 }],
});
const rows: Record<string, unknown>[] = [];
try {
  for (const mode of ["allow", "deny", "override", "legacy"]) {
    const id = crypto.randomUUID(),
      workspaceId = `ws-${id}`,
      runId = `run-${id}`,
      setId = `polset-${id}`,
      cvId = `cv-${id}`;
    const config = join(root, mode, "config"),
      policy = join(root, mode, "policy");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await mkdir(policy, { recursive: true, mode: 0o700 });
    await writeFile(join(config, "main.tf"), 'resource "terraform_data" "proof" { input = "local-only" }\n', {
      mode: 0o600,
    });
    await writeFile(
      join(policy, "proof.policy.hcl"),
      `policy {\n required_providers {\n terraform = { source = "terraform.io/builtin/terraform" }\n }\n}\nresource_policy "terraform_data" "proof" {\n enforcement_level = "${mode === "override" ? "mandatory_overridable" : "mandatory"}"\n enforce {\n condition = attrs.input == "${["allow", "legacy"].includes(mode) ? "local-only" : "forbidden"}"\n error_message = "worker acceptance denial"\n }\n}\n`,
      { mode: 0o600 },
    );
    const archives = [join(root, mode, "config.tar.gz"), join(root, mode, "policy.tar.gz")];
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
      .values({ id: setId, orgId, name: `worker-${mode}`, kind: "tfpolicy", policyToolVersion: "0.5.0" });
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
      savePlan: true,
      createdAt: Date.now(),
    });
    await executeRun(runId);
    const planned = await db.query.runs.findFirst({ where: eq(s.runs.id, runId) });
    const checks = await db.query.policyChecks.findMany({ where: eq(s.policyChecks.runId, runId) });
    await writeFile(join(root, mode, "checks.json"), JSON.stringify(checks, null, 2), { mode: 0o600 });
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
      await db.update(s.runs).set({ status: "confirmed" }).where(eq(s.runs.id, runId));
      await executeApply(runId);
      const applied = await db.query.runs.findFirst({ where: eq(s.runs.id, runId) });
      const state = await db.query.stateVersions.findFirst({ where: eq(s.stateVersions.workspaceId, workspaceId) });
      if (applied?.status !== "applied" || state === undefined)
        throw new Error(`Native saved apply failed: ${applied?.status}`);
    }
    rows.push({ mode, passed: true, runId });
    await writeFile(join(root, "summary.json"), JSON.stringify({ hostedWorkerCases: rows }), { mode: 0o600 });
  }
} finally {
  await server.stop(true);
}
console.log(JSON.stringify({ hostedWorkerCasesPassed: rows.length }));
process.exit(0);
