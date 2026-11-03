import { test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  users,
  organizations,
  organizationMemberships,
  apiTokens,
  registryModules,
  registryProviders,
  registryComponents,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

for (const kind of ["modules", "providers", "components"] as const) {
  test(`registry ${kind}: provider tag lifecycle, validation and tenant authorization`, async () => {
    const id = crypto.randomUUID();
    const org = `org-${id}`;
    const token = `token-${id}`;
    const member = `member-${id}`;
    const memberToken = `member-token-${id}`;
    await db.insert(users).values([
      { id, username: id, passwordHash: "fixture" },
      { id: member, username: member, passwordHash: "fixture" },
    ]);
    await db.insert(organizations).values({ id: org, name: org });
    await db.insert(organizationMemberships).values([
      { id, orgId: org, userId: id, role: "owner", status: "active" },
      { id: member, orgId: org, userId: member, role: "member", status: "active" },
    ]);
    await db.insert(apiTokens).values([
      { id, userId: id, token: hashAuthenticationToken(token) },
      { id: member, userId: member, token: hashAuthenticationToken(memberToken) },
    ]);
    if (kind === "modules")
      await db.insert(registryModules).values({ id, orgId: org, namespace: org, name: "example", provider: "aws" });
    if (kind === "providers")
      await db.insert(registryProviders).values({ id, orgId: org, namespace: org, type: "example" });
    if (kind === "components")
      await db.insert(registryComponents).values({ id, orgId: org, name: "example", sourceIdentifier: "example" });
    const readPath = `/api/v2/registry-${kind}/${id}/tag-bindings`;
    const updatePath =
      kind === "components"
        ? `/api/v2/registry-components/${id}`
        : `/api/v2/organizations/${org}/registry-${kind}/private/${org}/example${kind === "modules" ? "/aws" : ""}`;
    const request = (path: string, method = "GET", data?: unknown, auth = token) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/vnd.api+json" },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        }),
      );
    const payload = (tags: { key: string; value?: unknown }[]) => ({
      data: {
        type: `registry-${kind}`,
        relationships: { "tag-bindings": { data: tags.map((attributes) => ({ type: "tag-bindings", attributes })) } },
      },
    });
    try {
      expect((await (await request(readPath)).json()).data).toEqual([]);
      expect(
        (await request(updatePath, "PATCH", payload([{ key: "env", value: "dev" }, { key: "empty" }]))).status,
      ).toBe(200);
      const first = (await (await request(readPath)).json()).data;
      expect(first.map((tag: { attributes: unknown }) => tag.attributes)).toEqual([
        { key: "env", value: "dev" },
        { key: "empty", value: "" },
      ]);
      expect((await request(updatePath, "PATCH", payload([{ key: "env", value: "prod" }]))).status).toBe(200);
      const updated = (await (await request(readPath)).json()).data;
      expect(updated).toEqual([{ id: first[0].id, type: "tag-bindings", attributes: { key: "env", value: "prod" } }]);
      for (const invalid of [[{ key: "" }], [{ key: "env" }, { key: "env" }], [{ key: "env", value: 42 }]]) {
        expect((await request(updatePath, "PATCH", payload(invalid))).status).toBe(422);
      }
      expect((await (await request(readPath)).json()).data).toEqual(updated);
      expect((await request(readPath, "GET", undefined, "invalid-token")).status).toBe(404);
      expect((await request(updatePath, "PATCH", payload([]), memberToken)).status).toBe(404);
      expect((await (await request(readPath)).json()).data).toEqual(updated);
      expect((await request(updatePath, "PATCH", payload([]))).status).toBe(200);
      expect((await (await request(readPath)).json()).data).toEqual([]);
      expect((await request(readPath.replace(id, "absent"))).status).toBe(404);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, org));
      await db.delete(users).where(eq(users.id, id));
      await db.delete(users).where(eq(users.id, member));
    }
  });
}
