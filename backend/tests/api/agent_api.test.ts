import { expect, test } from "bun:test";
import { chmod, readdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function thawTestDirectories(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await thawTestDirectories(join(path, entry.name));
  }
}

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
    await thawTestDirectories(testDir);
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
    const { agentApiBaseUrl } = await import("./src/lib/agent-api.ts");
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

    let res = await app.fetch(new Request(base + "/api/agent/protocol"));
    const protocol = await res.json();
    out.protocolStatus = res.status;
    out.protocolVersion = protocol.protocol_version;
    out.protocolHasFencing = protocol.capabilities.includes("lease.fencing");

    const originalPublicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "http://public.example";
    try {
      agentApiBaseUrl({ headers: { get: () => "public.example" } });
      out.insecurePublicUrlRejected = false;
    } catch {
      out.insecurePublicUrlRejected = true;
    }
    process.env.PUBLIC_URL = "https://public.example";
    out.httpsPublicUrl = agentApiBaseUrl({ headers: { get: () => "public.example" } });
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrl;

    // register (new agent)
    res = await app.fetch(new Request(\`\${base}/api/agent/register\`, {
      method: "POST",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-version": "1.30.1", "content-type": "application/json" },
      body: JSON.stringify({ name: "hermes-test", arch: "amd64", os: "linux" }),
    }));
    out.registerStatus = res.status;
    const reg = await res.json();
    out.agentId = reg.id;
    out.agentPoolId = reg.agent_pool_id;
    out.registerProtocolVersion = reg.protocol_version;
    out.registerLegacy = reg.legacy;
    out.registerHasFencing = reg.capabilities.includes("lease.fencing");

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
    const fencingToken = String(job.data.fencing_token);
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
    out.artifactTtlSeconds = Number(new URL(String(job.data.json_plan_url)).searchParams.get("expires")) - Math.floor(Date.now() / 1000);

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
    out.runAgentVersion = runAfterClaim.agentVersion;
    out.runAgentProtocolVersion = runAfterClaim.agentProtocolVersion;
    out.runHasFencing = runAfterClaim.agentCapabilities.includes("lease.fencing");
    out.runPolicyOperation = runAfterClaim.agentExecutionPolicy.operation;

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
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "application/json" },
      body: JSON.stringify({
        format_version: "1.2",
        planned_values: { outputs: {} },
        resource_changes: [{ address: "null_resource.x", type: "null_resource", change: { actions: ["create"] } }],
      }),
    }));
    out.planJsonPutStatus = res.status;

    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/plan-json-redacted\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "application/json" },
      body: JSON.stringify({ redacted: true }),
    }));
    out.redactedPutStatus = res.status;
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/plan-json-redacted\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "text/plain" },
      body: "{broken",
    }));
    out.invalidSideArtifactStatus = res.status;
    out.keptSideArtifact = JSON.parse(await Bun.file(join(process.env.STORAGE_DIR, "plan-json", "run1.redacted.json")).text());


    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/provider-schemas\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "application/json" },
      body: JSON.stringify({ "registry.terraform.io/hashicorp/null": {} }),
    }));
    out.schemasPutStatus = res.status;

    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/log\`, {
      method: "PATCH",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "application/json" },
      body: "\\u001b[1m\\u001b[32mTerraform v1.9.5\\u001b[0m\\nInitializing...\\n\\u001b[33mWarning: deprecated\\u001b[0m",
    }));
    out.logPatchStatus = res.status;
    const storedLog = await db.query.logs.findFirst({ where: eq(logs.runId, "run1") });
    out.logStoredText = storedLog?.outputText ?? "";

    // configuration version download (no archive file yet -> 404)
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/configuration-version\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken },
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
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken },
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
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "application/gzip" },
      body: "fs-archive-bytes",
    }));
    out.fsPutStatus = res.status;
    res = await app.fetch(new Request(\`\${base}/api/agent/jobs/ajob1/filesystem\`, {
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken },
    }));
    out.fsGetStatus = res.status;
    out.fsGetBytes = await res.text();

    const encryptedCompletion = await app.fetch(new Request(base + "/api/agent/status", {
      method: "PUT",
      headers: { authorization: "Bearer " + agentToken, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "application/json" },
      body: JSON.stringify({ status: "idle", job: { status: "finished", data: { operation: "plan", run_id: "run1", state: JSON.stringify({ encryption_version: "v0", encrypted_data: "synthetic" }) } } }),
    }));
    out.encryptedCompletion = encryptedCompletion.status;
    out.jobAfterEncrypted = (await db.query.agentJobs.findFirst({ where: eq(agentJobs.id, "ajob1") })).status;

    // completion: finished -> run planned
    res = await app.fetch(new Request(\`\${base}/api/agent/status\`, {
      method: "PUT",
      headers: {
        authorization: \`Bearer \${agentToken}\`,
        "tfc-agent-id": reg.id,
        "tfc-agent-fencing-token": fencingToken,
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

    // A late duplicate completion is fenced after the first owner finalizes;
    // the valid artifact from that owner must remain available.
    res = await app.fetch(new Request(\`\${base}/api/agent/status\`, {
      method: "PUT",
      headers: {
        authorization: \`Bearer \${agentToken}\`,
        "tfc-agent-id": reg.id,
        "tfc-agent-fencing-token": fencingToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "idle",
        job: { type: "plan", status: "finished", data: { operation: "plan", run_id: "run1", run_type: "plan" } },
      }),
    }));
    const duplicateBody = await res.json();
    out.duplicateCompletionStatus = res.status;
    out.duplicateCompletionCode = duplicateBody.errors?.[0]?.code;
    out.planArtifactAfterDuplicate = (await Bun.file(join(process.env.STORAGE_DIR, "plan-json", "run1.json")).json()).format_version;

    console.log(JSON.stringify(out));
    process.exit(0);
  `);

  expect(result["registerStatus"]).toBe(200);
  expect(result["protocolStatus"]).toBe(200);
  expect(result["protocolVersion"]).toBe("1");
  expect(result["protocolHasFencing"]).toBe(true);
  expect(result["registerProtocolVersion"]).toBe("1");
  expect(result["registerLegacy"]).toBe(true);
  expect(result["registerHasFencing"]).toBe(true);
  expect(result["badIacStatus"]).toBe(422);
  expect(result["agentId"]).toContain("agent-");
  expect(result["agentPoolId"]).toBe("apool");
  expect(result["upsertSameId"]).toBe(true);
  expect(result["badTokenStatus"]).toBe(401);
  expect(result["statusStatus"]).toBe(200);
  expect(result["statusEchoedIndex"]).toBe("7");
  expect(result["agentStatusAfterIdle"]).toBe("idle");
  expect(result["claimStatus"]).toBe(200);
  expect(result["jobType"]).toBe("plan");
  expect(result["jobId"]).toBe("ajob1");
  expect(result["operation"]).toBe("plan");
  expect(result["iacBinary"]).toBe("terraform");
  expect(result["runId"]).toBe("run1");
  expect(result["workspaceName"]).toBe("ws");
  expect(result["organizationName"]).toBe("org");
  expect(result["workingDirectory"]).toBe("");
  expect(result["tokenStarts"]).toBe(true);
  expect(result["timeout"]).toBe("1h");
  expect(result["insecurePublicUrlRejected"]).toBe(true);
  expect(result["httpsPublicUrl"]).toBe("https://public.example");
  expect(result["artifactTtlSeconds"]).toBeGreaterThan(300);
  expect(result["hasConfigurationUrl"]).toBe(true);
  expect(result["hasFilesystemUrl"]).toBe(true);
  expect(result["hasLogUrl"]).toBe(true);
  expect(result["planCurrentOperation"]).toBe("plan");
  expect(result["planTerraformVersion"]).toBe("1.9.5");
  expect(result["planVariables"]).toBe("{}");
  expect(result["environment"]).toContain('"TF_VAR_OPENCODE_API_KEY":"secret-key-123"');
  expect(result["environment"]).toContain('"TFE_TOKEN":"trun-something"');
  expect(result["hasPlanJsonUrl"]).toBe(true);
  expect(result["secondClaimStatus"]).toBe(200);
  expect(result["secondClaimJobId"]).toBe("ajob1");
  expect(result["runStatusAfterClaim"]).toBe("planning");
  expect(result["runAgentVersion"]).toBe("1.30.1");
  expect(result["runAgentProtocolVersion"]).toBe("1");
  expect(result["runHasFencing"]).toBe(true);
  expect(result["runPolicyOperation"]).toBe("plan");
  expect(result["signedArtifactStatus"]).toBe(200);
  expect(result["artifactUnauthStatus"]).toBe(401);
  expect(result["planJsonPutStatus"]).toBe(200);
  expect(result["redactedPutStatus"]).toBe(200);
  expect(result["invalidSideArtifactStatus"]).toBe(422);
  expect(result["keptSideArtifact"]).toEqual({ redacted: true });
  expect(result["schemasPutStatus"]).toBe(200);
  expect(result["logPatchStatus"]).toBe(200);
  expect(result["logStoredText"]).toBe("Terraform v1.9.5\nInitializing...\nWarning: deprecated");
  expect(result["encryptedCompletion"]).toBe(422);
  expect(result["jobAfterEncrypted"]).toBe("claimed");
  expect(result["completeStatus"]).toBe(200);
  expect(result["runStatusAfterComplete"]).toBe("planned");
  expect(result["runHasChanges"]).toBe(true);
  expect(result["jobStatusAfterComplete"]).toBe("completed");
  expect(result["duplicateCompletionStatus"]).toBe(409);
  expect(result["duplicateCompletionCode"]).toBe("stale-agent-lease");
  expect(result["planArtifactAfterDuplicate"]).toBe("1.2");
  expect(result["configVersionStatus"]).toBe(404);
  expect(result["configVersionServedStatus"]).toBe(200);
  expect(result["configVersionMembers"]).toContain("./main.tf");
  expect(result["configVersionMembers"]).not.toContain("my-repo-abc123/");
  expect(result["fsPutStatus"]).toBe(200);
  expect(result["fsGetStatus"]).toBe(200);
  expect(result["fsGetBytes"]).toBe("fs-archive-bytes");
}, 30000);

