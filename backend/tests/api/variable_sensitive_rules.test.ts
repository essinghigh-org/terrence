import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizations,
  organizationMemberships,
  users,
  workspaceVariables,
  workspaces,
} from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecret, isEncryptedSecret } from "../../src/lib/secrets";

// VAR-006: sensitive variable update / unset / reveal rules.
//
// the reference format contract pinned here:
//  - a sensitive variable's value is NEVER returned in list/get/patch
//    responses (revealed only through the dedicated reveal action, which this
//    server does not implement — so the value must stay null everywhere);
//  - the sensitive flag cannot be cleared without also supplying a new value
//    (PATCHing attributes with sensitive=false but no value keeps it sensitive);
//  - supplying a new value while toggling sensitive=false does update the value
//    and clears the flag.

describe("workspace variable sensitive rules (VAR-006)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const username = `varsec-${suffix}`;
  const orgName = `varsec-org-${suffix}`;
  const tokenId = `tok-varsec-${suffix}`;
  const orgId = `org-varsec-${suffix}`;
  const wsId = `ws-varsec-${suffix}`;
  let userToken = "";

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${userToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values({ id: `user-varsec-${suffix}`, username, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: `mem-varsec-${suffix}`, userId: `user-varsec-${suffix}`, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: tokenId, token: hashAuthenticationToken(`varsec-token-${suffix}`), userId: `user-varsec-${suffix}` });
    userToken = `varsec-token-${suffix}`;
    await db.insert(workspaces).values({ id: wsId, name: `varsec-ws-${suffix}`, orgId });
  });

  afterAll(async () => {
    await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-varsec-${suffix}`));
    await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, `user-varsec-${suffix}`));
  });

  it("returns null value for a sensitive variable on create", async () => {
    const res = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "secret", value: "topsecret", sensitive: true } },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.attributes.sensitive).toBe(true);
    expect(body.data.attributes.value).toBeNull();
  });

  it("keeps the value hidden on GET of a sensitive variable", async () => {
    const created = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "hidden", value: "dontleak", sensitive: true } },
    });
    const id = (await created.json()).data.id as string;
    const getRes = await request(`/api/v2/workspaces/${wsId}/vars/${id}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.data.attributes.value).toBeNull();
    expect(body.data.attributes.sensitive).toBe(true);
  });

  it("cannot unset sensitive without supplying a new value", async () => {
    const created = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "sticky", value: "original", sensitive: true } },
    });
    const id = (await created.json()).data.id as string;

    const patch = await request(`/api/v2/workspaces/${wsId}/vars/${id}`, "PATCH", {
      data: { type: "vars", attributes: { sensitive: false } },
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched.data.attributes.sensitive).toBe(true);
    expect(patched.data.attributes.value).toBeNull();

    // The stored value is unchanged (still the original) — now encrypted.
    const stored = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, id) });
    expect(stored?.valueEncrypted).not.toBeNull();
    expect(isEncryptedSecret(stored!.valueEncrypted!)).toBe(true);
    expect(await decryptSecret(stored!.valueEncrypted!)).toBe("original");
    expect(stored?.value).toBe("");
    expect(stored?.sensitive).toBe(true);
  });

  it("updates value and clears sensitive when a new value is supplied", async () => {
    const created = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "cleared", value: "before", sensitive: true } },
    });
    const id = (await created.json()).data.id as string;

    const patch = await request(`/api/v2/workspaces/${wsId}/vars/${id}`, "PATCH", {
      data: { type: "vars", attributes: { sensitive: false, value: "after" } },
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched.data.attributes.sensitive).toBe(false);
    // Now non-sensitive, the value is returned.
    expect(patched.data.attributes.value).toBe("after");

    const stored = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, id) });
    expect(stored?.sensitive).toBe(false);
    expect(stored?.value).toBe("after");
  });

  it("rotates the value on PATCH while keeping the variable sensitive (never echoes it)", async () => {
    const created = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "rotated", value: "first", sensitive: true } },
    });
    const id = (await created.json()).data.id as string;

    const patch = await request(`/api/v2/workspaces/${wsId}/vars/${id}`, "PATCH", {
      data: { type: "vars", attributes: { value: "second", sensitive: true } },
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    // Sensitive stays true and the value is never returned in the response.
    expect(patched.data.attributes.sensitive).toBe(true);
    expect(patched.data.attributes.value).toBeNull();

    // The stored value did rotate (and is encrypted at rest).
    const stored = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, id) });
    expect(stored?.valueEncrypted).not.toBeNull();
    expect(isEncryptedSecret(stored!.valueEncrypted!)).toBe(true);
    expect(await decryptSecret(stored!.valueEncrypted!)).toBe("second");
    expect(stored?.value).toBe("");
    expect(stored?.sensitive).toBe(true);
  });

  it("excludes sensitive values from the workspace var list", async () => {
    const createdSecret = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "listsecret", value: "hiddenval", sensitive: true } },
    });
    expect(createdSecret.status).toBe(201);
    const createdPlain = await request(`/api/v2/workspaces/${wsId}/vars`, "POST", {
      data: { type: "vars", attributes: { key: "listplain", value: "plainval", sensitive: false } },
    });
    expect(createdPlain.status).toBe(201);
    const list = await request(`/api/v2/workspaces/${wsId}/vars`);
    expect(list.status).toBe(200);
    const body = await list.json() as { data: { attributes: Record<string, unknown> }[] };
    const byKey = new Map(body.data.map((v) => [v.attributes["key"] as string, v.attributes]));
    expect(byKey.get("listsecret")?.["value"]).toBeNull();
    expect(byKey.get("listsecret")?.["sensitive"]).toBe(true);
    expect(byKey.get("listplain")?.["value"]).toBe("plainval");
  });
});
