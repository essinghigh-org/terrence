import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations, users } from "../../src/db/schema";

const suffix = crypto.randomUUID();
const userId = `preflight-user-${suffix}`;
const token = `preflight-token-${suffix}`;
const orgName = `preflight-org-${suffix}`;
let orgId = "";
let workspaceId = "";

function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  return app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

beforeAll(async () => {
  await db.insert(users).values({
    id: userId,
    username: userId,
    email: `${userId}@example.com`,
    passwordHash: "unused",
  });
  await db.insert(apiTokens).values({
    id: `${userId}-api-token`,
    token: createHash("sha256").update(token).digest("hex"),
    userId,
  });
  const organization = await request("/api/v2/organizations", "POST", {
    data: { type: "organizations", attributes: { name: orgName } },
  });
  expect(organization.status).toBe(201);
  orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";
  const workspace = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
    data: { type: "workspaces", attributes: { name: `workspace-${suffix}` } },
  });
  expect(workspace.status).toBe(201);
  workspaceId = ((await workspace.json()) as { data: { id: string } }).data.id;
});

afterAll(async () => {
  if (orgId !== "") await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("workspace preflight", () => {
  it("reports a direct blocker without exposing configuration values", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/actions/preflight`, "POST", {
      data: { type: "preflight-assessments", attributes: {} },
    });
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      data: { attributes: { status: string; checks: { id: string; status: string; fix?: string }[] } };
    };
    expect(document.data.attributes.status).toBe("blocked");
    const configuration = document.data.attributes.checks.find((check) => check.id === "configuration");
    expect(configuration?.status).toBe("failed");
    expect(configuration?.fix).toContain("Upload");
  });

  it("rejects unvalidated optional probes", async () => {
    const response = await request(`/api/v2/workspaces/${workspaceId}/preflight`, "POST", {
      data: { type: "preflight-assessments", attributes: { probes: ["https://example.com"] } },
    });
    expect(response.status).toBe(422);
  });
});
