import { afterEach, describe, expect, spyOn, test } from "bun:test";
import jwt from "jsonwebtoken";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../src/db";
import {
  organizations,
  assessmentResults,
  moduleTestRuns,
  registryModules,
  registryModuleVersions,
  runs,
  workspaces,
  workloadIdentityKeys,
  workloadIdentityLeases,
  workloadIdentityTokens,
} from "../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  issueModuleTestIdentityToken,
  issueWorkspaceIdentityToken,
  revokeWorkloadIdentityTokens,
  rotateWorkloadIdentityKey,
  trimWorkloadIdentityKeys,
  verifyWorkloadIdentityToken,
  workspaceIdentityEnvironment,
} from "../../src/lib/workload-identity";
import { workloadIdentityRoutes } from "../../src/routes/workload-identity";

async function ensureTestWorkspace(): Promise<void> {
  const orgId = "org-1";
  const workspaceId = "workspace-1";
  // Insert org if not exists
  await db
    .insert(organizations)
    .values({ id: orgId, name: "example", email: "test@example.com" })
    .onConflictDoNothing();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, name: "network", orgId, autoApply: false })
    .onConflictDoNothing();
}

async function ensureTestRun(runId: string): Promise<void> {
  await ensureTestWorkspace();
  await db
    .insert(runs)
    .values({ id: runId, workspaceId: "workspace-1", status: "pending", createdAt: Date.now() })
    .onConflictDoNothing();
}

afterEach(async (): Promise<void> => {
  await db.delete(workloadIdentityTokens);
  await db.delete(workloadIdentityKeys);
});

