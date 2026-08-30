import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  noCodeModules,
  noCodeVariableOptions,
  organizationMemberships,
  organizations,
  registryModules,
  registryModuleVersions,
  teams,
  users,
} from "../../src/db/schema";

describe("No-code module API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const otherUserId = `other-user-${suffix}`;
  const orgId = `org-${suffix}`;
  const otherOrgId = `other-org-${suffix}`;
  const orgName = `no-code-${suffix}`;
  const otherOrgName = `other-no-code-${suffix}`;
  const teamId = `team-${suffix}`;
  const moduleId = `mod-${suffix}`;
  const otherModuleId = `other-mod-${suffix}`;
  const versionOneId = `modver-one-${suffix}`;
  const versionTwoId = `modver-two-${suffix}`;
  const versionThreeId = `modver-three-${suffix}`;
  const otherVersionId = `other-modver-${suffix}`;
  const userToken = `user-token-${suffix}`;
  const otherUserToken = `other-user-token-${suffix}`;
  const teamToken = `team-token-${suffix}`;
  const orgToken = `org-token-${suffix}`;
  const testDir = mkdtempSync(join(tmpdir(), "terrence-no-code-"));
  const moduleDir = join(testDir, "module");
  const moduleArchivePath = join(testDir, "module.tar.gz");

  const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
  const request = (path: string, method = "GET", body?: unknown, auth = userToken): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  const enablePayload = (
    module: string,
    version?: string,
    enabled = true,
    variableOptions?: readonly Record<string, unknown>[],
  ): Record<string, unknown> => ({
    data: {
      type: "no-code-modules",
      attributes: {
        enabled,
        ...(version === undefined ? {} : { "version-pin": version }),
      },
      relationships: {
        "registry-module": {
          data: { id: module, type: "registry-module" },
        },
        ...(variableOptions === undefined ? {} : {
          "variable-options": { data: variableOptions },
        }),
      },
    },
  });

  beforeAll(async () => {
    await mkdir(moduleDir, { recursive: true });
    await writeFile(join(moduleDir, "variables.tf"), `
variable "region" {
  type        = string
  description = "AWS deployment region"
}

variable "replicas" {
  type    = number
  default = 2
}

variable "enable_monitoring" {
  type    = bool
  default = true
}
`);
    const archive = Bun.spawn(["tar", "-czf", moduleArchivePath, "-C", moduleDir, "."]);
    expect(await archive.exited).toBe(0);
    await db.insert(users).values([
      { id: userId, username: userId, passwordHash: "unused" },
      { id: otherUserId, username: otherUserId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: otherOrgId, name: otherOrgName },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: otherUserId, orgId: otherOrgId, role: "owner" },
    ]);
    await db.insert(teams).values({
      id: teamId,
      orgId,
      name: `no-code-team-${suffix}`,
      organizationAccess: { "manage-modules": true, "manage-workspaces": true },
    });
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: hash(userToken), userId },
      { id: crypto.randomUUID(), token: hash(otherUserToken), userId: otherUserId },
      { id: crypto.randomUUID(), token: hash(teamToken), teamId },
      { id: crypto.randomUUID(), token: hash(orgToken), orgId },
    ]);
    await db.insert(registryModules).values([
      { id: moduleId, orgId, namespace: orgName, name: "network", provider: "aws" },
      { id: otherModuleId, orgId: otherOrgId, namespace: otherOrgName, name: "network", provider: "aws" },
    ]);
    await db.insert(registryModuleVersions).values([
      { id: versionOneId, moduleId, version: "1.0.0", status: "ok", createdAt: Date.now() - 100 },
      { id: versionTwoId, moduleId, version: "2.0.0", status: "ok", archivePath: moduleArchivePath, metadata: { description: "Preserved metadata" }, createdAt: Date.now() },
      // Higher SemVer but older creation time: unpinned selection must use
      // release precedence, not insertion order.
      { id: versionThreeId, moduleId, version: "3.0.0", status: "ok", archivePath: moduleArchivePath, createdAt: Date.now() - 1_000 },
      { id: otherVersionId, moduleId: otherModuleId, version: "9.9.9", status: "ok", createdAt: Date.now() },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
    await rm(testDir, { recursive: true, force: true });
  });

  it("validates the JSON:API module and version relationships", async () => {
    const wrongType = await request(`/api/v2/organizations/${orgName}/no-code-modules`, "POST", {
      data: { type: "registry-modules" },
    });
    expect(wrongType.status).toBe(422);

    const crossOrganization = await request(
      `/api/v2/organizations/${orgName}/no-code-modules`,
      "POST",
      enablePayload(otherModuleId, "9.9.9"),
    );
    expect(crossOrganization.status).toBe(404);

    const versionFromAnotherModule = await request(
      `/api/v2/organizations/${orgName}/no-code-modules`,
      "POST",
      enablePayload(moduleId, "9.9.9"),
    );
    expect(versionFromAnotherModule.status).toBe(422);

    const organizationPrincipal = await request(
      `/api/v2/organizations/${orgName}/no-code-modules`,
      "POST",
      enablePayload(moduleId, "1.0.0"),
      orgToken,
    );
    expect(organizationPrincipal.status).toBe(404);
  });

  it("enables, lists, and updates one no-code resource per registry module", async () => {
    const created = await request(
      `/api/v2/organizations/${orgName}/no-code-modules`,
      "POST",
      enablePayload(moduleId, "1.0.0", true, [{
        type: "variable-options",
        attributes: {
          "variable-name": "environment",
          "variable-type": "string",
          options: ["development", "production"],
        },
      }]),
      teamToken,
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.data).toMatchObject({
      type: "no-code-modules",
      attributes: { enabled: true, "version-pin": "1.0.0" },
      relationships: {
        organization: { data: { id: orgName, type: "organizations" } },
        "registry-module": { data: { id: moduleId, type: "registry-modules" } },
        "variable-options": { data: [expect.objectContaining({ type: "variable-options" })] },
      },
    });
    const noCodeId = createdBody.data.id as string;

    const listed = await request(
      `/api/v2/organizations/${orgName}/no-code-modules`,
      "GET",
      undefined,
      orgToken,
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.map((resource: { id: string }): string => resource.id)).toEqual([noCodeId]);

    const updated = await request(
      `/api/v2/organizations/${orgName}/no-code-modules`,
      "POST",
      enablePayload(moduleId, undefined, false),
    );
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.data.id).toBe(noCodeId);
    expect(updatedBody.data.attributes).toEqual({ enabled: false, "version-pin": "3.0.0" });
    const stored = await db.query.noCodeModules.findFirst({ where: eq(noCodeModules.id, noCodeId) });
    expect(stored?.versionId).toBe(versionThreeId);

    expect((await request(`/api/v2/organizations/${otherOrgName}/no-code-modules`)).status).toBe(404);
  });

  it("persists variable options and exposes the documented GET and PATCH contract", async () => {
    const listed = await request(`/api/v2/organizations/${orgName}/no-code-modules`);
    const noCodeId = (await listed.json()).data[0].id as string;
    const patched = await request(`/api/v2/no-code-modules/${noCodeId}`, "PATCH", {
      data: {
        type: "no-code-modules",
        attributes: { enabled: true },
        relationships: {
          "variable-options": {
            data: [
              {
                type: "variable-options",
                attributes: {
                  "variable-name": "region",
                  "variable-type": "string",
                  options: ["eu-west-1", "us-east-1"],
                },
              },
              {
                type: "variable-options",
                attributes: {
                  "variable-name": "replicas",
                  "variable-type": "number",
                  options: [1, 2, 3],
                },
              },
            ],
          },
        },
      },
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.data.attributes.enabled).toBe(true);
    expect(patchedBody.data.relationships["variable-options"].data).toHaveLength(3);

    const stored = await db.query.noCodeVariableOptions.findMany({
      where: eq(noCodeVariableOptions.noCodeModuleId, noCodeId),
    });
    expect(stored).toHaveLength(3);
    const regionOption = stored.find((option): boolean => option.variableName === "region");
    expect(regionOption).toBeDefined();

    const read = await request(`/api/v2/no-code-modules/${noCodeId}?include=variable_options`);
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.included).toHaveLength(3);
    expect(readBody.included).toContainEqual(expect.objectContaining({
      id: regionOption?.id,
      type: "variable-options",
      attributes: {
        "variable-name": "region",
        "variable-type": "string",
        options: ["eu-west-1", "us-east-1"],
      },
    }));

    const replace = await request(`/api/v2/no-code-modules/${noCodeId}`, "PATCH", {
      data: {
        type: "no-code-modules",
        relationships: {
          "variable-options": {
            data: [{
              id: regionOption?.id,
              type: "variable-options",
              attributes: {
                "variable-name": "region",
                "variable-type": "string",
                options: ["eu-west-1"],
              },
            }],
          },
        },
      },
    });
    expect(replace.status).toBe(200);
    expect((await db.query.noCodeVariableOptions.findFirst({
      where: eq(noCodeVariableOptions.id, regionOption?.id ?? ""),
    }))?.options).toEqual(["eu-west-1"]);

    const invalidType = await request(`/api/v2/no-code-modules/${noCodeId}`, "PATCH", {
      data: {
        type: "no-code-modules",
        relationships: {
          "variable-options": {
            data: [{
              type: "variable-options",
              attributes: {
                "variable-name": "bad_count",
                "variable-type": "number",
                options: ["many"],
              },
            }],
          },
        },
      },
    });
    expect(invalidType.status).toBe(422);
    expect((await request(`/api/v2/no-code-modules/${noCodeId}?include=unknown`)).status).toBe(400);
    expect((await request(`/api/v2/no-code-modules/${noCodeId}`, "PATCH", {
      data: { type: "no-code-modules", attributes: { enabled: false } },
    }, orgToken)).status).toBe(404);
  });

  it("only lets user and team principals delete resources in their organization", async () => {
    const listed = await request(`/api/v2/organizations/${orgName}/no-code-modules`);
    const noCodeId = (await listed.json()).data[0].id as string;

    expect((await request(`/api/v2/no-code-modules/${noCodeId}`, "DELETE", undefined, orgToken)).status).toBe(404);
    expect((await request(`/api/v2/no-code-modules/${noCodeId}`, "DELETE", undefined, otherUserToken)).status).toBe(404);
    expect((await request(`/api/v2/no-code-modules/${noCodeId}`, "DELETE", undefined, teamToken)).status).toBe(204);

    const afterDelete = await request(`/api/v2/organizations/${orgName}/no-code-modules`);
    expect((await afterDelete.json()).data).toEqual([]);
  });
});