test("agent request forwarding rejects unsafe queued destinations before delivery", async () => {
  const result = await runAgentApiScript(`
    const { createHash } = await import("node:crypto");
    const { eq } = await import("drizzle-orm");
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const { agentForwardedRequests, agentPoolTokens, agentPools, agents, organizations } = await import("./src/db/schema.ts");

    const agentToken = "agent-forwarding-token";
    const base = "http://test.local";
    process.env.TERRENCE_ALLOW_PRIVATE_VCS_URLS = "true";

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(agentPools).values({ id: "apool", orgId: "org", name: "pool", organizationScoped: true, createdAt: Date.now() });
    await db.insert(agentPoolTokens).values({
      id: "atok",
      agentPoolId: "apool",
      token: createHash("sha256").update(agentToken).digest("hex"),
      createdAt: Date.now(),
    });

    const register = await app.fetch(new Request(base + "/api/agent/register", {
      method: "POST",
      headers: { authorization: "Bearer " + agentToken, "content-type": "application/json" },
      body: JSON.stringify({ name: "forwarding-agent", request_forwarding: true }),
    }));
    const registered = await register.json();

    await db.insert(agentForwardedRequests).values({
      id: "unsafe",
      agentPoolId: "apool",
      method: "GET",
      url: "http://127.0.0.1:8080/secret",
      headers: { authorization: ["Bearer secret"] },
      body: "c2VjcmV0",
      status: "queued",
      createdAt: 1,
    });
    await db.insert(agentForwardedRequests).values({
      id: "safe",
      agentPoolId: "apool",
      method: "GET",
      url: "https://8.8.8.8/health",
      headers: {},
      body: null,
      status: "queued",
      createdAt: 2,
    });

    const response = await app.fetch(new Request(base + "/api/agent/forwarded-requests", {
      headers: { authorization: "Bearer " + agentToken, "tfc-agent-id": registered.id },
    }));
    const delivered = await response.json();
    const unsafe = await db.query.agentForwardedRequests.findFirst({ where: eq(agentForwardedRequests.id, "unsafe") });
    const safe = await db.query.agentForwardedRequests.findFirst({ where: eq(agentForwardedRequests.id, "safe") });
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, registered.id) });
    console.log(JSON.stringify({
      responseStatus: response.status,
      deliveredId: delivered.id,
      unsafeStatus: unsafe.status,
      unsafeHeaders: unsafe.headers,
      unsafeBody: unsafe.body,
      unsafeError: unsafe.errorMessage,
      safeStatus: safe.status,
      safeAgentId: safe.agentId,
      agentId: agent.id,
    }));
    process.exit(0);
  `);

  expect(result["responseStatus"]).toBe(200);
  expect(result["deliveredId"]).toBe("safe");
  expect(result["unsafeStatus"]).toBe("errored");
  expect(result["unsafeHeaders"]).toEqual({});
  expect(result["unsafeBody"]).toBeNull();
  expect(result["unsafeError"]).toContain("private or loopback");
  expect(result["safeStatus"]).toBe("claimed");
  expect(result["safeAgentId"]).toBe(result["agentId"]);
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
    const fencingToken = String(job.data.fencing_token);
    out.applyContainerAbsent = job.apply === undefined;
    out.planContainerPresent = job.plan !== undefined;

    // errored completion -> run errored
    res = await app.fetch(new Request(\`\${base}/api/agent/status\`, {
      method: "PUT",
      headers: { authorization: \`Bearer \${agentToken}\`, "tfc-agent-id": reg.id, "tfc-agent-fencing-token": fencingToken, "content-type": "application/json" },
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

  expect(result["applyContainerAbsent"]).toBe(true);
  expect(result["planContainerPresent"]).toBe(true);
  expect(result["erroredStatus"]).toBe(200);
  expect(result["runStatusAfterError"]).toBe("errored");
  expect(result["jobStatusAfterError"]).toBe("errored");
  expect(result["jobError"]).toContain("failed running terraform plan");
}, 30000);

const nativeAgentFixture = String.raw`
    const { createHash, createHmac } = await import("node:crypto");
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { eq } = await import("drizzle-orm");
    const root=process.env.TEST_DIR, base="https://native.example.test";
    const digest=(value)=>createHash("sha256").update(value).digest("hex");
    const profilePath=join(root,"native-profile.json"), source=join(root,"policy");
    await mkdir(source); await writeFile(join(source,"proof.policy.hcl"),"# authenticated owner fixture\n");
    const archive=join(root,"policy.tar.gz");
    const tar=Bun.spawn(["tar","-czf",archive,"-C",source,"."],{stdout:"ignore",stderr:"pipe"});
    if(await tar.exited!==0)throw new Error(await new Response(tar.stderr).text());
    const pin={path:"/not-executed-on-control-plane",sha256:"b".repeat(64)};
    await writeFile(profilePath,JSON.stringify({schemaVersion:1,owner:pin,runtime:{engine:pin,runner:pin,supervisor:pin,shim:pin,recorder:pin,plugin:pin,patchSha256:"c".repeat(64)},pluginVersion:"0.5.0",catalogSha256:"d".repeat(64),cgroupRoot:"/not-used-for-remote-execution",privateParent:"/tmp"}));
    await chmod(profilePath,0o400);
    process.env.PUBLIC_URL=base;process.env.TERRENCE_TFPOLICY_RUNTIME_PROFILE=profilePath;
    const { app }=await import("./src/app.ts"), { db }=await import("./src/db/index.ts"), s=await import("./src/db/schema.ts");
    const { hashAuthenticationToken }=await import("./src/lib/token-service.ts");
    const { AGENT_PROTOCOL_CAPABILITIES }=await import("./src/lib/agent-protocol.ts");
    await db.insert(s.organizations).values({id:"org",name:"org",defaultTerraformVersion:"1.17.1"});
    await db.insert(s.agentPools).values({id:"pool",orgId:"org",name:"pool",organizationScoped:true});
    await db.insert(s.agentPoolTokens).values({id:"token",agentPoolId:"pool",token:hashAuthenticationToken("agent-native-fixture")});
    for(const id of ["agent","other"])await db.insert(s.agents).values({id,agentPoolId:"pool",name:id,status:"idle",lastPingAt:Date.now(),capabilities:[...AGENT_PROTOCOL_CAPABILITIES]});
    await db.insert(s.workspaces).values({id:"ws",orgId:"org",name:"ws",executionMode:"agent",agentPoolId:"pool",iacBinary:"terraform",terraformVersion:"1.17.1"});
    await db.insert(s.adminTfpolicyVersions).values({id:"tfp",version:"0.5.0",archs:[{os:"linux",arch:process.arch==="arm64"?"arm64":"amd64",url:"https://example.invalid/operator.zip",sha:"d".repeat(64)}]});
    await db.insert(s.policySets).values({id:"set",orgId:"org",name:"native",kind:"tfpolicy",policyToolVersion:"0.5.0"});
    await db.insert(s.policySetWorkspaces).values({id:"scope",policySetId:"set",workspaceId:"ws"});
    await db.insert(s.policySetVersions).values({id:"version",policySetId:"set",status:"ready",archivePath:archive});
    const headers={authorization:"Bearer agent-native-fixture","tfc-agent-id":"agent","content-type":"application/json"};
    const call=(url,method="GET",body,extra=headers)=>app.handle(new Request(url.startsWith("https:")?url:base+url,{method,headers:extra,...(body===undefined?{}:{body:JSON.stringify(body)})}));
    async function claim(runId,jobId){await db.insert(s.runs).values({id:runId,workspaceId:"ws",status:"plan_queued",savePlan:true,createdAt:Date.now()});await db.insert(s.agentJobs).values({id:jobId,runId,agentPoolId:"pool",phase:"plan",status:"queued",createdAt:Date.now()});const response=await call("/api/agent/jobs");if(response.status!==200)throw new Error("Native claim failed");return response.json();}
`;

test("native agent artifacts require the owning lease and authenticate protected plan bytes", async () => {
  const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
    const job=await claim("run","job"), manifestResponse=await call(job.data.native_policy_url), manifest=await manifestResponse.json();
    const unsigned=(await call(job.data.native_policy_url,"GET",undefined,{})).status;
    const wrongAgent=(await call(job.data.native_policy_url,"GET",undefined,{...headers,"tfc-agent-id":"other"})).status;
    const stale=new URL(job.data.native_policy_url);stale.searchParams.set("fencing_token","999");
    const oldLease=(await call(stale.toString())).status;
    const plan=Buffer.from("protected owner plan bytes"), planJson=JSON.stringify({resource_changes:[{mode:"managed",change:{actions:["create"]}}]});
    const nonce="a".repeat(64), audit=JSON.stringify({event:"start",nonce,roots:["/agent-policy"]})+"\n"+JSON.stringify({event:"result",policies:[{file:"/agent-policy/proof.policy.hcl",address:"resource_policy.proof",enforcement:"mandatory",result:"AllowResult"}]})+"\n",journal="authenticated RPC capture\n";
    const payload={version:2,stage:"plan",executionId:"job:"+job.data.fencing_token+":plan",exitCode:2,runId:"run",workspaceId:"ws",evaluationId:manifest.evaluationId,policyFingerprint:manifest.policyFingerprint,nonce,planSha256:digest(plan),planJsonSha256:digest(planJson),runtimeSha256:manifest.runtimeSha256,policySnapshotSha256:manifest.sourceSha256,auditSha256:digest(audit),journalSha256:digest(journal),stdoutSha256:nonce,allows:true,denials:[],overrides:[]};
    const sign=(value)=>{const bytes=Buffer.from(JSON.stringify(value));return {payload:bytes.toString("base64url"),mac:createHmac("sha256",Buffer.from(manifest.receiptKey,"hex")).update(bytes).digest("hex")};};
    const artifact={receipt:sign(payload),audit,journal,planJson,plan:plan.toString("base64")};
    const invalid=[{...artifact,planJson:"{}"},{...artifact,plan:Buffer.from("another plan").toString("base64")},{...artifact,receipt:{...artifact.receipt,mac:"0".repeat(64)}}];
    for(const [key,value]of [["executionId","other-job:99:plan"],["runtimeSha256","0".repeat(64)],["policySnapshotSha256","0".repeat(64)],["stage","apply"]])invalid.push({...artifact,receipt:sign({...payload,[key]:value})});
    const rejected=[];for(const value of invalid)rejected.push((await call(job.data.native_result_url,"PUT",value)).status);
    invalid.push({...artifact,receipt:sign({...payload,allows:false,exitCode:1,denials:[]})});
    rejected.push((await call(job.data.native_result_url,"PUT",invalid.at(-1))).status);
    const stored=(await call(job.data.native_result_url,"PUT",artifact)).status;
    await call(job.data.json_plan_url,"PUT",{resource_changes:[]});
    const completion={status:"idle",job:{status:"finished",data:{run_id:"run",operation:"plan",fencing_token:job.data.fencing_token,resource_additions:999}}};
    const completed=(await call("/api/agent/status","PUT",completion)).status;
    const replay=(await call(job.data.native_result_url,"PUT",artifact)).status;
    const run=await db.query.runs.findFirst({where:eq(s.runs.id,"run")});
    const missing=await claim("missing","missing-job");
    const missingCompletion=(await call("/api/agent/status","PUT",{status:"idle",job:{status:"finished",data:{run_id:"missing",operation:"plan",fencing_token:missing.data.fencing_token}}})).status;
    const refused=await db.query.runs.findFirst({where:eq(s.runs.id,"missing")});
    console.log(JSON.stringify({manifest:manifestResponse.status,unsigned,wrongAgent,oldLease,rejected,stored,completed,replay,status:run.status,additions:run.planResourceAdditions,missingCompletion,missingStatus:refused.status}));
  `);
  expect(result).toEqual({
    manifest: 200,
    unsigned: 401,
    wrongAgent: 401,
    oldLease: 401,
    rejected: Array(8).fill(422),
    stored: 200,
    completed: 200,
    replay: 401,
    status: "planned_and_saved",
    additions: 1,
    missingCompletion: 200,
    missingStatus: "errored",
  });
}, 30_000);

for (const failure of [
  "prepare-plan",
  "prepare-redelivery",
  "prepare-apply",
  "prepare-repeat",
  "payload-first",
  "payload-repeat",
]) {
  test(`native delivery ${failure} terminates safely and preserves only possibly delivered apply locks`, async () => {
    const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
      const failure=${JSON.stringify(failure)};
      if (failure === "prepare-plan") {
        await db.insert(s.runs).values({id:"run",workspaceId:"ws",status:"plan_queued",savePlan:true,createdAt:Date.now()});
        await db.insert(s.agentJobs).values({id:"job",runId:"run",agentPoolId:"pool",phase:"plan",status:"queued",createdAt:Date.now()});
      } else {
        await claim("run","job");
        const before=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
        const apply=failure!=="prepare-redelivery", repeated=failure.endsWith("repeat");
        await db.update(s.agentJobs).set({phase:apply?"apply":"plan",result:{payloadDeliveryTrackingToken:before.result.payloadDeliveryTrackingToken,nativePolicyEvaluationId:before.result.nativePolicyEvaluationId,...(apply?{policyApplyAdmissionToken:before.fencingToken}:{}),...(repeated?{payloadDeliveryToken:before.fencingToken}:{})}}).where(eq(s.agentJobs.id,"job"));
        await db.update(s.runs).set({status:apply?"applying":"planning"}).where(eq(s.runs.id,"run"));
        await db.update(s.workspaces).set({locked:apply,lockOwnerType:apply?"agent-run":null,lockOwnerId:apply?"run":null}).where(eq(s.workspaces.id,"ws"));
      }
      if(failure.startsWith("prepare"))delete process.env.TERRENCE_TFPOLICY_RUNTIME_PROFILE;
      else await db.insert(s.workspaceVariables).values({id:"bad-variable",workspaceId:"ws",key:"CORRUPT_SECRET",value:"",valueEncrypted:"enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AA==",sensitive:true,category:"env"});
      const response=await call("/api/agent/jobs");
      const job=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
      const run=await db.query.runs.findFirst({where:eq(s.runs.id,"run")});
      const workspace=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
      const tokens=await db.query.runTokens.findMany({where:eq(s.runTokens.runId,"run")});
      const agent=await db.query.agents.findFirst({where:eq(s.agents.id,"agent")});
      console.log(JSON.stringify({http:response.status,job:job.status,run:run.status,locked:workspace.locked,recovery:job.result?.nativeRecoveryRequired===true,activeTokens:tokens.filter(token=>token.revokedAt===null).length,agent:agent.status,error:job.errorMessage}));
    `);
    expect(result).toMatchObject({
      http: failure.startsWith("prepare") ? 204 : 503,
      job: "errored",
      run: "errored",
      locked: failure.endsWith("repeat"),
      recovery: failure.endsWith("repeat"),
      activeTokens: 0,
      agent: "idle",
    });
    expect(result["error"]).toContain(
      failure === "prepare-redelivery"
        ? "Policies changed"
        : failure.startsWith("prepare")
          ? "preparation failed"
          : "payload construction failed",
    );
  }, 30_000);
}

test("agent status polls require the owning fence and retain native recovery locks", async () => {
  const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
    const claimed=await claim("run","job");
    const fence=claimed.data.fencing_token;
    const active=await call("/api/agent/jobs/job/status?fencing_token="+fence);
    const absent=(await call("/api/agent/jobs/job/status")).status;
    const stale=(await call("/api/agent/jobs/job/status?fencing_token="+(fence+1))).status;
    const other=(await call("/api/agent/jobs/job/status?fencing_token="+fence,"GET",undefined,{...headers,"tfc-agent-id":"other"})).status;
    await db.update(s.agentJobs).set({phase:"apply",status:"errored",result:{nativePolicyEvaluationId:"eval",policyApplyAdmissionToken:fence,nativeRecoveryRequired:true}}).where(eq(s.agentJobs.id,"job"));
    await db.update(s.runs).set({status:"errored"}).where(eq(s.runs.id,"run"));
    await db.update(s.workspaces).set({locked:true,lockOwnerType:"agent-run",lockOwnerId:"run"}).where(eq(s.workspaces.id,"ws"));
    const terminal=await call("/api/agent/jobs/job/status?fencing_token="+fence);
    const workspace=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
    await db.update(s.agents).set({capabilities:[]}).where(eq(s.agents.id,"other"));
    await db.insert(s.runs).values({id:"legacy-run",workspaceId:"ws",agentId:"other",status:"canceled",createdAt:Date.now()});
    await db.insert(s.agentJobs).values({id:"legacy-job",runId:"legacy-run",agentPoolId:"pool",agentId:"other",phase:"plan",status:"canceled",fencingToken:0});
    const legacyHeaders={...headers,"tfc-agent-id":"other"};
    const legacy=await call("/api/agent/jobs/legacy-job/status","GET",undefined,legacyHeaders);
    const legacyStale=(await call("/api/agent/jobs/legacy-job/status?fencing_token=1","GET",undefined,legacyHeaders)).status;
    const legacyMalformed=(await call("/api/agent/jobs/legacy-job/status?fencing_token=bad","GET",undefined,legacyHeaders)).status;
    console.log(JSON.stringify({active:await active.json(),absent,stale,other,terminal:await terminal.json(),locked:workspace.locked,legacy:{http:legacy.status,...await legacy.json()},legacyStale,legacyMalformed}));
  `);
  expect(result).toEqual({
    active: { status: "claimed", canceled: false },
    absent: 409,
    stale: 409,
    other: 404,
    terminal: { status: "errored", canceled: false },
    locked: true,
    legacy: { http: 200, status: "canceled", canceled: true },
    legacyStale: 409,
    legacyMalformed: 409,
  });
}, 30_000);

test("overlapping native preparation cannot erase a delivered apply fence", async () => {
  const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
    const { spyOn }=await import("bun:test");
    await claim("run","job");
    const before=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
    await db.update(s.agentJobs).set({phase:"apply",result:{payloadDeliveryTrackingToken:before.result.payloadDeliveryTrackingToken,nativePolicyEvaluationId:before.result.nativePolicyEvaluationId,policyApplyAdmissionToken:before.fencingToken}}).where(eq(s.agentJobs.id,"job"));
    await db.update(s.runs).set({status:"applying"}).where(eq(s.runs.id,"run"));
    await db.update(s.workspaces).set({locked:true,lockOwnerType:"agent-run",lockOwnerId:"run"}).where(eq(s.workspaces.id,"ws"));
    let pause, resume;
    const paused=new Promise(resolve=>{pause=resolve;}), resumed=new Promise(resolve=>{resume=resolve;});
    const find=db.query.agentJobs.findFirst.bind(db.query.agentJobs);
    // Suspend the former unprotected read after SQL returns. A competing real
    // HTTP handoff can then record delivery before that snapshot is written.
    // With atomic preparation there is no such read, so A completes first and
    // B becomes the failing retry. Either ordering must preserve the same hold.
    const read=spyOn(db.query.agentJobs,"findFirst").mockImplementation(async (...args)=>{
      const unprotected=new Error().stack.includes("prepareClaimedNativePolicy");
      const row=await find(...args);
      if(unprotected&&row?.id==="job") {read.mockRestore();pause();await resumed;}
      return row;
    });
    const first=call("/api/agent/jobs");
    const order=await Promise.race([paused.then(()=>"interleaved"),first.then(()=>"serialized")]);
    let second;
    if(order==="interleaved")second=await call("/api/agent/jobs");
    read.mockRestore();
    await db.insert(s.workspaceVariables).values({id:"bad-variable",workspaceId:"ws",key:"CORRUPT_SECRET",value:"",valueEncrypted:"enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AA==",sensitive:true,category:"env"});
    resume();
    const firstResponse=await first;
    if(order==="serialized")second=await call("/api/agent/jobs");
    const job=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
    const workspace=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
    console.log(JSON.stringify({statuses:[firstResponse.status,second.status].sort(),locked:workspace.locked,recovery:job.result.nativeRecoveryRequired,delivery:job.result.payloadDeliveryToken,fence:job.fencingToken}));
  `);
  expect(result).toEqual({ statuses: [200, 503], locked: true, recovery: true, delivery: 1, fence: 1 });
}, 30_000);

for (const delivered of [false, true]) {
  test(`cancellation during native payload construction preserves only possible delivery (${delivered})`, async () => {
    const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
      const { spyOn }=await import("bun:test");
      const { cancelAgentJobsForRun, recoverStaleAgentJobs }=await import("./src/lib/agent-jobs.ts");
      await claim("run","job");
      const before=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
      await db.update(s.agentJobs).set({phase:"apply",result:{nativePolicyEvaluationId:before.result.nativePolicyEvaluationId,policyApplyAdmissionToken:before.fencingToken,payloadDeliveryTrackingToken:before.result.payloadDeliveryTrackingToken,...(${delivered}?{payloadDeliveryToken:before.fencingToken}:{})}}).where(eq(s.agentJobs.id,"job"));
      await db.update(s.runs).set({status:"applying"}).where(eq(s.runs.id,"run"));
      await db.update(s.workspaces).set({locked:true,lockOwnerType:"agent-run",lockOwnerId:"run"}).where(eq(s.workspaces.id,"ws"));
      // Cancel after real native preparation, before the HTTP payload is built
      // and marked. The same agent remains live throughout this interleaving.
      const find=db.query.organizations.findFirst.bind(db.query.organizations);
      let canceled=false;
      const read=spyOn(db.query.organizations,"findFirst").mockImplementation(async (...args)=>{
        const duringBuild=new Error().stack.includes("buildClaimedJobPayload");
        const row=await find(...args);
        if(duringBuild){
          read.mockRestore();canceled=true;
          await db.update(s.runs).set({status:"canceled"}).where(eq(s.runs.id,"run"));
          await cancelAgentJobsForRun("run");
        }
        return row;
      });
      const response=await call("/api/agent/jobs");
      read.mockRestore();
      const immediate=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
      const tokens=await db.query.runTokens.findMany({where:eq(s.runTokens.runId,"run")});
      await cancelAgentJobsForRun("run");
      await recoverStaleAgentJobs(Date.now());
      const workspace=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
      const job=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
      const run=await db.query.runs.findFirst({where:eq(s.runs.id,"run")});
      console.log(JSON.stringify({canceled,http:response.status,immediate:immediate.locked,locked:workspace.locked,job:job.status,run:run.status,delivery:job.result.payloadDeliveryToken??null,tracking:job.result.payloadDeliveryTrackingToken,fence:job.fencingToken,activeTokens:tokens.filter(token=>token.revokedAt===null).length}));
    `);
    expect(result).toEqual({
      canceled: true,
      http: 503,
      immediate: delivered,
      locked: delivered,
      job: "canceled",
      run: "canceled",
      delivery: delivered ? 1 : null,
      tracking: 1,
      fence: 1,
      activeTokens: 0,
    });
  }, 30_000);
}

