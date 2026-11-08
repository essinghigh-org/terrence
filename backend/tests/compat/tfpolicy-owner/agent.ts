// Opt-in acceptance against the real API and terrence-agent executable.
import { appendFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { retainsNativeApplyRecovery, type NativeApplyJournalEntry } from "./agent-recovery";

const root = resolve(process.argv[2] ?? ""),
  binary = resolve(process.argv[3] ?? ""),
  agentRunner = resolve(process.argv[4] ?? "");
if ((await stat(root)).mode % 0o1000 !== 0o700 || process.env["DATABASE_URL"] !== `file:${join(root, "test.db")}`)
  throw new Error("A private isolated acceptance database is required");
const profilePath = process.env["TERRENCE_TFPOLICY_RUNTIME_PROFILE"] ?? "";
const profile = await Bun.file(profilePath).json();
let ready = false;
const server = Bun.serve({
  hostname: "::1",
  port: 0,
  tls: { key: Bun.file(join(root, "server.key")), cert: Bun.file(join(root, "server.crt")) },
  fetch: (request: Request) => (ready ? handler(request) : new Response(null, { status: 503 })),
});
process.env["PUBLIC_URL"] = `https://localhost.localdomain:${server.port}`;
const [{ app }, { db }, s, { hashAuthenticationToken }] = await Promise.all([
  import("../../../src/app"),
  import("../../../src/db"),
  import("../../../src/db/schema"),
  import("../../../src/lib/token-service"),
]);
const nativeKeys = new Map<string, string>();
let rejectedArtifacts = 0,
  rejectedManifests = 0;
async function rejectTamperedArtifacts(request: Request): Promise<void> {
  const artifact = (await request.clone().json()) as Record<string, unknown>;
  const receipt = artifact["receipt"] as { payload: string; mac: string };
  const key = nativeKeys.get(new URL(request.url).pathname.replace(/native-result$/, "native-policy"));
  if (key === undefined) throw new Error("Missing private manifest key in acceptance control plane");
  const mutated = [
    { ...artifact, planJson: "{}" },
    { ...artifact, receipt: { ...receipt, mac: "0".repeat(64) } },
  ];
  for (const [field, value] of [
    ["executionId", "another-job:999:plan"],
    ["runtimeSha256", "0".repeat(64)],
    ["policySnapshotSha256", "0".repeat(64)],
  ]) {
    const payload = JSON.parse(Buffer.from(receipt.payload, "base64url").toString("utf8"));
    payload[field ?? ""] = value;
    const bytes = Buffer.from(JSON.stringify(payload));
    mutated.push({
      ...artifact,
      receipt: {
        payload: bytes.toString("base64url"),
        mac: createHmac("sha256", Buffer.from(key, "hex")).update(bytes).digest("hex"),
      },
    });
  }
  for (const value of mutated) {
    const response = await app.handle(
      new Request(request.url, { method: "PUT", headers: request.headers, body: JSON.stringify(value) }),
    );
    if (response.status !== 422) throw new Error("Tampered native agent artifact was accepted");
    rejectedArtifacts += 1;
  }
}

const handler = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (
    !path.startsWith("/api/agent/") &&
    (request.method !== "GET" ||
      (!["/.well-known/terraform.json", "/api/v2/ping"].includes(path) &&
        !/^\/api\/v2\/organizations\/native-agent-[a-f0-9-]+\/entitlement-set$/.test(path)))
  )
    return new Response(null, { status: 403 });
  if (path.endsWith("/native-result") && request.method === "PUT") await rejectTamperedArtifacts(request);
  if (path.endsWith("/native-policy") && request.method === "GET") {
    const unsigned = await app.handle(new Request(request.url));
    const stale = new URL(request.url);
    stale.searchParams.set("fencing_token", "999999");
    const oldLease = await app.handle(new Request(stale, { headers: request.headers }));
    if (unsigned.status !== 401 || oldLease.status !== 401)
      throw new Error("Native manifest escaped authenticated agent/lease scope");
    rejectedManifests += 2;
  }
  const response = await app.handle(request);
  if (path.endsWith("/native-policy") && response.ok) {
    const manifest = (await response.clone().json()) as { receiptKey: string };
    nativeKeys.set(path, manifest.receiptKey);
  }
  await appendFile(
    join(root, "requests.jsonl"),
    JSON.stringify({ path, method: request.method, status: response.status }) + "\n",
    { mode: 0o600 },
  );
  return response;
};
const orgId = `org-${crypto.randomUUID()}`,
  poolId = `apool-${crypto.randomUUID()}`,
  token = `agent-${crypto.randomUUID()}`;
