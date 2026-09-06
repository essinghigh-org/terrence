import { afterEach, describe, expect, test } from "bun:test";
import {
  beginAuditRequest,
  buildAuditDetails,
  resetAuditRequest,
  sanitizeAuditValue,
  setAuditPrincipal,
} from "../../src/lib/audit-trail";

afterEach(() => { resetAuditRequest(); });

describe("audit event envelope", () => {
  test("captures request, credential and lifecycle context while redacting at construction", () => {
    beginAuditRequest("corr-753", "POST", "/api/v2/runs/run-1/actions/apply");
    setAuditPrincipal({
      userId: "user-1",
      tokenId: "token-1",
      orgId: null,
      scopes: {
        version: 1,
        orgs: ["org-1"],
        projects: null,
        workspaces: ["ws-1"],
        tags: null,
        permissions: { "runs:apply": true },
      },
      authenticated: true,
    });
    const event = buildAuditDetails({
      action: "apply",
      resourceType: "runs",
      resourceId: "run-1",
      orgId: "org-1",
      userId: "user-1",
      details: {
        fromStatus: "planned",
        toStatus: "applying",
        password: "do-not-store",
        rawToken: "bearer-material",
        callback: "https://example.invalid/callback?token=secret&safe=1",
      },
    });

    expect(event).toMatchObject({
      schemaVersion: 1,
      action: "apply",
      result: "success",
      immutable: true,
      requestId: "corr-753",
      correlationId: "corr-753",
      credentialClass: "user-token",
      effectiveScope: { kind: "fine-grained", orgs: ["org-1"], workspaces: ["ws-1"], permissions: ["runs:apply"] },
      actor: { userId: "user-1", effectiveUserId: "user-1", credentialClass: "user-token" },
      target: { orgId: "org-1", resourceType: "runs", resourceId: "run-1" },
      before: { status: "planned" },
      after: { status: "applying" },
    });
    expect(event["password"]).toBe("[REDACTED]");
    expect(event["rawToken"]).toBe("[REDACTED]");
    expect(String(event["callback"])).toContain("token=%5BREDACTED%5D");
    expect(String(event["callback"])).not.toContain("secret");
  });

  test("makes denied high-risk events immutable and bounds recursive input", () => {
    beginAuditRequest("corr-denied", "DELETE", "/api/v2/comments/c-1");
    setAuditPrincipal({ userId: "user-2", tokenId: "impersonation-token", authenticated: true });
    const event = buildAuditDetails({
      action: "delete",
      resourceType: "run-comments",
      resourceId: "c-1",
      orgId: "org-1",
      userId: "user-2",
      details: { reason: "not-authorized" },
      result: "denied",
      immutable: true,
    });
    expect(event).toMatchObject({ result: "denied", immutable: true, credentialClass: "impersonation-token" });

    let nested: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) nested = { nested };
    expect(JSON.stringify(sanitizeAuditValue(nested))).toContain("depth limit");
  });
});
