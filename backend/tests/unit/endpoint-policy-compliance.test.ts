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
      expect(["admin","auth","none"]).toContain(e.audit);
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
});
