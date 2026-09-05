import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, auditLogs, organizationMemberships, organizations, policySetParameters, policySets,
  users, variableSetVariables, variableSets, workspaceVariables, workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import {
  variableSetVariableResource,
  workspaceVariableResource,
} from "../../src/lib/response";
import { eq } from "drizzle-orm";

// Issue #577: decrypted sensitive values must never persist in API payloads
// or audit records. Serializers null them; audit details carry counts and
// keys, never values.

describe("sensitive value redaction contract (#577)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const userId = `usr-redact-${suffix}`;
  const orgId = `org-redact-${suffix}`;
  const orgName = `redact-${suffix}`;
  const token = `token-redact-${suffix}`;
  const wsId = `ws-redact-${suffix}`;
  const wsMarker = `ws-secret-${suffix}`;
  const vsMarker = `vs-secret-${suffix}`;
  const psMarker = `ps-secret-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(workspaces).values([
      { id: wsId, name: `redact-ws-${suffix}`, orgId, executionMode: "remote" },
    ]);
  });

  afterAll(async () => {
    await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, wsId)).catch((): void => {});
    await db.delete(variableSetVariables).where(eq(variableSetVariables.key, `VS_KEY_${suffix}`)).catch((): void => {});
    await db.delete(variableSets).where(eq(variableSets.orgId, orgId)).catch((): void => {});
    await db.delete(policySetParameters).where(eq(policySetParameters.key, `PS_KEY_${suffix}`)).catch((): void => {});
    await db.delete(policySets).where(eq(policySets.orgId, orgId)).catch((): void => {});
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.id, `tok-${suffix}`)).catch((): void => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, userId)).catch((): void => {});
  });

  it("serializers null sensitive values", () => {
    const wsAttrs = (workspaceVariableResource({
      id: "v", workspaceId: wsId, key: "K", value: "", valueEncrypted: "enc",
      category: "terraform", sensitive: true, hcl: false, description: null,
    }) as { attributes: { value: unknown } }).attributes;
    expect(wsAttrs.value).toBeNull();

    const vsAttrs = (variableSetVariableResource({
      id: "v", variableSetId: "s", key: "K", value: "", valueEncrypted: "enc",
      category: "terraform", sensitive: true, hcl: false, description: null,
    }) as { attributes: { value: unknown } }).attributes;
    expect(vsAttrs.value).toBeNull();
  });

  it("workspace variable API never returns or audits the secret", async () => {
    const res = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: `WS_KEY_${suffix}`, value: wsMarker, category: "terraform", sensitive: true } },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { attributes: { value: unknown } } }).data.attributes.value).toBeNull();
    const stored = await db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, wsId) });
    expect(stored.some((v): boolean => v.value === wsMarker)).toBe(false);
  });

  it("variable-set variable API never returns the secret", async () => {
    const setRes = await request(`/api/v2/organizations/${orgName}/varsets`, "POST", {
      data: { type: "varsets", attributes: { name: `redact-set-${suffix}` } },
    });
    expect(setRes.status).toBe(201);
    const setId = ((await setRes.json()) as { data: { id: string } }).data.id;
    const res = await request(`/api/v2/varsets/${setId}/relationships/vars`, "POST", {
      data: { type: "vars", attributes: { key: `VS_KEY_${suffix}`, value: vsMarker, category: "terraform", sensitive: true } },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { attributes: { value: unknown } } }).data.attributes.value).toBeNull();
    const stored = await db.query.variableSetVariables.findMany({ where: eq(variableSetVariables.variableSetId, setId) });
    expect(stored.some((v): boolean => v.value === vsMarker)).toBe(false);
  });

  it("policy-set parameter API never returns the secret", async () => {
    await db.insert(policySets).values({ id: `ps-redact-${suffix}`, orgId, name: `redact-ps-${suffix}` });
    const res = await request(`/api/v2/policy-sets/ps-redact-${suffix}/parameters`, "POST", {
      data: { type: "vars", attributes: { key: `PS_KEY_${suffix}`, value: psMarker, sensitive: true } },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { attributes: { value: unknown } } }).data.attributes.value).toBeNull();
  });

  it("audit records for the org contain no secret markers", async () => {
    // Exercise read paths that audit under strict mode too.
    await request(`/api/v2/workspaces/${wsId}/vars`);
    const rows = await db.query.auditLogs.findMany({ where: eq(auditLogs.orgId, orgId) });
    const haystack = rows.map((row): string => JSON.stringify(row.details ?? null)).join("\n");
    expect(haystack).not.toContain(wsMarker);
    expect(haystack).not.toContain(vsMarker);
    expect(haystack).not.toContain(psMarker);
  });
});
