import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
  variableSets,
  variableSetVariables,
  variableSetWorkspaces,
  workspaceVariables,
  workspaces,
} from "../../src/db/schema";

describe("workspace all-vars (audit finding 1)", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const outsiderId = `outsider-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `allvars-${suffix}`;
  const foreignOrgId = `foreign-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const outsiderToken = `outsider-token-${suffix}`;
  const wsId = `ws-${suffix}`;
  const detachedWsId = `detached-${suffix}`;
  const foreignWsId = `foreign-${suffix}`;

  const request = (path: string, auth?: string) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method: "GET",
      headers: auth === undefined ? {} : { Authorization: "Bearer " + auth },
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: userId, passwordHash: "unused" },
      { id: outsiderId, username: outsiderId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: foreignOrgId, name: `foreign-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: outsiderId, orgId: foreignOrgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: hashAuthenticationToken(token), userId },
      { id: crypto.randomUUID(), token: hashAuthenticationToken(outsiderToken), userId: outsiderId },
    ]);
    await db.insert(workspaces).values([
      { id: wsId, name: `ws-${suffix}`, orgId },
      { id: detachedWsId, name: `detached-${suffix}`, orgId },
      { id: foreignWsId, name: `foreign-${suffix}`, orgId: foreignOrgId },
    ]);
    await db.insert(workspaceVariables).values([
      { id: `wsv-shared-${suffix}`, workspaceId: wsId, key: "SHARED", value: "from-workspace", category: "terraform" },
      { id: `wsv-wsonly-${suffix}`, workspaceId: wsId, key: "WS_ONLY", value: "1", category: "terraform" },
      { id: `wsv-secret-${suffix}`, workspaceId: wsId, key: "SECRET", value: "", valueEncrypted: "enc:v1:fake", sensitive: true, category: "terraform" },
      { id: `wsv-k-${suffix}`, workspaceId: wsId, key: "K", value: "from-workspace", category: "terraform" },
    ]);
    const setA = `set-a-${suffix}`;
    const setGlobal = `set-global-${suffix}`;
    const setPriority = `set-priority-${suffix}`;
    const setDetached = `set-detached-${suffix}`;
    const setForeign = `set-foreign-${suffix}`;
    await db.insert(variableSets).values([
      { id: setA, orgId, name: `a-${suffix}` },
      { id: setGlobal, orgId, name: `global-${suffix}`, global: true },
      { id: setPriority, orgId, name: `priority-${suffix}`, priority: true },
      { id: setDetached, orgId, name: `detached-${suffix}` },
      { id: setForeign, orgId: foreignOrgId, name: `foreign-${suffix}` },
    ]);
    await db.insert(variableSetWorkspaces).values([
      { id: crypto.randomUUID(), variableSetId: setA, workspaceId: wsId },
      { id: crypto.randomUUID(), variableSetId: setPriority, workspaceId: wsId },
      { id: crypto.randomUUID(), variableSetId: setDetached, workspaceId: detachedWsId },
      { id: crypto.randomUUID(), variableSetId: setForeign, workspaceId: foreignWsId },
    ]);
    await db.insert(variableSetVariables).values([
      { id: `vsv-shared-${suffix}`, variableSetId: setA, key: "SHARED", value: "from-set", category: "terraform" },
      { id: `vsv-setonly-${suffix}`, variableSetId: setA, key: "SET_ONLY", value: "2", category: "terraform" },
      { id: `vsv-k-${suffix}`, variableSetId: setA, key: "K", value: "from-set-env", category: "env" },
      { id: `vsv-global-${suffix}`, variableSetId: setGlobal, key: "GLOBAL_ONLY", value: "3", category: "terraform" },
      { id: `vsv-globalshared-${suffix}`, variableSetId: setGlobal, key: "SHARED", value: "from-global", category: "terraform" },
      { id: `vsv-priority-${suffix}`, variableSetId: setPriority, key: "SHARED", value: "from-priority", category: "terraform" },
      { id: `vsv-detached-${suffix}`, variableSetId: setDetached, key: "DETACHED_ONLY", value: "9", category: "terraform" },
      { id: `vsv-foreign-${suffix}`, variableSetId: setForeign, key: "FOREIGN", value: "9", category: "terraform" },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [orgId, foreignOrgId]));
    await db.delete(users).where(inArray(users.id, [userId, outsiderId]));
  });

  it("returns workspace variables plus inherited varset variables with CLI precedence", async () => {
    const res = await request(`/api/v2/workspaces/${wsId}/all-vars`, token);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> }[];
      meta: { pagination: Record<string, unknown> };
    };
    const byKey: Record<string, unknown[]> = {};
    for (const item of body.data) {
      const key = String((item.attributes as Record<string, unknown>)["key"]);
      byKey[key] = [...(byKey[key] ?? []), item.attributes];
    }
    const valueOf = (key: string): unknown =>
      (byKey[key]?.[0] as Record<string, unknown> | undefined)?.["value"];
    // Priority set beats workspace beats attached set beats global.
    expect(valueOf("SHARED")).toBe("from-priority");
    expect(valueOf("WS_ONLY")).toBe("1");
    expect(valueOf("SET_ONLY")).toBe("2");
    expect(valueOf("GLOBAL_ONLY")).toBe("3");
    // Category splits the dedupe key: both K rows survive.
    expect((byKey["K"] ?? []).length).toBe(2);
    // Sensitive values stay redacted even though the row is encrypted at rest.
    expect(valueOf("SECRET")).toBeNull();
    expect((byKey["SECRET"]?.[0] as Record<string, unknown>)?.["sensitive"]).toBe(true);
    // Unattached and foreign sets never leak across the workspace boundary.
    expect(byKey["DETACHED_ONLY"]).toBeUndefined();
    expect(byKey["FOREIGN"]).toBeUndefined();
    expect(body.meta.pagination["total-count"]).toBe(7);
  });

  it("serializes workspace and varset rows with their own relationships", async () => {
    const res = await request(`/api/v2/workspaces/${wsId}/all-vars`, token);
    const body = await res.json() as {
      data: { id: string; relationships?: { workspace?: unknown; varset?: unknown } }[];
    };
    const kinds = new Set(body.data.map((item): string => {
      if (item.relationships?.workspace !== undefined) return "workspace";
      if (item.relationships?.varset !== undefined) return "varset";
      return "none";
    }));
    expect(kinds.has("workspace")).toBe(true);
    expect(kinds.has("varset")).toBe(true);
    expect(kinds.has("none")).toBe(false);
  });

  it("hides the list from outsiders and unauthenticated callers", async () => {
    expect((await request(`/api/v2/workspaces/${wsId}/all-vars`, outsiderToken)).status).toBe(404);
    expect((await request(`/api/v2/workspaces/${wsId}/all-vars`)).status).toBe(404);
  });
});
