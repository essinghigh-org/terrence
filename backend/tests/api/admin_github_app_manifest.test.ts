import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";

const suffix = crypto.randomUUID();
const userId = `manifest-admin-${suffix}`;
const token = `manifest-token-${suffix}`;

const request = (accept?: string): Promise<Response> =>
  app.handle(new Request("http://terrence.test/api/v2/admin/github-app/manifest/setup", {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(accept === undefined ? {} : { Accept: accept }),
    },
  }));

beforeAll(async () => {
  await db.insert(users).values([
    { id: userId, username: userId, passwordHash: "unused", isSiteAdmin: true },
  ]);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.insert(apiTokens).values([
    { id: crypto.randomUUID(), token: tokenHash, userId },
  ]);
});

afterAll(async () => {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.delete(apiTokens).where(eq(apiTokens.token, tokenHash));
  await db.delete(users).where(eq(users.id, userId));
});

test("manifest setup returns the authorization URL for JSON:API Accept", async () => {
  const response = await request("application/vnd.api+json");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
  const body = await response.json() as {
    data: { attributes: { "authorization-url": string } };
  };
  expect(body.data.attributes["authorization-url"]).toMatch(/^https:\/\//);
});

test("manifest setup rejects plain application/json Accept with 406", async () => {
  const response = await request("application/json");
  expect(response.status).toBe(406);
});