test("v2 agent polling records possible native delivery before returning a job", async () => {
  const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
    const { recoverStaleAgentJobs }=await import("./src/lib/agent-jobs.ts");
    await claim("run","job");
    const before=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
    await db.update(s.agentJobs).set({phase:"apply",result:{nativePolicyEvaluationId:before.result.nativePolicyEvaluationId,policyApplyAdmissionToken:before.fencingToken,payloadDeliveryTrackingToken:before.result.payloadDeliveryTrackingToken}}).where(eq(s.agentJobs.id,"job"));
    await db.update(s.runs).set({status:"applying"}).where(eq(s.runs.id,"run"));
    await db.update(s.workspaces).set({locked:true,lockOwnerType:"agent-run",lockOwnerId:"run"}).where(eq(s.workspaces.id,"ws"));
    const response=await call("/api/v2/agents/agent/jobs/poll","POST");
    await db.update(s.agents).set({lastPingAt:1}).where(eq(s.agents.id,"agent"));
    await recoverStaleAgentJobs(Date.now());
    const job=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
    const workspace=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
    console.log(JSON.stringify({http:response.status,job:job.status,delivery:job.result.payloadDeliveryToken,tracking:job.result.payloadDeliveryTrackingToken,recovery:job.result.nativeRecoveryRequired,locked:workspace.locked}));
  `);
  expect(result).toEqual({ http: 200, job: "errored", delivery: 1, tracking: 1, recovery: true, locked: true });
}, 30_000);

for (const delivery of ["undelivered", "possible", "older"]) {
  test(`removing native policy scope cannot downgrade a resumed native apply (${delivery})`, async () => {
    const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
      await claim("run","job");
      const before=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
      await db.update(s.agentJobs).set({phase:"apply",result:{nativePolicyEvaluationId:before.result.nativePolicyEvaluationId,policyApplyAdmissionToken:before.fencingToken,...(${JSON.stringify(delivery)}!=="older"?{payloadDeliveryTrackingToken:before.fencingToken}:{}),...(${JSON.stringify(delivery)}==="possible"?{payloadDeliveryToken:before.fencingToken}:{})}}).where(eq(s.agentJobs.id,"job"));
      await db.update(s.runs).set({status:"applying"}).where(eq(s.runs.id,"run"));
      await db.update(s.workspaces).set({locked:true,lockOwnerType:"agent-run",lockOwnerId:"run"}).where(eq(s.workspaces.id,"ws"));
      await db.delete(s.policySetWorkspaces).where(eq(s.policySetWorkspaces.policySetId,"set"));
      // No network fallback is allowed to turn the native claim into a legacy
      // payload. A regressed downgrade sees a deterministic release failure.
      globalThis.fetch=async()=>new Response(null,{status:503});
      const response=await call("/api/agent/jobs");
      const job=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
      const run=await db.query.runs.findFirst({where:eq(s.runs.id,"run")});
      const workspace=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
      const tokens=await db.query.runTokens.findMany({where:eq(s.runTokens.runId,"run")});
      console.log(JSON.stringify({http:response.status,job:job.status,run:run.status,owner:job.agentId,fence:job.fencingToken,locked:workspace.locked,recovery:job.result.nativeRecoveryRequired===true,activeTokens:tokens.filter(token=>token.revokedAt===null).length,error:job.errorMessage}));
    `);
    expect(result).toMatchObject({
      http: 204,
      job: "errored",
      run: "errored",
      owner: "agent",
      fence: 1,
      locked: delivery !== "undelivered",
      recovery: delivery !== "undelivered",
      activeTokens: 0,
    });
    expect(result["error"]).toContain("Native policy configuration changed");
  }, 30_000);
}