await db.insert(s.organizations).values({
  id: orgId,
  name: `native-agent-${crypto.randomUUID()}`,
  defaultIacBinary: "terraform",
  defaultTerraformVersion: "1.17.1",
});
await db.insert(s.agentPools).values({ id: poolId, orgId, name: "native-acceptance", organizationScoped: true });
await db.insert(s.agentPoolTokens).values({
  id: `atok-${crypto.randomUUID()}`,
  agentPoolId: poolId,
  token: hashAuthenticationToken(token),
  createdAt: Date.now(),
});
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
ready = true;
const rows: Record<string, unknown>[] = [];
async function agent(mode: string, phase: string): Promise<void> {
  const data = join(root, mode, `agent-${phase}`);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const fault =
    phase === "apply" && mode.startsWith("apply-")
      ? Bun.spawn(
          [
            "python3",
            "-I",
            resolve(import.meta.dir, "../../../../tools/tfpolicy-supervisor/integration/agent-fault.py"),
            profile.cgroupRoot,
            profile.privateParent,
            mode === "apply-crash" ? profile.runtime.plugin.path : profile.owner.path,
            mode === "apply-crash" ? "crash" : "cancel",
          ],
          {
            stdout: Bun.file(join(root, mode, "fault.json")),
            stderr: Bun.file(join(root, mode, "fault.stderr")),
            timeout: 55000,
          },
        )
      : undefined;
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: data,
    TERRENCE_ADDRESS: `https://localhost.localdomain:${server.port}`,
    TERRENCE_AGENT_TOKEN: token,
    TERRENCE_AGENT_DATA_DIR: data,
    TERRENCE_AGENT_NAME: `${mode}-${phase}`,
    TERRENCE_AGENT_SINGLE: "true",
    TERRENCE_AGENT_ACCEPT: phase === "replan" ? "plan" : phase,
    TERRENCE_AGENT_CHECK_INTERVAL_MS: "250",
    TERRENCE_AGENT_SANDBOX: "true",
    TERRENCE_LANDLOCK_RUNNER: agentRunner,
    TERRENCE_AGENT_NATIVE_POLICY_PROFILE: profilePath,
    TERRENCE_ALLOW_PRIVATE_ARTIFACTS: "true",
  };
  const process = Bun.spawn([binary], {
    env: environment,
    stdout: Bun.file(join(root, mode, `${phase}.stdout`)),
    stderr: Bun.file(join(root, mode, `${phase}.stderr`)),
    timeout: 60000,
  });
  const death =
    mode === "agent-death" && phase === "apply"
      ? Bun.spawn(
          [
            "python3",
            "-I",
            resolve(import.meta.dir, "../../../../tools/tfpolicy-supervisor/integration/agent-fault.py"),
            profile.cgroupRoot,
            profile.privateParent,
            profile.runtime.plugin.path,
            "parent-death",
            "--parent-pid",
            String(process.pid),
            "--parent-exe",
            await realpath(binary),
          ],
          {
            stdout: Bun.file(join(root, mode, "fault.json")),
            stderr: Bun.file(join(root, mode, "fault.stderr")),
            timeout: 55000,
          },
        )
      : undefined;
  const code = await process.exited;
  if (death !== undefined) {
    if (code === 0 || (await death.exited) !== 0) throw new Error("Agent death did not interrupt a stopped native RPC");
    let empty = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const scopes = (await readdir(profile.cgroupRoot)).filter((name) => /^agent-[a-f0-9]+$/.test(name));
      const events = await Promise.all(
        scopes.map((name) => readFile(join(profile.cgroupRoot, name, "cgroup.events"), "utf8")),
      );
      if (events.every((text) => text.includes("populated 0"))) {
        empty = true;
        break;
      }
      await Bun.sleep(100);
    }
    if (!empty) throw new Error("Native execution outlived its dead agent");
    const originalEntries: NativeApplyJournalEntry[] = await Promise.all(
      (await readdir(join(data, "journal")))
        .filter((name) => name.endsWith(".json"))
        .map((name) => Bun.file(join(data, "journal", name)).json()),
    );
    const original = originalEntries.find(
      (entry) => entry.state === "executing" && entry.manifest.native_policy && entry.manifest.phase === "apply",
    )?.manifest;
    if (
      original === undefined ||
      typeof original.work_dir !== "string" ||
      !Number.isSafeInteger(original.fencing_token) ||
      original.fencing_token < 1
    )
      throw new Error("Killed native apply did not retain its original execution identity");
    const restarted = Bun.spawn([binary], {
      env: environment,
      stdout: Bun.file(join(root, mode, "restart.stdout")),
      stderr: Bun.file(join(root, mode, "restart.stderr")),
      timeout: 45000,
    });
    let retained = false;
    try {
      for (let attempt = 0; attempt < 800; attempt++) {
        const entries = await Promise.all(
          (await readdir(join(data, "journal")))
            .filter((name) => name.endsWith(".json"))
            .map((name) => Bun.file(join(data, "journal", name)).json()),
        );
        // Missing state receives an explicit stale-lease rejection. The agent
        // durably quarantines that completion; pending may last less than a poll.
        if (entries.some((entry) => retainsNativeApplyRecovery(entry, original))) {
          if (!(await stat(original.work_dir)).isDirectory())
            throw new Error("Agent restart removed its retained recovery directory");
          retained = true;
          break;
        }
        await Bun.sleep(50);
      }
    } finally {
      restarted.kill("SIGTERM");
      await restarted.exited;
    }
    if (!retained) throw new Error("Agent restart lost its durable recovery directory or warning");
  } else if (code !== 0) throw new Error(`Native agent ${mode}/${phase} failed; see private acceptance logs`);
  if (fault !== undefined && (await fault.exited) !== 0) throw new Error("Native apply interruption was not exercised");
}
async function queue(runId: string, workspaceId: string, cvId: string, phase: string): Promise<void> {
  if (phase === "plan")
    await db.insert(s.runs).values({
      id: runId,
      workspaceId,
      configurationVersionId: cvId,
      agentPoolId: poolId,
      status: "plan_queued",
      terraformVersion: "1.17.1",
      savePlan: true,
      createdAt: Date.now(),
    });
  else await db.update(s.runs).set({ status: "apply_queued" }).where(eq(s.runs.id, runId));
  await db.insert(s.agentJobs).values({
    id: `ajob-${crypto.randomUUID()}`,
    runId,
    agentPoolId: poolId,
    phase,
    status: "queued",
    createdAt: Date.now(),
  });
}
try {
  const modes = ["allow", "deny", "override", "apply-crash", "apply-cancel", "agent-death"];
  const selected = process.argv[5]?.split(",") ?? modes;
  if (selected.some((mode) => !modes.includes(mode))) throw new Error("Unknown native agent acceptance case");
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
    const configuration =
      mode.startsWith("apply-") || mode === "agent-death"
        ? 'resource "terraform_data" "proof" {\n count = 200\n input = "local-only"\n}\n'
        : 'resource "terraform_data" "proof" { input = "local-only" }\n';
    await writeFile(join(config, "main.tf"), configuration, { mode: 0o600 });
    await writeFile(
      join(policy, "proof.policy.hcl"),
      `policy {\n required_providers {\n terraform = { source = "terraform.io/builtin/terraform" }\n }\n}\nresource_policy "terraform_data" "proof" {\n enforcement_level = "${mode === "override" ? "mandatory_overridable" : "mandatory"}"\n enforce {\n condition = attrs.input == "${mode === "allow" || mode.startsWith("apply-") || mode === "agent-death" ? "local-only" : "forbidden"}"\n error_message = "agent acceptance denial"\n }\n}\nprovider_policy "terraform" "source" {\n enforce {\n condition = meta.source == "terraform.io/builtin/terraform"\n }\n}\n`,
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
      name: `agent-${mode}`,
      iacBinary: "terraform",
      terraformVersion: "1.17.1",
      executionMode: "agent",
      agentPoolId: poolId,
      autoApply: false,
    });
    await db
      .insert(s.configurationVersions)
      .values({ id: cvId, workspaceId, status: "uploaded", archivePath: archives[0] });
    await db
      .insert(s.policySets)
      .values({ id: setId, orgId, name: `agent-${mode}`, kind: "tfpolicy", policyToolVersion: profile.pluginVersion });
    await db.insert(s.policySetWorkspaces).values({ id: `psw-${id}`, policySetId: setId, workspaceId });
    await db
      .insert(s.policySetVersions)
      .values({ id: `psv-${id}`, policySetId: setId, status: "ready", archivePath: archives[1] });
    await queue(runId, workspaceId, cvId, "plan");
    await agent(mode, "plan");
    const planned = await db.query.runs.findFirst({ where: eq(s.runs.id, runId) }),
      checks = await db.query.policyChecks.findMany({ where: eq(s.policyChecks.runId, runId) });
    await writeFile(join(root, mode, "checks.json"), JSON.stringify(checks, null, 2), { mode: 0o600 });
    const expected = mode === "deny" ? "errored" : mode === "override" ? "policy_soft_failed" : "planned_and_saved";
    if (planned?.status !== expected)
      throw new Error(`Native agent ${mode} plan: ${planned?.status}, expected ${expected}`);
    if (!checks.some((c) => c.result?.["native"] === true)) throw new Error("Native agent checks were not persisted");
    if (mode === "override") {
      const { overridableWorkspacePolicyChecks } = await import("../../../src/lib/workspace-policy-gate");
      const targets = await overridableWorkspacePolicyChecks(db, { id: workspaceId, orgId }, runId);
      if (targets.length !== 1) throw new Error("Native agent override missing");
      for (const check of targets)
        await db
          .update(s.policyChecks)
          .set({
            status: "overridden",
            result: { ...check.result, overrideEvaluationId: check.result?.["policyEvaluationId"] },
          })
          .where(eq(s.policyChecks.id, check.id));
    }
    if (mode !== "deny") {
      await queue(runId, workspaceId, cvId, "apply");
      await agent(mode, "apply");
      if (mode === "agent-death") {
        const job = await db.query.agentJobs.findFirst({
          where: eq(s.agentJobs.runId, runId),
          orderBy: (rows, { desc }) => [desc(rows.createdAt)],
        });
        if (job?.phase !== "apply" || job.agentId === null) throw new Error("Missing interrupted native apply lease");
        const directory = join(root, mode, "agent-apply", "journal");
        const entries = await Promise.all(
          (await readdir(directory))
            .filter((name) => name.endsWith(".json"))
            .map((name) => Bun.file(join(directory, name)).json()),
        );
        const entry = entries.find((entry) => entry.manifest.job_id === job.id);
        if (typeof entry?.manifest.work_dir !== "string")
          throw new Error("Native apply directory was not durable before process death");
        const state = await readFile(join(entry.manifest.work_dir, "terraform.tfstate"), "utf8");
        const { recoverStaleAgentJobs } = await import("../../../src/lib/agent-jobs");
        await recoverStaleAgentJobs(Date.now() + 120000);
        const held = await db.query.agentJobs.findFirst({ where: eq(s.agentJobs.id, job.id) });
        const workspace = await db.query.workspaces.findFirst({ where: eq(s.workspaces.id, workspaceId) });
        if (
          held?.status !== "errored" ||
          held.result?.["nativeRecoveryRequired"] !== true ||
          workspace?.locked !== true
        )
          throw new Error("Lost native apply lease was requeued or unlocked before state recovery");
        const recovered = await app.handle(
          new Request(`${process.env["PUBLIC_URL"]}/api/agent/status`, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${token}`,
              "tfc-agent-id": job.agentId,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              status: "idle",
              job: {
                status: "errored",
                error: "Manual recovery after agent process death; no rollback occurred",
                data: {
                  run_id: runId,
                  operation: "apply",
                  fencing_token: job.fencingToken,
                  state,
                  state_recovered: true,
                  state_recovery_required: false,
                },
              },
            }),
          }),
        );
        if (recovered.status !== 200) throw new Error(`Manual state recovery failed: ${recovered.status}`);
        const released = await db.query.workspaces.findFirst({ where: eq(s.workspaces.id, workspaceId) });
        if (released?.locked !== false) throw new Error("State recovery did not release the held native workspace");
      }
      const applied = await db.query.runs.findFirst({ where: eq(s.runs.id, runId) }),
        state = await db.query.stateVersions.findFirst({ where: eq(s.stateVersions.workspaceId, workspaceId) });
      if (
        applied?.status !== (mode.startsWith("apply-") || mode === "agent-death" ? "errored" : "applied") ||
        state === undefined
      )
        throw new Error(`Native agent saved apply: ${applied?.status}`);
      if (mode.startsWith("apply-") || mode === "agent-death") {
        const { decryptStatePayload } = await import("../../../src/lib/validation");
        const actual = JSON.parse(decryptStatePayload(state.statePayload ?? ""));
        const instances = (actual.resources ?? []).flatMap(
          (resource: { instances?: unknown[] }) => resource.instances ?? [],
        );
        if (instances.length !== 200)
          throw new Error("Native post-apply failure did not preserve all 200 managed resources");
        await writeFile(
          join(root, mode, "retained-state-summary.json"),
          JSON.stringify({ instances: instances.length, status: applied.status }),
          { mode: 0o600 },
        );
      }
      if (mode === "allow") {
        const followup = `run-${crypto.randomUUID()}`;
        await queue(followup, workspaceId, cvId, "plan");
        await agent(mode, "replan");
        const replay = await db.query.runs.findFirst({ where: eq(s.runs.id, followup) });
        if (replay?.planResourceAdditions !== 0 || replay.status !== "planned_and_saved")
          throw new Error("Native agent did not reuse authoritative workspace state");
      }
    }
    rows.push({ mode, passed: true, runId });
    await writeFile(join(root, "summary.json"), JSON.stringify({ nativeAgentCases: rows }), { mode: 0o600 });
  }
  const requests = (await readFile(join(root, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (!requests.some((r) => r.path.endsWith("/native-result") && r.method === "PUT" && r.status === 200))
    throw new Error("Native proof did not reach the authenticated API");
  console.log(JSON.stringify({ nativeAgentCasesPassed: rows.length, rejectedArtifacts, rejectedManifests }));
} finally {
  await server.stop(true);
}
process.exit(0);
