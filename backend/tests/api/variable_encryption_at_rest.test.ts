import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq, like } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
  variableSetVariables,
  variableSets,
  workspaceVariables,
  workspaces,
} from "../../src/db/schema";
import { isEncryptedSecret } from "../../src/lib/secrets";

// Sensitive-variable encryption at rest (todo 167-169): sensitive workspace
// and variable-set values must be stored ONLY as enc:v1 ciphertext; the
// plaintext column holds "". Flipping sensitive on encrypts the existing
// value; list/get APIs never decrypt merely to serialize (170).
describe("sensitive variable encryption at rest", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `varenc-org-${suffix}`;
  const auth = `user-token-${suffix}`;
  const workspaceId = `ws-varenc-${suffix}`;
  const SECRET = "super-secret-value-do-not-leak";

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  let varsetId = "";

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: hashAuthenticationToken(auth), userId });
    await db.insert(workspaces).values({ id: workspaceId, name: `varenc-${suffix}`, orgId });
    const setRes = await request(`/api/v2/organizations/${orgName}/varsets`, "POST", {
      data: { type: "varsets", attributes: { name: "varenc-set", global: false } },
    });
    expect(setRes.status).toBe(201);
    varsetId = ((await setRes.json()) as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId));
    await db.delete(variableSetVariables).where(eq(variableSetVariables.variableSetId, varsetId));
    await db.delete(variableSets).where(eq(variableSets.id, varsetId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  const assertNoPlaintextInDb = async (): Promise<void> => {
    const wsRows = await db.select().from(workspaceVariables);
    for (const row of wsRows) {
      expect(row.value).not.toContain(SECRET);
    }
    const setRows = await db.select().from(variableSetVariables);
    for (const row of setRows) {
      expect(row.value).not.toContain(SECRET);
    }
  };

  it("workspace sensitive variable is stored encrypted; plaintext column empty", async () => {
    const res = await request(`/api/v2/workspaces/${workspaceId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "api_key", value: SECRET, category: "terraform", sensitive: true, hcl: false } },
    });
    expect(res.status).toBe(201);
    const row = await db.query.workspaceVariables.findFirst({
      where: eq(workspaceVariables.workspaceId, workspaceId),
    });
    expect(row).toBeDefined();
    expect(row!.sensitive).toBe(true);
    expect(row!.value).toBe("");
    expect(row!.valueEncrypted).not.toBeNull();
    expect(isEncryptedSecret(row!.valueEncrypted!)).toBe(true);
    await assertNoPlaintextInDb();
  });

  it("flipping sensitive false->true encrypts the existing plaintext value", async () => {
    const createRes = await request(`/api/v2/workspaces/${workspaceId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "flip_key", value: SECRET, category: "terraform", sensitive: false, hcl: false } },
    });
    expect(createRes.status).toBe(201);
    const varId = ((await createRes.json()) as { data: { id: string } }).data.id;
    const before = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, varId) });
    expect(before!.value).toBe(SECRET); // non-sensitive: plaintext is correct

    const patchRes = await request(`/api/v2/workspaces/${workspaceId}/vars/${varId}`, "PATCH", {
      data: { type: "vars", attributes: { sensitive: true } },
    });
    expect(patchRes.status).toBe(200);

    const after = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, varId) });
    expect(after!.sensitive).toBe(true);
    expect(after!.value).toBe("");
    expect(after!.valueEncrypted).not.toBeNull();
    expect(isEncryptedSecret(after!.valueEncrypted!)).toBe(true);
    await assertNoPlaintextInDb();
  });

  it("variable-set sensitive variable is stored encrypted and re-encrypted on PATCH", async () => {
    const createRes = await request(`/api/v2/varsets/${varsetId}/relationships/vars`, "POST", {
      data: { type: "vars", attributes: { key: "set_key", value: SECRET, category: "terraform", sensitive: true, hcl: false } },
    });
    expect([200, 201]).toContain(createRes.status);
    const varId = ((await createRes.json()) as { data: { id: string } }).data.id;
    const row = await db.query.variableSetVariables.findFirst({ where: eq(variableSetVariables.id, varId) });
    expect(row!.value).toBe("");
    expect(isEncryptedSecret(row!.valueEncrypted!)).toBe(true);

    const patchRes = await request(`/api/v2/varsets/${varsetId}/relationships/vars/${varId}`, "PATCH", {
      data: { type: "vars", attributes: { value: "rotated-secret-456" } },
    });
    expect(patchRes.status).toBe(200);
    const after = await db.query.variableSetVariables.findFirst({ where: eq(variableSetVariables.id, varId) });
    expect(after!.value).toBe("");
    expect(isEncryptedSecret(after!.valueEncrypted!)).toBe(true);
    expect(after!.valueEncrypted).not.toBeNull();
    await assertNoPlaintextInDb();

    // The rotated value decrypts back correctly via a fresh read of the row.
    expect(after!.valueEncrypted).not.toBe(row!.valueEncrypted);
  });

  it("list APIs never decrypt merely to serialize; sensitive values read as null", async () => {
    const listRes = await request(`/api/v2/workspaces/${workspaceId}/vars`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { attributes: { key: string; value: string | null; sensitive: boolean } }[] };
    const sensitiveItem = list.data.find((v) => v.attributes.key === "api_key");
    expect(sensitiveItem).toBeDefined();
    expect(sensitiveItem!.attributes.sensitive).toBe(true);
    expect(sensitiveItem!.attributes.value).toBeNull();
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(SECRET);
  });

  it("no legacy plaintext sensitive row remains anywhere (migration sweep)", async () => {
    // Every sensitive row must have an encrypted value and empty plaintext.
    const wsSensitive = await db.select().from(workspaceVariables).where(eq(workspaceVariables.sensitive, true));
    for (const row of wsSensitive) {
      expect(row.valueEncrypted).not.toBeNull();
      expect(isEncryptedSecret(row.valueEncrypted!)).toBe(true);
    }
    const setSensitive = await db.select().from(variableSetVariables).where(eq(variableSetVariables.sensitive, true));
    for (const row of setSensitive) {
      expect(row.valueEncrypted).not.toBeNull();
      expect(isEncryptedSecret(row.valueEncrypted!)).toBe(true);
    }
    // Defense in depth: no plaintext column anywhere holds the secret.
    const allWs = await db.select().from(workspaceVariables).where(like(workspaceVariables.value, `%${SECRET}%`));
    expect(allWs).toHaveLength(0);
    const allSet = await db.select().from(variableSetVariables).where(like(variableSetVariables.value, `%${SECRET}%`));
    expect(allSet).toHaveLength(0);
  });
});