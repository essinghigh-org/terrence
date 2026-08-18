import { afterEach, describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../src/db";
import { workloadIdentityKeys, workloadIdentityTokens } from "../../src/db/schema";
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

afterEach(async (): Promise<void> => {
  await db.delete(workloadIdentityTokens);
  await db.delete(workloadIdentityKeys);
});

describe("workload identity", () => {
  test("issues a module-test token with the documented subject and validity window", async () => {
    const runId = `module-run-${crypto.randomUUID()}`;
    const issued = await issueModuleTestIdentityToken({
      organizationId: "org-1",
      organizationName: "example",
      moduleName: "network",
      runId,
      audience: "aws.workload.identity",
      ttlSeconds: 600,
    });
    const claims = jwt.decode(issued.token) as Record<string, unknown>;
    expect(claims.sub).toBe("organization:example:module:network:operation:test_run");
    expect(claims.terraform_run_phase).toBe("plan");
    expect(Number(claims.nbf)).toBe(Number(claims.iat) - 30);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
    expect((await verifyWorkloadIdentityToken(issued.token, "aws.workload.identity")).jti).toBe(issued.jti);

    await revokeWorkloadIdentityTokens(runId);
    const revoked = verifyWorkloadIdentityToken(issued.token, "aws.workload.identity");
    await expect(revoked).rejects.toThrow("revoked");
  });

  test("injects one token for each manual audience", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terrence-oidc-test-"));
    try {
      const result = await workspaceIdentityEnvironment({
        organizationId: "org-1",
        organizationName: "example",
        projectId: "project-1",
        projectName: "default",
        workspaceId: "workspace-1",
        workspaceName: "network",
        runId: `run-${crypto.randomUUID()}`,
        phase: "plan",
        ttlSeconds: 600,
      }, [
        { key: "TFC_WORKLOAD_IDENTITY_AUDIENCE", value: "custom.one", category: "env" },
        { key: "TFC_WORKLOAD_IDENTITY_AUDIENCE_SECOND", value: "custom.two", category: "env" },
        { key: "TFC_HCP_PROVIDER_AUTH", value: "true", category: "env" },
        { key: "TFC_HCP_RUN_PROVIDER_RESOURCE_NAME", value: "iam/project/pool/provider", category: "env" },
        { key: "TFC_KUBERNETES_PROVIDER_AUTH", value: "true", category: "env" },
        { key: "TFC_KUBERNETES_WORKLOAD_IDENTITY_AUDIENCE", value: "kubernetes", category: "env" },
      ], directory);
      expect(result.tokens).toHaveLength(4);
      expect(result.environment.TFC_WORKLOAD_IDENTITY_TOKEN).toBeString();
      expect(result.environment.TFC_WORKLOAD_IDENTITY_TOKEN_SECOND).toBeString();
      expect(result.environment.TFC_HCP_PROVIDER_AUTH).toBe("true");
      expect(result.environment.TFC_KUBERNETES_PROVIDER_AUTH).toBe("true");
      expect(result.environment.KUBE_TOKEN).toBeString();
      expect(result.tokens.map((token) => (jwt.decode(token.token) as Record<string, unknown>).aud).sort()).toEqual([
        "custom.one",
        "custom.two",
        "iam/project/pool/provider",
        "kubernetes",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes standard discovery metadata and retains retired keys for live tokens", async () => {
    const discovery = await workloadIdentityRoutes.handle(new Request("http://localhost/.well-known/openid-configuration"));
    const document = await discovery.json() as Record<string, unknown>;
    expect(document.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(document.subject_types_supported).toEqual(["public"]);
    expect(document.response_types_supported).toEqual(["id_token"]);

    const issued = await issueWorkspaceIdentityToken({
      organizationId: "org-1",
      organizationName: "example",
      projectId: "project-1",
      projectName: "default",
      workspaceId: "workspace-1",
      workspaceName: "network",
      runId: `run-${crypto.randomUUID()}`,
      phase: "plan",
      audience: "aws.workload.identity",
      ttlSeconds: 600,
    });
    await rotateWorkloadIdentityKey();
    await trimWorkloadIdentityKeys();
    const retired = await db.query.workloadIdentityKeys.findFirst({ where: eq(workloadIdentityKeys.keyId, issued.keyId) });
    expect(retired?.revokedAt).toBeNull();
    expect((await verifyWorkloadIdentityToken(issued.token, "aws.workload.identity")).jti).toBe(issued.jti);

    await db.update(workloadIdentityTokens).set({ expiresAt: Date.now() - 1 }).where(eq(workloadIdentityTokens.jti, issued.jti));
    await trimWorkloadIdentityKeys();
    const expired = await db.query.workloadIdentityKeys.findFirst({ where: eq(workloadIdentityKeys.keyId, issued.keyId) });
    expect(expired?.revokedAt).not.toBeNull();
  });
});
