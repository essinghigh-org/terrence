import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizationMemberships, organizations, policySetParameters, policySets, users,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { variableValueForRead } from "../../src/lib/variable-crypto";
import { eq } from "drizzle-orm";

// Issue #577: policy-set parameters marked sensitive are encrypted at rest,
// rotate through updates, and stay redacted on reads.
describe("policy-set parameter encryption (#577)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const userId = `usr-psparam-${suffix}`;
  const orgId = `org-psparam-${suffix}`;
  const orgName = `psparam-${suffix}`;
  const token = `token-psparam-${suffix}`;
  const setId = `ps-psparam-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const createParam = (key: string, value: string, sensitive: boolean) => request(
    `/api/v2/policy-sets/${setId}/parameters`, "POST",
    { data: { type: "vars", attributes: { key, value, sensitive } } },
  );

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(policySets).values({ id: setId, orgId, name: `psparam-${suffix}` });
  });

  afterAll(async () => {
    await db.delete(policySetParameters).where(eq(policySetParameters.policySetId, setId)).catch((): void => {});
    await db.delete(policySets).where(eq(policySets.id, setId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.id, `tok-${suffix}`)).catch((): void => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, userId)).catch((): void => {});
  });

  it("encrypts sensitive parameters at rest and redacts reads", async () => {
    const res = await createParam("DB_PASSWORD", "s3cret", true);
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; attributes: { value: unknown } } };
    expect(body.data.attributes.value).toBeNull();
    const stored = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, body.data.id) });
    expect(stored?.value).toBe("");
    expect(stored?.valueEncrypted).toBeTruthy();
    expect(await variableValueForRead({ value: stored?.value ?? "", valueEncrypted: stored?.valueEncrypted ?? null })).toBe("s3cret");

    const list = await request(`/api/v2/policy-sets/${setId}/parameters`);
    expect(list.status).toBe(200);
    const listed = await list.json() as { data: { id: string; attributes: { value: unknown } }[] };
    expect(listed.data.find((p): boolean => p.id === body.data.id)?.attributes.value).toBeNull();
  });

  it("rotates sensitive values through updates", async () => {
    const created = await (await createParam("API_KEY", "first", true)).json() as { data: { id: string } };
    const before = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, created.data.id) });
    const patchRes = await request(`/api/v2/policy-sets/${setId}/parameters/${created.data.id}`, "PATCH", {
      data: { type: "vars", attributes: { value: "second" } },
    });
    expect(patchRes.status).toBe(200);
    const after = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, created.data.id) });
    expect(after?.valueEncrypted).not.toBe(before?.valueEncrypted);
    expect(await variableValueForRead({ value: after?.value ?? "", valueEncrypted: after?.valueEncrypted ?? null })).toBe("second");
  });

  it("keeps the secret on metadata-only updates", async () => {
    const created = await (await createParam("KEEP_ME", "stable", true)).json() as { data: { id: string } };
    const before = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, created.data.id) });
    const patchRes = await request(`/api/v2/policy-sets/${setId}/parameters/${created.data.id}`, "PATCH", {
      data: { type: "vars", attributes: { description: "note" } },
    });
    expect(patchRes.status).toBe(200);
    const after = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, created.data.id) });
    expect(await variableValueForRead({ value: after?.value ?? "", valueEncrypted: after?.valueEncrypted ?? null })).toBe("stable");
    expect(after?.valueEncrypted).toBeTruthy();
    expect(before?.value).toBe("");
  });

  it("refuses to downgrade a sensitive parameter without a replacement value", async () => {
    const created = await (await createParam("NO_DOWNGRADE", "topsecret", true)).json() as { data: { id: string } };
    const patchRes = await request(`/api/v2/policy-sets/${setId}/parameters/${created.data.id}`, "PATCH", {
      data: { type: "vars", attributes: { sensitive: false } },
    });
    expect(patchRes.status).toBe(200);
    const after = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, created.data.id) });
    expect(after?.sensitive).toBe(true);
    expect(after?.value).toBe("");
    expect(after?.valueEncrypted).toBeTruthy();
    expect(await variableValueForRead({ value: after?.value ?? "", valueEncrypted: after?.valueEncrypted ?? null })).toBe("topsecret");
  });

  it("refuses to downgrade a sensitive parameter with an explicit null value", async () => {
    const created = await (await createParam("NO_NULL_DOWNGRADE", "nullsecret", true)).json() as { data: { id: string } };
    const patchRes = await request(`/api/v2/policy-sets/${setId}/parameters/${created.data.id}`, "PATCH", {
      data: { type: "vars", attributes: { sensitive: false, value: null } },
    });
    expect(patchRes.status).toBe(200);
    const after = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, created.data.id) });
    expect(after?.sensitive).toBe(true);
    expect(after?.value).toBe("");
    expect(after?.valueEncrypted).toBeTruthy();
    expect(await variableValueForRead({ value: after?.value ?? "", valueEncrypted: after?.valueEncrypted ?? null })).toBe("nullsecret");
  });

  it("stores non-sensitive parameters in plaintext", async () => {
    const res = await createParam("REGION", "us-east-1", false);
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; attributes: { value: unknown } } };
    expect(body.data.attributes.value).toBe("us-east-1");
    const stored = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, body.data.id) });
    expect(stored?.value).toBe("us-east-1");
    expect(stored?.valueEncrypted).toBeNull();
  });
});
