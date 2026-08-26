import { expect } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, systemApiTokens, users } from "../../src/db/schema";
import { hashSystemApiToken } from "../../src/lib/system-api";

export type OrgSeed = {
  suffix: string;
  userId: string;
  username: string;
  orgId: string;
  orgName: string;
  token: string;
  tokenId: string;
  membershipId: string;
  systemToken: string;
  systemTokenId: string;
}

export function seedOrg(prefix: string): OrgSeed {
  const suffix = crypto.randomUUID();
  return {
    suffix,
    userId: `user-${prefix}-${suffix}`,
    username: `${prefix}-${suffix}`,
    orgId: `org-${prefix}-${suffix}`,
    orgName: `${prefix}-${suffix}`,
    token: `token-${prefix}-${suffix}`,
    tokenId: `token-id-${prefix}-${suffix}`,
    membershipId: `membership-${prefix}-${suffix}`,
    systemToken: `tfe-system-${crypto.randomUUID()}${suffix}`,
    systemTokenId: `system-token-${prefix}-${suffix}`,
  };
}

export async function persistSeed(seed: OrgSeed): Promise<void> {
  await db.insert(users).values({ id: seed.userId, username: seed.username, passwordHash: "unused" });
  await db.insert(organizations).values({ id: seed.orgId, name: seed.orgName });
  await db.insert(organizationMemberships).values({
    id: seed.membershipId,
    userId: seed.userId,
    orgId: seed.orgId,
    role: "owner",
  });
  await db.insert(apiTokens).values({ id: seed.tokenId, token: hashAuthenticationToken(seed.token), userId: seed.userId });
  await db.insert(systemApiTokens).values({
    id: seed.systemTokenId,
    tokenHash: hashSystemApiToken(seed.systemToken),
    description: "contract test system token",
    expiresAt: Date.now() + 7_200_000,
  });
}

export async function cleanupSeed(seed: OrgSeed): Promise<void> {
  await db.delete(systemApiTokens).where(eq(systemApiTokens.id, seed.systemTokenId));
  await db.delete(apiTokens).where(eq(apiTokens.id, seed.tokenId));
  await db.delete(organizationMemberships).where(eq(organizationMemberships.id, seed.membershipId));
  await db.delete(organizations).where(eq(organizations.id, seed.orgId));
  await db.delete(users).where(eq(users.id, seed.userId));
}

export const request = (path: string, init?: RequestInit): Promise<Response> =>
  app.handle(new Request(new URL(path, "http://terrence.test"), init));

export const jsonHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/vnd.api+json",
});

export type JsonApiResource = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
  links?: Record<string, unknown>;
}

export function expectResource(resource: unknown, type: string): asserts resource is JsonApiResource {
  expect(resource).toBeTypeOf("object");
  const r = resource as JsonApiResource;
  expect(r.id).toBeTypeOf("string");
  expect(r.id).not.toBe("");
  expect(r.type).toBe(type);
  expect(r.attributes).toBeTypeOf("object");
}

export function expectSelfLink(resource: JsonApiResource, prefix: string): void {
  expect(typeof resource.links?.self).toBe("string");
  expect(resource.links?.self).toMatch(new RegExp(`^${prefix}`));
}

export function expectCollection(body: unknown, type: string): JsonApiResource[] {
  expect(body).toBeTypeOf("object");
  const data = (body as { data?: unknown }).data;
  expect(Array.isArray(data)).toBe(true);
  for (const item of data as unknown[]) {
    expectResource(item, type);
  }
  return data as JsonApiResource[];
}

export function expectPaginationMeta(body: unknown): void {
  expect(body).toBeTypeOf("object");
  const meta = (body as { meta?: { pagination?: Record<string, unknown> } }).meta;
  expect(meta?.pagination).toBeTypeOf("object");
  for (const key of ["current-page", "page-size", "prev-page", "next-page", "total-pages", "total-count"]) {
    expect(meta?.pagination).toHaveProperty(key);
  }
  const links = (body as { links?: Record<string, unknown> }).links;
  expect(links?.self).toBeTypeOf("string");
  expect(links?.first).toBeTypeOf("string");
  expect(links?.last).toBeTypeOf("string");
}

export function expectErrorDocument(body: unknown, status: string): void {
  expect(body).toBeTypeOf("object");
  const errors = (body as { errors?: unknown[] }).errors;
  expect(Array.isArray(errors)).toBe(true);
  expect(errors?.length).toBeGreaterThan(0);
  const first = errors?.[0] as { status?: unknown; title?: unknown; detail?: unknown };
  expect(first.status).toBe(status);
  expect(first.title).toBeTypeOf("string");
}

export async function expectErrorResponse(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
  expectErrorDocument(await response.json(), String(status));
}

export async function expectSuccessResponse(
  response: Response,
  status: number,
  type: string,
): Promise<JsonApiResource> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
  const body = await response.json();
  expect(body).toBeTypeOf("object");
  const resource = (body as { data?: unknown }).data;
  expectResource(resource, type);
  return resource as JsonApiResource;
}

export async function expectNoContent(response: Response): Promise<void> {
  expect(response.status).toBe(204);
  // Elysia serializes `{}` as the body even for 204 responses (Response.json is
  // applied regardless of status); the reference format returns an empty body. Accept both.
  const body = await response.text();
  expect(body === "" || body === "{}").toBe(true);
}