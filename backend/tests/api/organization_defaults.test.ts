import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, users } from "../../src/db/schema";

/**
 * ORG-010: Organization creation/update validation & defaults — field-by-field.
 *
 * Pins the substantive reference-format-compatible defaults that Terrence applies on create
 * (src/routes/organizations.ts:148) and the update-preservation behavior on
 * PATCH (organizations.ts:534). A refactor that silently flips a default or
 * forgets to preserve a field on update will be caught here.
 */
describe("Organization create/update defaults (ORG-010)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const token = `token-${suffix}`;
  const user = `owner-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: user, passwordHash: "unused" });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
  });

  const prefix = `${user}-`;

  afterAll(async () => {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    // Clean up all orgs created in this run by name.
    for (const name of [`${prefix}defaults`, `${prefix}update`, `${prefix}badbin`, `${prefix}badmode`]) {
      await db.delete(organizations).where(eq(organizations.name, name));
    }
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("applies reference-format-compatible defaults on creation with a minimal body", async () => {
    const res = await request("/api/v2/organizations", "POST", {
      data: { type: "organizations", attributes: { name: `${prefix}defaults` } },
    });
    expect(res.status).toBe(201);
    const attrs = (await res.json()).data.attributes;

    // Defaults that must be present on a bare create.
    expect(attrs["default-iac-binary"]).toBe("terraform");
    expect(attrs["default-terraform-version"]).toBe("latest");
    expect(attrs["default-execution-mode"]).toBe("remote");
    expect(attrs["collaborator-auth-policy"]).toBe("password");
    expect(attrs["user-tokens-enabled"]).toBe(true);
    expect(attrs["allow-force-delete-workspaces"]).toBe(true);
    expect(attrs["cost-estimation-enabled"]).toBe(false);
    expect(attrs["stacks-enabled"]).toBe(false);
    expect(attrs["show-pre-releases"]).toBe(false);
    expect(attrs["session-timeout"]).toBe(null);
    expect(attrs["session-remember"]).toBe(null);
    expect(attrs["assessments-enforced"]).toBe(false);
    expect(attrs["aggregated-commit-status-enabled"]).toBe(true);
    expect(attrs["send-passing-statuses-for-untriggered-speculative-plans"]).toBe(false);
    expect(attrs["speculative-plan-management-enabled"]).toBe(true);
  });

  it("preserves unset fields on PATCH (no data loss / no silent flips)", async () => {
    const orgName = `${prefix}update`;
    // Create with known values.
    const created = await request("/api/v2/organizations", "POST", {
      data: {
        type: "organizations",
        attributes: {
          name: orgName,
          email: "before@homelab.local",
          "default-iac-binary": "tofu",
          "default-terraform-version": "1.9.0",
          "default-execution-mode": "local",
        },
      },
    });
    expect(created.status).toBe(201);

    // PATCH only the email — everything else must be preserved.
    const patched = await request(`/api/v2/organizations/${orgName}`, "PATCH", {
      data: {
        type: "organizations",
        attributes: { email: "after@homelab.local" },
      },
    });
    expect(patched.status).toBe(200);
    const attrs = (await patched.json()).data.attributes;
    expect(attrs.email).toBe("after@homelab.local");
    // Preserved, not reset to defaults.
    expect(attrs["default-iac-binary"]).toBe("tofu");
    expect(attrs["default-terraform-version"]).toBe("1.9.0");
    expect(attrs["default-execution-mode"]).toBe("local");
    expect(attrs["collaborator-auth-policy"]).toBe("password");
    expect(attrs["user-tokens-enabled"]).toBe(true);
    expect(attrs["allow-force-delete-workspaces"]).toBe(true);
    expect(attrs["aggregated-commit-status-enabled"]).toBe(true);
  });

  it("rejects an invalid default-iac-binary on create (strict allowlist)", async () => {
    const badBinary = await request("/api/v2/organizations", "POST", {
      data: { type: "organizations", attributes: { name: `${prefix}badbin`, "default-iac-binary": "opentofu" } },
    });
    expect(badBinary.status).toBe(422);
  });

  it("rejects an explicitly-supplied invalid default-execution-mode (the reference format parity)", async () => {
    // the reference format returns 422 for unsupported execution modes. Terrence now validates
    // the mode before applying the "remote" default, so "serverless" is rejected
    // rather than silently coerced.
    const badMode = await request("/api/v2/organizations", "POST", {
      data: { type: "organizations", attributes: { name: `${prefix}badmode`, "default-execution-mode": "serverless" } },
    });
    expect(badMode.status).toBe(422);
  });
});