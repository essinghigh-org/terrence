import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

const suffix = crypto.randomUUID();
const adminId = `signup-settings-admin-${suffix}`;
const memberId = `signup-settings-member-${suffix}`;
const adminToken = `signup-settings-token-${suffix}`;
const memberToken = `signup-settings-member-token-${suffix}`;
const previous = process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"];
const request = (path: string, method = "GET", attrs?: unknown, token = adminToken) => app.handle(new Request(`http://terrence.test/api/v2${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.api+json" },
  ...(attrs === undefined ? {} : { body: JSON.stringify({ data: { type: "general-settings", attributes: attrs } }) }),
}));
const signupShown = async () => (await (await request("/ping")).json())["signup-enabled"];

beforeAll(async () => {
  process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"] = "false";
  await db.insert(users).values([
    { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
    { id: memberId, username: memberId, passwordHash: "unused" },
  ]);
  await db.insert(apiTokens).values([
    { id: `signup-settings-at-${suffix}`, userId: adminId, token: hashAuthenticationToken(adminToken) },
    { id: `signup-settings-mt-${suffix}`, userId: memberId, token: hashAuthenticationToken(memberToken) },
  ]);
});
afterAll(async () => {
  if (previous === undefined) delete process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"];
  else process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"] = previous;
  await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, memberId]));
  await db.delete(users).where(inArray(users.id, [adminId, memberId]));
});

test("registration settings are admin-only and reject invalid preference values", async () => {
  expect((await request("/admin/general-settings", "PATCH", { "local-signup-enabled": true }, memberToken)).status).toBe(404);
  expect((await request("/admin/general-settings", "PATCH", { "local-signup-enabled": "yes" })).status).toBe(422);
});

test("saved registration preference overrides the deployment default and updates public discovery and registration together", async () => {
  expect(await signupShown()).toBe(false);
  expect((await request("/users", "POST", {})).status).toBe(403);
  expect((await request("/admin/general-settings", "PATCH", { "local-signup-enabled": true })).status).toBe(200);
  expect(await signupShown()).toBe(true);
  // An incomplete signup is now validated, rather than rejected by the registration gate.
  expect((await request("/users", "POST", {})).status).toBe(400);
  expect((await request("/admin/general-settings", "PATCH", { "local-signup-enabled": false })).status).toBe(200);
  process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"] = "true";
  expect(await signupShown()).toBe(false);
  expect((await request("/users", "POST", {})).status).toBe(403);
  expect((await request("/admin/general-settings", "PATCH", { "local-signup-enabled": null })).status).toBe(200);
  expect(await signupShown()).toBe(true);
});