for (const protocol of ["modern", "v2"]) {
  for (const delivery of ["undelivered", "possible", "older"]) {
    test(`${protocol} handoff rejects a stale legacy snapshot of a current native apply (${delivery})`, async () => {
      const result = await runAgentApiScript(String.raw`
${nativeAgentFixture}
        const { spyOn }=await import("bun:test");
        await claim("run","job");
        const before=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
        const result={policyApplyAdmissionToken:before.fencingToken,...(${JSON.stringify(delivery)}!=="older"?{payloadDeliveryTrackingToken:before.fencingToken}:{})};
        await db.update(s.agentJobs).set({phase:"apply",result}).where(eq(s.agentJobs.id,"job"));
        await db.update(s.runs).set({status:"applying"}).where(eq(s.runs.id,"run"));
        await db.update(s.workspaces).set({locked:true,lockOwnerType:"agent-run",lockOwnerId:"run"}).where(eq(s.workspaces.id,"ws"));
        let interleaved=false;
        const find=db.query.workspaces.findFirst.bind(db.query.workspaces);
        const read=spyOn(db.query.workspaces,"findFirst").mockImplementation(async(...args)=>{
          const preparing=new Error().stack.includes("claimedJobDetails");
          const row=await find(...args);
          if(preparing){
            read.mockRestore();interleaved=true;
            // The claim snapshot is already loaded. Another preparation writes
            // its native identity before scope removal makes this one legacy.
            await db.update(s.agentJobs).set({result:{...result,nativePolicyEvaluationId:before.result.nativePolicyEvaluationId,...(${JSON.stringify(delivery)}==="possible"?{payloadDeliveryToken:before.fencingToken}:{})}}).where(eq(s.agentJobs.id,"job"));
            await db.delete(s.policySetWorkspaces).where(eq(s.policySetWorkspaces.policySetId,"set"));
          }
          return row;
        });
        globalThis.fetch=async()=>new Response("a".repeat(64)+"  terraform_1.17.1_linux_amd64.zip\n"+"a".repeat(64)+"  terraform_1.17.1_linux_arm64.zip\n");
        const response=await call(${JSON.stringify(protocol)}==="modern"?"/api/agent/jobs":"/api/v2/agents/agent/jobs/poll",${JSON.stringify(protocol)}==="modern"?"GET":"POST");
        read.mockRestore();
        const job=await db.query.agentJobs.findFirst({where:eq(s.agentJobs.id,"job")});
        const run=await db.query.runs.findFirst({where:eq(s.runs.id,"run")});
        const workspace=await db.query.workspaces.findFirst({where:eq(s.workspaces.id,"ws")});
        const tokens=await db.query.runTokens.findMany({where:eq(s.runTokens.runId,"run")});
        console.log(JSON.stringify({interleaved,http:response.status,job:job.status,run:run.status,owner:job.agentId,fence:job.fencingToken,locked:workspace.locked,recovery:job.result.nativeRecoveryRequired===true,activeTokens:tokens.filter(token=>token.revokedAt===null).length}));
      `);
      expect(result).toEqual({
        interleaved: true,
        http: 503,
        job: "errored",
        run: "errored",
        owner: "agent",
        fence: 1,
        locked: delivery !== "undelivered",
        recovery: delivery !== "undelivered",
        activeTokens: 0,
      });
    }, 30_000);
  }
}
