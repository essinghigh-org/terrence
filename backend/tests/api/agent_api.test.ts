import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function runAgentApiScript(script: string): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-agent-api-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
        STORAGE_DIR: join(testDir, "storage"),
        TEST_DIR: testDir,
        NODE_ENV: "test",
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
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

test("modern agent protocol: register, status, claim, artifacts, completion", async () => {
  const result = await runAgentApiScript(`
    const { createHash } = await import("node:crypto");
    const { join } = await import("path");
    const { writeFile, mkdir } = await import("fs/promises");
    const { and, eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const {
      agentJobs,
      agentPoolTokens,
      agentPools,
      agents,
      configurationVersions,
      logs,
      organizations,
      runs,
      workspaceVariables,
      workspaces,
    } = await import("./src/db/schema.ts");

    const agentToken = "agent-primary-token";
    const userToken = "user-token";
    const base = "http://test.local";

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "apool", orgId: "org", name: "pool", organizationScoped: true, createdAt: Date.now() });
    await db.insert(agentPoolTokens).values({
      id: "atok",
      agentPoolId: "apool",
      token: createHash("sha256").update(agentToken).digest("hex"),
      createdAt: Date.now(),
    });
    await db.insert(workspaces).values({
      id: "ws",
      name: "ws",
      orgId: "org",
      executionMode: "agent",
      agentPoolId: "apool",
      terraformVersion: "1.9.5",
      createdAt: Date.now(),
    });
    await db.insert(workspaceVariables).values({
      id: "wv1",
      workspaceId: "ws",
      key: "OPENCODE_API_KEY",
      value: "secret-key-123",
      category: "terraform",
      createdAt: Date.now(),
    });
    await db.insert(workspaceVariables).values({
      id: "wv2",
      workspaceId: "ws",
      key: "TFE_TOKEN",
      value: "trun-something",
      category: "env",
      createdAt: Date.now(),
    });
    await db.insert(configurationVersions).values({
      id: "cv1",
      workspaceId: "ws",
      status: "uploaded",
      createdAt: Date.now(),
    });
    await db.insert(runs).values({
      id: "run1",
      planId: "run1",
      workspaceId: "ws",
      configurationVersionId: "cv1",
      agentPoolId: "apool",
      status: "plan_queued",
      autoApply: false,
      createdAt: Date.now(),
    });
    await db.insert(agentJobs).values({
      id: "ajob1",
      runId: "run1",
      agentPoolId: "apool",
      phase: "plan",
      status: "queued",
      createdAt: Date.now(),
    });

    const out: Record<string, unknown> = {};

    // register (new agent)
    let res = await app.fetch(new Request(\`\${base}/api/agent/register\`, {
      method: "POST",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-version": "1.30.1", "content-type": "application/json" },
      body: JSON.stringify({ name: "hermes-test", arch: "amd64", os: "linux" }),
    }));
    out.registerStatus = res.status;
    const reg = await res.json();
    out.agentId = reg.id;
    out.agentPoolId = reg.agent_pool_id;

    // register again with same name -> upsert, same id
    res = await app.fetch(new Request(\`\${base}/api/agent/register\`, {
      method: "POST",
      headers: { authorization: \`Bearer \${agentToken}\`, "content-type": "application/json" },
      body: JSON.stringify({ name: "hermes-test", arch: "amd64", os: "linux" }),
    }));
    const reg2 = await res.json();
    out.upsertSameId = reg2.id === reg.id;

    // register with bad iac-binaries -> 422
    res = await app.fetch(new Request(\`\${base}/api/agent/register\`, {
      method: "POST",
      headers: { authorization: \`Bearer \${agentToken}\`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-cap", iac_binaries: ["ansible"] }),
    }));
    out.badIacStatus = res.status;

    // register with bad token -> 401
    res = await app.fetch(new Request(\`\${base}/api/agent/register\`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    }));
    out.badTokenStatus = res.status;

    // status idle (echoes message index)
    res = await app.fetch(new Request(\`\${base}/api/agent/status\`, {
      method: "PUT",
      headers: {
        authorization: \`Bearer \${agentToken}\`,
        "tfc-agent-id": reg.id,
        "tfc-agent-message-index": "7",
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "idle" }),
    }));
    out.statusStatus = res.status;
    out.statusEchoedIndex = res.headers.get("tfc-agent-message-index");
    const agentRow = await db.query.agents.findFirst({ where: eq(agents.id, reg.id) });
    out.agentStatusAfterIdle = agentRow.status;

    // claim the plan job
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-accept": "plan,apply" },
    }));
    out.claimStatus = res.status;
    const job = await res.json();
    out.jobType = job.type;
    out.jobId = job.job_id;
    out.operation = job.data.operation;
    out.runId = job.data.run_id;
    out.iacBinary = job.data.iac_binary;
    out.workspaceName = job.data.workspace_name;
    out.organizationName = job.data.organization_name;
    out.workingDirectory = job.data.working_directory;
    out.tokenStarts = String(job.data.token).startsWith("trun_");
    out.timeout = job.data.timeout;
    out.hasConfigurationUrl = String(job.data.configuration_version_url).includes("/api/agent/jobs/ajob1/configuration-version");
    out.hasFilesystemUrl = String(job.data.filesystem_url).includes("/api/agent/jobs/ajob1/filesystem");
    out.hasLogUrl = String(job.data.terraform_log_url).includes("/api/agent/jobs/ajob1/log");
    out.planCurrentOperation = job.plan.current_operation;
    out.planTerraformVersion = job.plan.terraform_version;
    out.planVariables = JSON.stringify(job.plan.variables);
    out.environment = JSON.stringify(job.data.environment);
    out.hasPlanJsonUrl = String(job.data.json_plan_url).includes("/api/agent/jobs/ajob1/plan-json");

    // Embedded artifact URLs are bearerless but must carry a valid signature.
    res = await app.fetch(new Request(String(job.data.json_plan_url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed: true }),
    }));
    out.signedArtifactStatus = res.status;

    // re-claim returns the same claimed job (idempotent re-claim)
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-accept": "plan,apply" },
    }));
    out.secondClaimStatus = res.status;
    out.secondClaimJobId = (await res.json()).job_id;

    // run is now planning
    const runAfterClaim = await db.query.runs.findFirst({ where: eq(runs.id, "run1") });
    out.runStatusAfterClaim = runAfterClaim.status;

    // Invalid or absent credentials are rejected; a claimed job is not itself
    // a bearer credential.
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/plan-json\`, {
      method: "PUT",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: JSON.stringify({ format_version: "1.2", planned_values: {} }),
    }));
    out.artifactUnauthStatus = res.status;

    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/plan-json\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "content-type": "application/json" },
      body: JSON.stringify({
        format_version: "1.2",
        planned_values: { outputs: {} },
        resource_changes: [{ address: "null_resource.x", type: "null_resource", change: { actions: ["create"] } }],
      }),
    }));
    out.planJsonPutStatus = res.status;

    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/plan-json-redacted\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "content-type": "application/json" },
      body: JSON.stringify({ redacted: true }),
    }));
    out.redactedPutStatus = res.status;

    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/provider-schemas\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "content-type": "application/json" },
      body: JSON.stringify({ "registry.terraform.io/hashicorp/null": {} }),
    }));
    out.schemasPutStatus = res.status;

    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/log\`, {
      method: "PATCH",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "content-type": "application/json" },
      body: "\\u001b[1m\\u001b[32mTerraform v1.9.5\\u001b[0m\\nInitializing...\\n\\u001b[33mWarning: deprecated\\u001b[0m",
    }));
    out.logPatchStatus = res.status;
    const storedLog = await db.query.logs.findFirst({ where: eq(logs.runId, "run1") });
    out.logStoredText = storedLog?.outputText ?? "";

    // configuration version download (no archive file yet -> 404)
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/configuration-version\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id },
    }));
    out.configVersionStatus = res.status;

    // write a VCS-style archive (single top-level repo dir), then it serves
    // flattened (repo dir stripped)
    const cvDir = join(process.env.TEST_DIR, "storage", "cv");
    await mkdir(cvDir, { recursive: true });
    const vcsDir = join(process.env.TEST_DIR, "vcs-repo");
    await mkdir(join(vcsDir, "my-repo-abc123"), { recursive: true });
    await writeFile(join(vcsDir, "my-repo-abc123", "main.tf"), 'output "x" { value = "1" }');
    const archiveProc = Bun.spawnSync(["tar", "-czf", join(cvDir, "config-cv1.tar.gz"), "-C", vcsDir, "."]);
    if (archiveProc.exitCode !== 0) throw new Error("tar failed");
    await db.update(configurationVersions)
      .set({ archivePath: join(cvDir, "config-cv1.tar.gz") })
      .where(eq(configurationVersions.id, "cv1"));
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/configuration-version\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id },
    }));
    out.configVersionServedStatus = res.status;
    const flattenedDir = join(process.env.TEST_DIR, "flattened-check");
    await mkdir(flattenedDir, { recursive: true });
    await writeFile(join(process.env.TEST_DIR, "served-archive.tar.gz"), Buffer.from(await res.arrayBuffer()));
    const listProc = Bun.spawnSync(["tar", "-tzf", join(process.env.TEST_DIR, "served-archive.tar.gz")]);
    out.configVersionMembers = listProc.stdout.toString();

    // filesystem round-trip
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/filesystem\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "content-type": "application/gzip" },
      body: "fs-archive-bytes",
    }));
    out.fsPutStatus = res.status;
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/filesystem\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id },
    }));
    out.fsGetStatus = res.status;
    out.fsGetBytes = await res.text();

    // completion: finished -> run planned
    res = await app.fetch(new Request(\`\${base}/api/agent/status\`, {
      method: "PUT",
      headers: {
        authorization: \`Bearer \${agentToken}\`,
        "tfc-agent-id": reg.id,
        "tfc-agent-message-index": "8",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "idle",
        job: { type: "plan", status: "finished", data: { generated_configuration: false, has_changes: true, operation: "plan", run_id: "run1", run_type: "plan" } },
      }),
    }));
    out.completeStatus = res.status;
    const runAfterComplete = await db.query.runs.findFirst({ where: eq(runs.id, "run1") });
    out.runStatusAfterComplete = runAfterComplete.status;
    out.runHasChanges = runAfterComplete.planResourceChanges !== null;
    const jobAfterComplete = await db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "ajob1") });
    out.jobStatusAfterComplete = jobAfterComplete.status;

    console.log(JSON.stringify(out));
    process.exit(0);
  `);

  expect(result.registerStatus).toBe(200);
  expect(result.badIacStatus).toBe(422);
  expect(result.agentId).toContain("agent-");
  expect(result.agentPoolId).toBe("apool");
  expect(result.upsertSameId).toBe(true);
  expect(result.badTokenStatus).toBe(401);
  expect(result.statusStatus).toBe(200);
  expect(result.statusEchoedIndex).toBe("7");
  expect(result.agentStatusAfterIdle).toBe("idle");
  expect(result.claimStatus).toBe(200);
  expect(result.jobType).toBe("plan");
  expect(result.jobId).toBe("ajob1");
  expect(result.operation).toBe("plan");
  expect(result.iacBinary).toBe("terraform");
  expect(result.runId).toBe("run1");
  expect(result.workspaceName).toBe("ws");
  expect(result.organizationName).toBe("org");
  expect(result.workingDirectory).toBe("");
  expect(result.tokenStarts).toBe(true);
  expect(result.timeout).toBe("1h");
  expect(result.hasConfigurationUrl).toBe(true);
  expect(result.hasFilesystemUrl).toBe(true);
  expect(result.hasLogUrl).toBe(true);
  expect(result.planCurrentOperation).toBe("plan");
  expect(result.planTerraformVersion).toBe("1.9.5");
  expect(result.planVariables).toBe("{}");
  expect(result.environment).toContain("\"TF_VAR_OPENCODE_API_KEY\":\"secret-key-123\"");
  expect(result.environment).toContain("\"TFE_TOKEN\":\"trun-something\"");
  expect(result.hasPlanJsonUrl).toBe(true);
  expect(result.secondClaimStatus).toBe(200);
  expect(result.secondClaimJobId).toBe("ajob1");
  expect(result.runStatusAfterClaim).toBe("planning");
  expect(result.signedArtifactStatus).toBe(200);
  expect(result.artifactUnauthStatus).toBe(401);
  expect(result.planJsonPutStatus).toBe(200);
  expect(result.redactedPutStatus).toBe(200);
  expect(result.schemasPutStatus).toBe(200);
  expect(result.logPatchStatus).toBe(200);
  expect(result.logStoredText).toBe("Terraform v1.9.5\nInitializing...\nWarning: deprecated");
  expect(result.completeStatus).toBe(200);
  expect(result.runStatusAfterComplete).toBe("planned");
  expect(result.runHasChanges).toBe(true);
  expect(result.jobStatusAfterComplete).toBe("completed");
  expect(result.configVersionStatus).toBe(404);
  expect(result.configVersionServedStatus).toBe(200);
  expect(result.configVersionMembers).toContain("./main.tf");
  expect(result.configVersionMembers).not.toContain("my-repo-abc123/");
  expect(result.fsPutStatus).toBe(200);
  expect(result.fsGetStatus).toBe(200);
  expect(result.fsGetBytes).toBe("fs-archive-bytes");
}, 30000);

