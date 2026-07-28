import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { db } from "../db";
import {
  scimGroups, scimGroupMemberships, scimTokens, scimUserIdentities, scimSettings,
  users, organizationMemberships
} from "../db/schema";
import { eq, and, count, asc, inArray } from "drizzle-orm";

type SetObj = Readonly<{ status?: number | string; headers: Record<string, string | number> }>;

type RequestCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  request: Readonly<{ headers: { get(name: string): string | null }; url: string }>;
  set: SetObj;
}>;

async function validateScimToken(request: { headers: { get(name: string): string | null } }, set: SetObj): Promise<boolean> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) { (set as { status: number }).status = 401; return false; }
  const rawToken = auth.slice(7);
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const now = Date.now();
  const token = await db.query.scimTokens.findFirst({ where: eq(scimTokens.tokenHash, hash) });
  if (!token || token.expiresAt < now) { (set as { status: number }).status = 401; return false; }
  const settings = await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") });
  if (!settings?.enabled) { (set as { status: number }).status = 401; return false; }
  return true;
}

function scimError(set: SetObj, status: number, detail: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  set.headers["Content-Type"] = "application/scim+json";
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
}

export const scimRoutes = new Elysia({ name: "scim" })
  // Service Discovery
  .get("/scim/v2/ServiceProviderConfig", ({ set }: RequestCtx): Record<string, unknown> => {
    set.headers["Content-Type"] = "application/scim+json";
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://developer.hashicorp.com/terraform/enterprise/api-docs/scim",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { name: "OAuth Bearer Token", description: "Authentication via SCIM Bearer Token", type: "oauthbearertoken" }
      ]
    };
  })
  .get("/scim/v2/Schemas", ({ set }: RequestCtx): Record<string, unknown> => {
    set.headers["Content-Type"] = "application/scim+json";
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        { id: "urn:ietf:params:scim:schemas:core:2.0:User", name: "User", description: "User Account" },
        { id: "urn:ietf:params:scim:schemas:core:2.0:Group", name: "Group", description: "Group" }
      ]
    };
  })
  .get("/scim/v2/ResourceTypes", ({ set }: RequestCtx): Record<string, unknown> => {
    set.headers["Content-Type"] = "application/scim+json";
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        { id: "User", name: "User", endpoint: "/Users", schema: "urn:ietf:params:scim:schemas:core:2.0:User" },
        { id: "Group", name: "Group", endpoint: "/Groups", schema: "urn:ietf:params:scim:schemas:core:2.0:Group" }
      ]
    };
  })

  // Users
  .get("/scim/v2/Users", async ({ request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const identities = await db.query.scimUserIdentities.findMany();
    const userIds = identities.map((i) => i.userId);
    const userList = userIds.length === 0 ? [] : await db.query.users.findMany({ where: inArray(users.id, userIds) });
    const userMap = new Map(userList.map((u) => [u.id, u]));

    const resources = identities.map((i) => {
      const u = userMap.get(i.userId);
      return {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        id: i.id,
        userName: u?.username ?? i.id,
        name: { formatted: u?.username ?? i.id },
        emails: u?.email ? [{ value: u.email, primary: true }] : [],
        active: (u as Record<string, unknown> | undefined)?.isSuspended !== true,
        externalId: i.id,
      };
    });

    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  })
  .post("/scim/v2/Users", async ({ request, body, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const userName = typeof payload.userName === "string" ? payload.userName.trim() : "";
    if (userName === "") return scimError(set, 400, "userName is required");

    const emails = Array.isArray(payload.emails) ? payload.emails : [];
    const email = typeof (emails[0] as Record<string, unknown>)?.value === "string" ? ((emails[0] as Record<string, unknown>).value as string) : null;

    const userId = `user-${crypto.randomUUID()}`;
    const passwordHash = await Bun.password.hash(crypto.randomUUID());
    await db.insert(users).values({
      id: userId,
      username: userName,
      email,
      passwordHash,
      isSiteAdmin: false,
      mustChangePassword: false,
      createdAt: Date.now(),
    });

    const scimIdentityId = `scimuser-${crypto.randomUUID()}`;
    await db.insert(scimUserIdentities).values({
      id: scimIdentityId,
      userId,
      createdAt: Date.now(),
    });

    (set as { status: number }).status = 201;
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: scimIdentityId,
      userName,
      name: { formatted: userName },
      emails: email ? [{ value: email, primary: true }] : [],
      active: true,
      externalId: scimIdentityId,
    };
  })
  .get("/scim/v2/Users/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const identity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, params.id ?? "") });
    if (!identity) return scimError(set, 404, "User not found");
    const u = await db.query.users.findFirst({ where: eq(users.id, identity.userId) });

    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: identity.id,
      userName: u?.username ?? identity.id,
      name: { formatted: u?.username ?? identity.id },
      emails: u?.email ? [{ value: u.email, primary: true }] : [],
      active: (u as Record<string, unknown> | undefined)?.isSuspended !== true,
      externalId: identity.id,
    };
  })
  .delete("/scim/v2/Users/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const identity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, params.id ?? "") });
    if (!identity) return scimError(set, 404, "User not found");

    await db.delete(scimUserIdentities).where(eq(scimUserIdentities.id, identity.id));
    await db.delete(users).where(eq(users.id, identity.userId));

    (set as { status: number }).status = 204;
    return {};
  })

  // Groups
  .get("/scim/v2/Groups", async ({ request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const groupsList = await db.query.scimGroups.findMany();
    const resources = groupsList.map((g) => ({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      id: g.id,
      displayName: g.name,
      members: [],
    }));
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  })
  .post("/scim/v2/Groups", async ({ request, body, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const displayName = typeof payload.displayName === "string" ? payload.displayName.trim() : "";
    if (displayName === "") return scimError(set, 400, "displayName is required");

    const id = `scimgroup-${crypto.randomUUID()}`;
    await db.insert(scimGroups).values({ id, name: displayName, createdAt: Date.now() });

    (set as { status: number }).status = 201;
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      id,
      displayName,
      members: [],
    };
  })
  .get("/scim/v2/Groups/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const g = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, params.id ?? "") });
    if (!g) return scimError(set, 404, "Group not found");

    const memberships = await db.query.scimGroupMemberships.findMany({ where: eq(scimGroupMemberships.groupId, g.id) });
    const members = memberships.map((m) => ({ value: m.scimUserId }));

    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      id: g.id,
      displayName: g.name,
      members,
    };
  })
  .delete("/scim/v2/Groups/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const g = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, params.id ?? "") });
    if (!g) return scimError(set, 404, "Group not found");

    await db.delete(scimGroups).where(eq(scimGroups.id, g.id));
    (set as { status: number }).status = 204;
    return {};
  });
