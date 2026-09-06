import { describe, expect, it } from "bun:test";
import {
  ENDPOINT_POLICIES,
  isUploadPath,
  rateLimitClassFor,
  serverEndpointPath,
} from "../../src/lib/endpoint-policy";
import type { RateLimitClass } from "../../src/lib/endpoint-policy";

describe("endpoint-policy (465-469)", () => {
  // Representative samples: at least one path per auth/rate/body bucket is exercised.
  const probes: readonly { method: string; url: string; rate: RateLimitClass }[] = [
    { method: "GET", url: "http://x/api/v2/workspaces/ws-1/runs", rate: "workspace-run-history" },
    { method: "DELETE", url: "http://x/api/v2/admin/scim-settings", rate: "scim-settings" },
    { method: "POST", url: "http://x/api/v2/admin/teams/t-1/scim-group-mapping", rate: "scim-mapping" },
    { method: "POST", url: "http://x/oauth/token", rate: "sensitive" },
    { method: "GET", url: "http://x/oauth/authorization", rate: "sensitive" },
    { method: "GET", url: "http://x/oauth/authorization/complete", rate: "sensitive" },
    { method: "POST", url: "http://x/api/v2/account/mfa/verify", rate: "sensitive" },
    { method: "DELETE", url: "http://x/api/v2/account/mfa", rate: "sensitive" },
    { method: "GET", url: "http://x/users/saml/auth", rate: "sso-get" },
    { method: "GET", url: "http://x/api/v2/workspaces", rate: "global" },
    { method: "POST", url: "http://x/mcp", rate: "global" },
    { method: "GET", url: "http://x/scim/v2/Users", rate: "global" },
  ];

  for (const { method, url, rate } of probes) {
    it(`${method} ${url} -> ${rate}`, () => {
      expect(rateLimitClassFor({ method, url })).toBe(rate);
    });
  }

  // 465: every registry entry declares its auth class (not "unknown").
  it("every registry entry has an auth classification", () => {
    for (const e of ENDPOINT_POLICIES) expect(e.auth).not.toBe("unknown");
  });

  // 466: every registry entry has a bodyLimit classification.
  it("every registry entry has a body-limit classification", () => {
    for (const e of ENDPOINT_POLICIES) expect(["api", "upload", "none"]).toContain(e.bodyLimit);
  });

  // 467/468/469: audit + rate + permission surfaces are all declared.
  it("every registry entry has audit/rate", () => {
    for (const e of ENDPOINT_POLICIES) {
      expect(["admin","auth","workspace","run","none"]).toContain(e.audit);
      expect(["global","none","sensitive","sso-get","scim-settings","scim-mapping","workspace-run-history","metrics"]).toContain(e.rateLimit);
    }
  });

  // Static content stays outside rate limiting.
  it("static assets report serverEndpointPath=undefined", () => {
    expect(serverEndpointPath({ method: "GET", url: "http://x/assets/app.js" })).toBeUndefined();
    expect(serverEndpointPath({ method: "GET", url: "http://x/" })).toBeUndefined();
  });

  it("upload paths are recognized", () => {
    expect(isUploadPath("/api/v2/configuration-versions/cv-1/upload")).toBe(true);
    expect(isUploadPath("/api/v2/state-versions")).toBe(false);
  });

  // COMP-11 (#695): the sensitive core exercised by the principal matrix
  // (permission_principal_matrix.test.ts) must carry an explicit registry
  // declaration, so a refactor cannot silently drop a family back to the
  // undeclared global fallback. Concrete URLs mirror the matrix surfaces.
  const declared = (method: string, url: string): string => {
    const found = ENDPOINT_POLICIES.find((entry) => entry.match({ method, url }) !== undefined);
    expect(found, `${method} ${url}`).toBeDefined();
    return found?.id ?? "missing";
  };
  it("declares the secret-bearing state and plan reads", () => {
    expect(declared("GET", "http://x/api/v2/state-versions/sv-1/download")).toBe("state-secret-read");
    expect(declared("GET", "http://x/api/v2/state-versions/sv-1/json-download")).toBe("state-secret-read");
    expect(declared("GET", "http://x/api/v2/state-version-outputs/svo-1")).toBe("state-secret-read");
    expect(declared("GET", "http://x/api/v2/plans/plan-1/json-output")).toBe("state-secret-read");
    expect(declared("GET", "http://x/api/v2/runs/run-1/recovery-state")).toBe("state-secret-read");
    const entry = ENDPOINT_POLICIES.find((candidate) => candidate.id === "state-secret-read");
    expect(entry?.auth).toBe("authenticated");
    expect(entry?.audit).toBe("run");
    expect(entry?.secretResponse).toBe(true);
  });
  it("declares the scrubbed plan and state-reference reads", () => {
    expect(declared("GET", "http://x/api/v2/plans/plan-1/json-output-redacted")).toBe("state-safe-read");
    expect(declared("GET", "http://x/api/v2/plans/plan-1/sanitized-plan")).toBe("state-safe-read");
    expect(declared("GET", "http://x/api/v2/runs/run-1/input-state-version")).toBe("state-safe-read");
    const entry = ENDPOINT_POLICIES.find((candidate) => candidate.id === "state-safe-read");
    expect(entry?.auth).toBe("authenticated");
    expect(entry?.secretResponse).toBe(false);
  });
  it("declares workspace variables, run mutations, admin and MCP", () => {
    expect(declared("GET", "http://x/api/v2/workspaces/ws-1/vars")).toBe("workspace-vars");
    expect(declared("POST", "http://x/api/v2/workspaces/ws-1/vars")).toBe("workspace-vars");
    expect(declared("DELETE", "http://x/api/v2/workspaces/ws-1/vars/var-1")).toBe("workspace-vars");
    expect(declared("POST", "http://x/api/v2/runs")).toBe("run-mutations");
    expect(declared("POST", "http://x/api/v2/runs/run-1/actions/apply")).toBe("run-mutations");
    expect(declared("GET", "http://x/api/v2/admin/users")).toBe("admin");
    expect(declared("POST", "http://x/api/v2/admin/organizations/acme")).toBe("admin");
    expect(declared("POST", "http://x/mcp")).toBe("mcp-state");
    const admin = ENDPOINT_POLICIES.find((candidate) => candidate.id === "admin");
    expect(admin?.auth).toBe("admin");
    expect(admin?.audit).toBe("admin");
    const vars = ENDPOINT_POLICIES.find((candidate) => candidate.id === "workspace-vars");
    expect(vars?.secretResponse).toBe(true);
    const mcp = ENDPOINT_POLICIES.find((candidate) => candidate.id === "mcp-state");
    expect(mcp?.secretResponse).toBe(true);
  });
});