test("modern agent protocol: errored completion and apply job payload", async () => {
  const result = await runAgentApiScript(`
    const { createHash } = await import("node:crypto");
    const { and, eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const {
      agentJobs,
      agentPoolTokens,
      agentPools,
      agents,
      organizations,
      runs,
      workspaceVariables,
      workspaces,
    } = await import("./src/db/schema.ts");

    const agentToken = "agent-primary-token";
    const base = "http://test.local";

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "apool", orgId: "org", name: "pool", organizationScoped: true, createdAt: Date.now() });
    await db.insert(agentPoolTokens).values({ id: "atok", agentPoolId: "apool", token: createHash("sha256").update(agentToken).digest("hex"), createdAt: Date.now() });
    await db.insert(workspaces).values({ id: "ws", name: "ws", orgId: "org", executionMode: "agent", agentPoolId: "apool", terraformVersion: "1.9.5", createdAt: Date.now() });
    await db.insert(runs).values({ id: "run1", planId: "run1", workspaceId: "ws", agentPoolId: "apool", status: "plan_queued", autoApply: false, createdAt: Date.now() });
    await db.insert(agentJobs).values({ id: "ajob1", runId: "run1", agentPoolId: "apool", phase: "plan", status: "queued", createdAt: Date.now() });

    const out: Record<string, unknown> = {};

    let res = await app.fetch(new Request(\`\${base}/api/agent/register\`, {
      method: "POST",
      headers: { authorization: \`Bearer \${agentToken}\`, "content-type": "application/json" },
      body: JSON.stringify({ name: "hermes-test", arch: "amd64", os: "linux" }),
    }));
    const reg = await res.json();

    res = await app.fetch(new Request(\`\${base}/api/agent/jobs\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-accept": "plan,apply" },
    }));
    const job = await res.json();
    out.applyContainerAbsent = job.apply === undefined;
    out.planContainerPresent = job.plan !== undefined;

    // errored completion -> run errored
    res = await app.fetch(new Request(\`\${base}/api/agent/status\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "content-type": "application/json" },
      body: JSON.stringify({
        status: "idle",
        job: { type: "plan", status: "errored", error: "failed running terraform plan (exit 1)", data: { operation: "plan", run_id: "run1", run_type: "plan" } },
      }),
    }));
    out.erroredStatus = res.status;
    const run = await db.query.runs.findFirst({ where: eq(runs.id, "run1") });
    out.runStatusAfterError = run.status;
    const jobRow = await db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "ajob1") });
    out.jobStatusAfterError = jobRow.status;
    out.jobError = jobRow.errorMessage;

    console.log(JSON.stringify(out));
    process.exit(0);
  `);

  expect(result.applyContainerAbsent).toBe(true);
  expect(result.planContainerPresent).toBe(true);
  expect(result.erroredStatus).toBe(200);
  expect(result.runStatusAfterError).toBe("errored");
  expect(result.jobStatusAfterError).toBe("errored");
  expect(result.jobError).toContain("failed running terraform plan");
}, 30000);
