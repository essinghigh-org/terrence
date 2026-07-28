import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function runScript(script: string, env: Readonly<Record<string, string>> = {}): Promise<Record<string, unknown>> {
  const testDirectory = await mkdtemp(join(tmpdir(), "terrence-assessments-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: `file:${join(testDirectory, "terrence.db")}`,
        STORAGE_DIR: join(testDirectory, "storage"),
        NODE_ENV: "test",
        SIMULATED_RUNS: "true",
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
    if (exitCode !== 0) throw new Error(stderr || stdout);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
}

const assessmentPlan = {
  format_version: "1.2",
  resource_changes: [
    { mode: "managed", address: "test_resource.drifted", change: { actions: ["update"] } },
    { mode: "managed", address: "test_resource.stable", change: { actions: ["no-op"] } },
    { mode: "data", address: "data.test.ignored", change: { actions: ["read"] } },
  ],
  checks: [
    {
      address: { kind: "check", name: "healthy", to_display: "check.healthy" },
      status: "pass",
      instances: [],
    },
    {
      address: { kind: "check", name: "certificate", to_display: "check.certificate" },
      status: "fail",
      instances: [{ problems: [{ message: "certificate expires too soon" }] }],
    },
  ],
};

test("schedules eligible assessments separately from runs and records drift, checks, and notifications", async () => {
  const result = await runScript(`
    const { db } = await import("./src/db/index.ts");
    const {
      assessmentCheckResults,
      assessmentResults,
      configurationVersions,
      notificationConfigurations,
      organizations,
      runs,
      workspaces,
    } = await import("./src/db/schema.ts");
    const { deliverAssessmentNotifications } = await import("./src/lib/notifications.ts");
    const { enqueueDueAssessments, pollAssessmentQueue } = await import("./src/worker.ts");

    const now = 2_000_000_000_000;
    await db.insert(organizations).values([
      { id: "forced-org", name: "forced-org", assessmentsEnforced: true },
      { id: "optional-org", name: "optional-org" },
    ]);
    await db.insert(workspaces).values([
      { id: "forced", name: "forced", orgId: "forced-org", assessmentsEnabled: false },
      { id: "enabled", name: "enabled", orgId: "optional-org", assessmentsEnabled: true },
      { id: "disabled", name: "disabled", orgId: "optional-org", assessmentsEnabled: false },
      { id: "paused", name: "paused", orgId: "optional-org", assessmentsEnabled: true },
    ]);
    await db.insert(configurationVersions).values([
      { id: "forced-cv", workspaceId: "forced", status: "uploaded" },
      { id: "enabled-cv", workspaceId: "enabled", status: "uploaded" },
      { id: "disabled-cv", workspaceId: "disabled", status: "uploaded" },
      { id: "paused-cv", workspaceId: "paused", status: "uploaded" },
    ]);
    await db.insert(runs).values([
      { id: "forced-run", workspaceId: "forced", configurationVersionId: "forced-cv", status: "applied", createdAt: now - 10_000 },
      { id: "enabled-run", workspaceId: "enabled", configurationVersionId: "enabled-cv", status: "applied", createdAt: now - 10_000 },
      { id: "disabled-run", workspaceId: "disabled", configurationVersionId: "disabled-cv", status: "applied", createdAt: now - 10_000 },
      { id: "paused-applied", workspaceId: "paused", configurationVersionId: "paused-cv", status: "applied", createdAt: now - 20_000 },
      { id: "paused-error", workspaceId: "paused", configurationVersionId: "paused-cv", status: "errored", createdAt: now - 5_000 },
    ]);

    const first = await enqueueDueAssessments(now);
    const claimed = await pollAssessmentQueue();
    for (let attempt = 0; attempt < 100; attempt++) {
      const unfinished = (await db.query.assessmentResults.findMany())
        .some(result => result.status === "pending" || result.status === "running");
      if (!unfinished) break;
      await Bun.sleep(10);
    }
    const tooSoon = await enqueueDueAssessments(now + 1_000);
    const completed = await db.query.assessmentResults.findMany({ orderBy: (row, { asc }) => [asc(row.workspaceId)] });
    const checks = await db.query.assessmentCheckResults.findMany();

    const payloads = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("", { status: 200 });
    };
    await db.insert(notificationConfigurations).values({
      id: "health-notification",
      workspaceId: completed[0].workspaceId,
      name: "health",
      destinationType: "generic",
      url: "https://example.test/notifications",
      triggers: ["assessment:drifted", "assessment:check_failure"],
      enabled: true,
    });
    await deliverAssessmentNotifications(completed[0].id, "assessment:drifted");
    await deliverAssessmentNotifications(completed[0].id, "assessment:check_failure");

    const dueAgain = await enqueueDueAssessments(now + 86_400_001);
    console.log(JSON.stringify({
      firstWorkspaces: completed.map(result => result.workspaceId),
      firstStatuses: completed.map(result => result.status),
      enqueuedCount: first.length,
      claimedCount: claimed.length,
      firstCounts: completed.map(result => ({
        drifted: result.resourcesDrifted,
        undrifted: result.resourcesUndrifted,
        passed: result.checksPassed,
        failed: result.checksFailed,
        allPassed: result.allChecksSucceeded,
      })),
      checkAssociations: checks.map(check => ({
        assessment: check.assessmentResultId !== null,
        run: check.runId,
        status: check.status,
        message: check.message,
      })).sort((a, b) => a.status.localeCompare(b.status)),
      tooSoon,
      dueAgainCount: dueAgain.length,
      ordinaryRunCount: (await db.query.runs.findMany()).length,
      notificationTriggers: payloads.map(payload => payload.trigger),
      notificationScope: payloads[0]?.trigger_scope,
      notificationResultId: payloads[0]?.details?.new_assessment_result?.id,
    }));
  `, {
    SIMULATED_ASSESSMENT_JSON: JSON.stringify(assessmentPlan),
  });

  expect(result["firstWorkspaces"]).toEqual(["enabled", "forced"]);
  expect(result["firstStatuses"]).toEqual(["completed", "completed"]);
  expect(result["enqueuedCount"]).toBe(2);
  expect(result["claimedCount"]).toBe(2);
  expect(result["firstCounts"]).toEqual([
    { drifted: 1, undrifted: 1, passed: 1, failed: 1, allPassed: false },
    { drifted: 1, undrifted: 1, passed: 1, failed: 1, allPassed: false },
  ]);
  expect(result["checkAssociations"]).toEqual([
    { assessment: true, run: null, status: "failed", message: "certificate expires too soon" },
    { assessment: true, run: null, status: "failed", message: "certificate expires too soon" },
    { assessment: true, run: null, status: "passed", message: null },
    { assessment: true, run: null, status: "passed", message: null },
  ]);
  expect(result["tooSoon"]).toEqual([]);
  expect(result["dueAgainCount"]).toBe(2);
  expect(result["ordinaryRunCount"]).toBe(5);
  expect(result["notificationTriggers"]).toEqual(["assessment:drifted", "assessment:check_failure"]);
  expect(result["notificationScope"]).toBe("assessment");
  expect(typeof result["notificationResultId"]).toBe("string");
});

test("evaluates and stores plan checks before apply without turning advisory checks into blockers", async () => {
  const result = await runScript(`
    const { db } = await import("./src/db/index.ts");
    const { assessmentCheckResults, organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({ id: "workspace", name: "workspace", orgId: "org", autoApply: true });
    await db.insert(runs).values({ id: "run", workspaceId: "workspace", status: "pending", createdAt: 1 });
    await executeRun("run");

    const run = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    const checks = await db.query.assessmentCheckResults.findMany({
      where: (row, { eq }) => eq(row.runId, "run"),
      orderBy: (row, { asc }) => [asc(row.address)],
    });
    console.log(JSON.stringify({
      runStatus: run?.status,
      checks: checks.map(check => ({
        address: check.address,
        assessmentResultId: check.assessmentResultId,
        status: check.status,
        message: check.message,
      })),
    }));
  `, {
    SIMULATED_PLAN_JSON: JSON.stringify(assessmentPlan),
  });

  expect(result["runStatus"]).toBe("applied");
  expect(result["checks"]).toEqual([
    {
      address: "check.certificate",
      assessmentResultId: null,
      status: "failed",
      message: "certificate expires too soon",
    },
    {
      address: "check.healthy",
      assessmentResultId: null,
      status: "passed",
      message: null,
    },
  ]);
});

test("serves assessment summaries, check results, and admin-only artifacts", async () => {
  const result = await runScript(`
    const { app } = await import("./src/app.ts");
    const { db } = await import("./src/db/index.ts");
    const { assessmentCheckResults, assessmentResults } = await import("./src/db/schema.ts");

    let token = "";
    const api = (method, path, body) => app.handle(new Request("http://localhost" + path, {
      method,
      headers: {
        ...(token === "" ? {} : { Authorization: "Bearer " + token }),
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    await api("POST", "/api/v2/users", {
      data: { type: "users", attributes: { username: "health-owner", password: "health-password" } },
    });
    const login = await api("POST", "/api/v2/users/login", {
      data: { attributes: { username: "health-owner", password: "health-password" } },
    });
    token = (await login.json()).data.attributes.token;
    await api("POST", "/api/v2/organizations", {
      data: { type: "organizations", attributes: { name: "health-org" } },
    });
    const workspaceResponse = await api("POST", "/api/v2/organizations/health-org/workspaces", {
      data: { type: "workspaces", attributes: { name: "health-workspace" } },
    });
    const workspaceId = (await workspaceResponse.json()).data.id;
    await db.insert(assessmentResults).values({
      id: "asmtres-api",
      workspaceId,
      status: "completed",
      succeeded: true,
      drifted: true,
      resourcesDrifted: 1,
      allChecksSucceeded: false,
      checksFailed: 1,
      jsonOutput: { format_version: "1.2" },
      jsonSchema: { format_version: "1.0" },
      logOutput: "assessment log",
      createdAt: 1,
      completedAt: 2,
    });
    await db.insert(assessmentCheckResults).values({
      id: "checkrs-api",
      workspaceId,
      assessmentResultId: "asmtres-api",
      address: "check.health",
      status: "failed",
      message: "unhealthy",
      createdAt: 1,
    });

    const summaryResponse = await api("GET", "/api/v2/assessment-results/asmtres-api");
    const checksResponse = await api("GET", "/api/v2/assessment-results/asmtres-api/check-results");
    const jsonResponse = await api("GET", "/api/v2/assessment-results/asmtres-api/json-output");
    const schemaResponse = await api("GET", "/api/v2/assessment-results/asmtres-api/json-schema");
    const logResponse = await api("GET", "/api/v2/assessment-results/asmtres-api/log-output");
    token = "";
    const anonymousResponse = await api("GET", "/api/v2/assessment-results/asmtres-api");

    console.log(JSON.stringify({
      summaryStatus: summaryResponse.status,
      summary: (await summaryResponse.json()).data,
      checks: (await checksResponse.json()).data,
      json: await jsonResponse.json(),
      jsonContentType: jsonResponse.headers.get("content-type"),
      schema: await schemaResponse.json(),
      log: await logResponse.text(),
      logContentType: logResponse.headers.get("content-type"),
      anonymousStatus: anonymousResponse.status,
    }));
    process.exit(0);
  `);

  expect(result["summaryStatus"]).toBe(200);
  expect((result["summary"] as Record<string, unknown>)["id"]).toBe("asmtres-api");
  expect(((result["summary"] as Record<string, unknown>)["attributes"] as Record<string, unknown>)["checks-failed"]).toBe(1);
  expect((result["checks"] as Record<string, unknown>[])[0]?.["id"]).toBe("checkrs-api");
  expect(result["json"]).toEqual({ format_version: "1.2" });
  expect(result["jsonContentType"]).toContain("application/json");
  expect(result["schema"]).toEqual({ format_version: "1.0" });
  expect(result["log"]).toBe("assessment log");
  expect(result["logContentType"]).toContain("text/plain");
  expect(result["anonymousStatus"]).toBe(404);
});