describe("workload identity", () => {
  test("does not publish a generated key after its lease expires", async () => {
    // The production database wrapper supports awaited transactions on both
    // drivers; Drizzle's SQLite declaration still describes a sync callback.
    const asyncDb = db as unknown as {
      transaction: (callback: (tx: typeof db) => Promise<unknown>, options?: unknown) => Promise<unknown>;
    };
    const originalTransaction = asyncDb.transaction.bind(db);
    const transaction = spyOn(asyncDb, "transaction").mockImplementation(async (callback, ...options) => {
      await db
        .update(workloadIdentityLeases)
        .set({ leaseExpiresAt: Date.now() - 1 })
        .where(eq(workloadIdentityLeases.id, "workload-identity-signing"));
      return originalTransaction(callback, ...options);
    });
    try {
      let rejection: unknown;
      try {
        await rotateWorkloadIdentityKey();
      } catch (error: unknown) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain("Lost workload identity signing-key leadership");
      expect(await db.query.workloadIdentityKeys.findMany()).toHaveLength(0);
    } finally {
      transaction.mockRestore();
    }
  });
  test("issues a module-test token with the documented subject and validity window", async () => {
    const runId = `module-run-${crypto.randomUUID()}`;
    await ensureTestWorkspace();
    const moduleId = `module-${crypto.randomUUID()}`;
    const versionId = `module-version-${crypto.randomUUID()}`;
    await db
      .insert(registryModules)
      .values({ id: moduleId, orgId: "org-1", namespace: moduleId, name: "network", provider: "aws" });
    await db.insert(registryModuleVersions).values({ id: versionId, moduleId, version: "1.0.0" });
    await db.insert(moduleTestRuns).values({ id: runId, moduleId, versionId, status: "running" });
    expect(await db.query.runs.findFirst({ where: eq(runs.id, runId) })).toBeUndefined();
    const issued = await issueModuleTestIdentityToken({
      organizationId: "org-1",
      organizationName: "example",
      moduleName: "network",
      runId,
      audience: "aws.workload.identity",
      ttlSeconds: 600,
    });
    const claims = jwt.decode(issued.token) as Record<string, unknown>;
    expect(claims["sub"]).toBe("organization:example:module:network:operation:test_run");
    expect(claims["terraform_run_phase"]).toBe("plan");
    expect(Number(claims["nbf"])).toBe(Number(claims["iat"]) - 30);
    expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(600);
    expect((await verifyWorkloadIdentityToken(issued.token, "aws.workload.identity"))["jti"]).toBe(issued.jti);

    await revokeWorkloadIdentityTokens(runId);
    const revoked = verifyWorkloadIdentityToken(issued.token, "aws.workload.identity");
    expect(revoked).rejects.toThrow("revoked");
    await db.delete(moduleTestRuns).where(eq(moduleTestRuns.id, runId));
    expect(
      await db.query.workloadIdentityTokens.findFirst({ where: eq(workloadIdentityTokens.jti, issued.jti) }),
    ).toBeUndefined();
  });

  test("assessment identity uses its assessment owner and cascades when that owner is deleted", async () => {
    await ensureTestWorkspace();
    const assessmentId = `assessment-${crypto.randomUUID()}`;
    await db.insert(assessmentResults).values({ id: assessmentId, workspaceId: "workspace-1", status: "running" });
    const issued = await issueWorkspaceIdentityToken({
      organizationId: "org-1",
      organizationName: "example",
      projectId: "project-1",
      projectName: "default",
      workspaceId: "workspace-1",
      workspaceName: "network",
      runId: assessmentId,
      executionKind: "assessment",
      phase: "plan",
      audience: "aws.workload.identity",
      ttlSeconds: 600,
    });
    expect((await verifyWorkloadIdentityToken(issued.token))["jti"]).toBe(issued.jti);
    const record = await db.query.workloadIdentityTokens.findFirst({
      where: eq(workloadIdentityTokens.jti, issued.jti),
    });
    expect(record?.assessmentResultId).toBe(assessmentId);
    expect(record?.workspaceRunId).toBeNull();
    expect(record?.moduleTestRunId).toBeNull();
    await db.delete(assessmentResults).where(eq(assessmentResults.id, assessmentId));
    expect(
      await db.query.workloadIdentityTokens.findFirst({ where: eq(workloadIdentityTokens.jti, issued.jti) }),
    ).toBeUndefined();
    expect(await verifyWorkloadIdentityToken(issued.token).catch((error: unknown): unknown => error)).toBeInstanceOf(
      Error,
    );
  });

  test("injects one token for each manual audience", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terrence-oidc-test-"));
    try {
      const runId = `run-${crypto.randomUUID()}`;
      await ensureTestRun(runId);
      const result = await workspaceIdentityEnvironment(
        {
          organizationId: "org-1",
          organizationName: "example",
          projectId: "project-1",
          projectName: "default",
          workspaceId: "workspace-1",
          workspaceName: "network",
          runId,
          phase: "plan",
          ttlSeconds: 600,
        },
        [
          { key: "TFC_WORKLOAD_IDENTITY_AUDIENCE", value: "custom.one", category: "env" },
          { key: "TFC_WORKLOAD_IDENTITY_AUDIENCE_SECOND", value: "custom.two", category: "env" },
          { key: "TFC_HCP_PROVIDER_AUTH", value: "true", category: "env" },
          { key: "TFC_HCP_RUN_PROVIDER_RESOURCE_NAME", value: "iam/project/pool/provider", category: "env" },
          { key: "TFC_KUBERNETES_PROVIDER_AUTH", value: "true", category: "env" },
          { key: "TFC_KUBERNETES_WORKLOAD_IDENTITY_AUDIENCE", value: "kubernetes", category: "env" },
        ],
        directory,
      );
      expect(result.tokens).toHaveLength(4);
      expect(result.environment["TFC_WORKLOAD_IDENTITY_TOKEN"]).toBeString();
      expect(result.environment["TFC_WORKLOAD_IDENTITY_TOKEN_SECOND"]).toBeString();
      expect(result.environment["TFC_HCP_PROVIDER_AUTH"]).toBe("true");
      expect(result.environment["TFC_KUBERNETES_PROVIDER_AUTH"]).toBe("true");
      expect(result.environment["KUBE_TOKEN"]).toBeString();
      expect(result.tokens.map((token) => (jwt.decode(token.token) as Record<string, unknown>)["aud"]).sort()).toEqual([
        "custom.one",
        "custom.two",
        "iam/project/pool/provider",
        "kubernetes",
      ]);
      await db
        .update(workloadIdentityTokens)
        .set({ workspaceRunId: null })
        .where(eq(workloadIdentityTokens.runId, runId));
      expect((await verifyWorkloadIdentityToken(result.tokens[0]!.token))["jti"]).toBe(result.tokens[0]!.jti);
      await db.delete(runs).where(eq(runs.id, runId));
      const deleted = await verifyWorkloadIdentityToken(result.tokens[0]!.token).catch(
        (error: unknown): unknown => error,
      );
      expect(deleted).toBeInstanceOf(Error);
      expect((deleted as Error).message).toContain("execution is unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes standard discovery metadata and retains retired keys for live tokens", async () => {
    const discovery = await workloadIdentityRoutes.handle(
      new Request("http://localhost/.well-known/openid-configuration"),
    );
    const document = (await discovery.json()) as Record<string, unknown>;
    expect(document["id_token_signing_alg_values_supported"]).toEqual(["RS256"]);
    expect(document["subject_types_supported"]).toEqual(["public"]);
    expect(document["response_types_supported"]).toEqual(["id_token"]);

    const runId = `run-${crypto.randomUUID()}`;
    await ensureTestRun(runId);
    const issued = await issueWorkspaceIdentityToken({
      organizationId: "org-1",
      organizationName: "example",
      projectId: "project-1",
      projectName: "default",
      workspaceId: "workspace-1",
      workspaceName: "network",
      runId,
      phase: "plan",
      audience: "aws.workload.identity",
      ttlSeconds: 600,
    });
    await rotateWorkloadIdentityKey();
    await trimWorkloadIdentityKeys();
    const retired = await db.query.workloadIdentityKeys.findFirst({
      where: eq(workloadIdentityKeys.keyId, issued.keyId),
    });
    expect(retired?.revokedAt).toBeNull();
    expect((await verifyWorkloadIdentityToken(issued.token, "aws.workload.identity"))["jti"]).toBe(issued.jti);

    await db
      .update(workloadIdentityTokens)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(workloadIdentityTokens.jti, issued.jti));
    await trimWorkloadIdentityKeys();
    const expired = await db.query.workloadIdentityKeys.findFirst({
      where: eq(workloadIdentityKeys.keyId, issued.keyId),
    });
    expect(expired?.revokedAt).not.toBeNull();
  });
});
