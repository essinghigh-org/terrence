import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  configurationVersions,
  noCodeModules,
  noCodeVariableOptions,
  noCodeWorkspaceConfigurations,
  organizationMemberships,
  organizations,
  registryModules,
  registryModuleVersions,
  runs,
  teams,
  users,
  workspaceVariables,
  workspaces,
} from "../../src/db/schema";
import { deleteCostEstimateArtifact } from "../../src/lib/cost-estimate";
import { deletePlanJsonArtifact } from "../../src/lib/plan-json";
import { executeRun } from "../../src/worker";

describe("No-code module API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const otherUserId = `other-user-${suffix}`;
  const orgId = `org-${suffix}`;
  const otherOrgId = `other-org-${suffix}`;
  const orgName = `no-code-${suffix}`;
  const otherOrgName = `other-no-code-${suffix}`;
  const teamId = `team-${suffix}`;
  const moduleTeamId = `module-team-${suffix}`;
  const workspaceTeamId = `workspace-team-${suffix}`;
  const moduleId = `mod-${suffix}`;
  const otherModuleId = `other-mod-${suffix}`;
  const versionOneId = `modver-one-${suffix}`;
  const versionTwoId = `modver-two-${suffix}`;
  const versionThreeId = `modver-three-${suffix}`;
  const otherVersionId = `other-modver-${suffix}`;
  const userToken = `user-token-${suffix}`;
  const otherUserToken = `other-user-token-${suffix}`;
  const teamToken = `team-token-${suffix}`;
  const moduleTeamToken = `module-team-token-${suffix}`;
  const workspaceTeamToken = `workspace-team-token-${suffix}`;
  const orgToken = `org-token-${suffix}`;
  const testDir = mkdtempSync(join(tmpdir(), "terrence-no-code-"));
  const moduleDir = join(testDir, "module");
  const moduleArchivePath = join(testDir, "module.tar.gz");
  const targetModuleArchivePath = join(testDir, "module-v3.tar.gz");
  const configurationArchivePaths = new Set<string>();
  const generatedRunIds = new Set<string>();

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
    await db.insert(teams).values([
      {
        id: teamId,
        orgId,
        name: `no-code-team-${suffix}`,
        organizationAccess: { "manage-modules": true, "manage-workspaces": true },
      },
      {
        id: moduleTeamId,
        orgId,
        name: `no-code-module-team-${suffix}`,
        organizationAccess: { "manage-modules": true },
      },
      {
        id: workspaceTeamId,
        orgId,
        name: `no-code-workspace-team-${suffix}`,
        organizationAccess: { "manage-workspaces": true },
      },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: hash(userToken), userId },
      { id: crypto.randomUUID(), token: hash(otherUserToken), userId: otherUserId },
      { id: crypto.randomUUID(), token: hash(teamToken), teamId },
      { id: crypto.randomUUID(), token: hash(moduleTeamToken), teamId: moduleTeamId },
      { id: crypto.randomUUID(), token: hash(workspaceTeamToken), teamId: workspaceTeamId },
      { id: crypto.randomUUID(), token: hash(orgToken), orgId },
    ]);
    await db.insert(registryModules).values([
      { id: moduleId, orgId, namespace: orgName, name: "network", provider: "aws" },
      { id: otherModuleId, orgId: otherOrgId, namespace: otherOrgName, name: "network", provider: "aws" },
    ]);
    await db.insert(registryModuleVersions).values([
      { id: versionOneId, moduleId, version: "1.0.0", status: "ok", createdAt: Date.now() - 100 },
      { id: versionTwoId, moduleId, version: "2.0.0", status: "ok", archivePath: moduleArchivePath, metadata: { description: "Preserved metadata" }, createdAt: Date.now() },
      { id: otherVersionId, moduleId: otherModuleId, version: "9.9.9", status: "ok", createdAt: Date.now() },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
    await Promise.all([
      ...[...configurationArchivePaths].map((path): Promise<void> => rm(path, { force: true })),
      ...[...generatedRunIds].flatMap((runId): Promise<unknown>[] => [
        deleteCostEstimateArtifact(runId),
        deletePlanJsonArtifact(runId),
        rm(join(tmpdir(), "terrence", "runs", runId), { recursive: true, force: true }),
      ]),
    ]);
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
    expect(updatedBody.data.attributes).toEqual({ enabled: false, "version-pin": "2.0.0" });
    const stored = await db.query.noCodeModules.findFirst({ where: eq(noCodeModules.id, noCodeId) });
    expect(stored?.versionId).toBe(versionTwoId);

    expect((await request(`/api/v2/organizations/${otherOrgName}/no-code-modules`)).status).toBe(404);
  });

  it("scans selected module declarations into no-code input metadata", async () => {
    const listed = await request(`/api/v2/organizations/${orgName}/no-code-modules`);
    const noCodeId = (await listed.json()).data[0].id as string;
    const response = await request(`/api/v2/no-code-modules/${noCodeId}/input-variables`);
    expect(response.status).toBe(200);
    const inputs = (await response.json()).data as readonly {
      attributes: Readonly<Record<string, unknown>>;
    }[];
    const byName = new Map(inputs.map((input): [string, Readonly<Record<string, unknown>>] => [
      input.attributes.name as string,
      input.attributes,
    ]));
    expect(byName.get("region")).toMatchObject({
      type: "string",
      description: "AWS deployment region",
      required: true,
      "has-default": false,
    });
    expect(byName.get("replicas")).toMatchObject({
      type: "number",
      required: false,
      "has-default": true,
      default: 2,
    });
    expect(byName.get("enable_monitoring")).toMatchObject({
      type: "bool",
      required: false,
      default: true,
    });
    expect((await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, versionTwoId) }))?.metadata?.description).toBe("Preserved metadata");
    const cachedInputs = (await (await request(`/api/v2/no-code-modules/${noCodeId}/input-variables`)).json()).data as readonly {
      attributes: Readonly<Record<string, unknown>>;
    }[];
    expect(cachedInputs.find((input): boolean => input.attributes.name === "region")?.attributes).toMatchObject({
      required: true,
      "has-default": false,
    });
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

  it("creates a module-backed workspace with typed inputs and a runnable configuration version", async () => {
    const listed = await request(`/api/v2/organizations/${orgName}/no-code-modules`);
    const noCodeId = (await listed.json()).data[0].id as string;
    const created = await request(`/api/v2/no-code-modules/${noCodeId}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: {
          name: `no-code-workspace-${suffix}`,
          description: "Created from a private module",
          auto_apply: true,
          "terraform-version": "1.9.8",
        },
        relationships: {
          vars: {
            data: [
              {
                type: "vars",
                attributes: {
                  key: "region",
                  value: "eu-west-1",
                  category: "terraform",
                  hcl: false,
                  sensitive: false,
                },
              },
              {
                type: "vars",
                attributes: {
                  key: "replicas",
                  value: "2",
                  category: "terraform",
                  hcl: true,
                  sensitive: false,
                },
              },
            ],
          },
        },
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    const workspaceId = createdBody.data.id as string;
    const configurationVersionId = createdBody.data.relationships["current-configuration-version"].data.id as string;
    const runId = createdBody.data.relationships["current-run"].data.id as string;
    generatedRunIds.add(runId);
    expect(createdBody.data).toMatchObject({
      type: "workspaces",
      attributes: {
        name: `no-code-workspace-${suffix}`,
        "auto-apply": true,
        source: "tfe-module",
        "source-module-id": `private/${orgName}/network/aws/2.0.0`,
      },
      relationships: {
        "no-code-module-version": {
          data: { id: versionTwoId, type: "no-code-module-versions" },
        },
      },
    });

    const [configuration, selectedConfiguration, variables, workspace, queuedRun] = await Promise.all([
      db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, configurationVersionId) }),
      db.query.noCodeWorkspaceConfigurations.findFirst({
        where: eq(noCodeWorkspaceConfigurations.workspaceId, workspaceId),
      }),
      db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, workspaceId) }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      db.query.runs.findFirst({ where: eq(runs.id, runId) }),
    ]);
    expect(configuration).toMatchObject({ status: "uploaded", source: "tfe-no-code" });
    expect(selectedConfiguration).toMatchObject({
      noCodeModuleId: noCodeId,
      moduleId,
      moduleVersionId: versionTwoId,
      configurationVersionId,
      moduleVersion: "2.0.0",
      inputs: { region: "eu-west-1", replicas: 2 },
    });
    expect(workspace?.projectId).not.toBeNull();
    expect(queuedRun).toMatchObject({
      workspaceId,
      configurationVersionId,
      status: "pending",
      message: "Queued by no-code provisioning",
      autoApply: true,
    });
    expect(Object.fromEntries(variables.map((variable): [string, unknown] => [
      variable.key,
      { value: variable.value, hcl: variable.hcl },
    ]))).toEqual({
      region: { value: "\"eu-west-1\"", hcl: true },
      replicas: { value: "2", hcl: true },
    });
    const configurationArchivePath = configuration?.archivePath ?? null;
    if (configurationArchivePath !== null) configurationArchivePaths.add(configurationArchivePath);
    expect(configurationArchivePath).not.toBeNull();
    const main = Bun.spawn(["tar", "-xOf", configurationArchivePath ?? "", "./main.tf"], { stdout: "pipe" });
    const mainText = await new Response(main.stdout).text();
    expect(await main.exited).toBe(0);
    expect(mainText).toContain('source = "./module"');
    expect(mainText).toContain("region = var.region");
    expect(mainText).toContain("replicas = var.replicas");

    await executeRun(runId);
    expect((await db.query.runs.findFirst({ where: eq(runs.id, runId) }))?.status).toBe("applied");

    const invalidInput = await request(`/api/v2/no-code-modules/${noCodeId}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: `invalid-no-code-${suffix}` },
        relationships: {
          vars: {
            data: [{
              type: "vars",
                attributes: { key: "enable_monitoring", value: "yes", category: "terraform" },
            }],
          },
        },
      },
    });
    expect(invalidInput.status).toBe(422);
    expect((await request(`/api/v2/no-code-modules/${noCodeId}/workspaces`, "POST", {
      data: { type: "workspaces", attributes: { name: `org-token-no-code-${suffix}` } },
    }, orgToken)).status).toBe(404);
  });

  it("plans, reports, confirms, and atomically applies a no-code workspace upgrade", async () => {
    const listed = await request(`/api/v2/organizations/${orgName}/no-code-modules`);
    const noCodeId = (await listed.json()).data[0].id as string;
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.name, `no-code-workspace-${suffix}`),
    });
    const before = workspace === undefined
      ? undefined
      : await db.query.noCodeWorkspaceConfigurations.findFirst({
          where: eq(noCodeWorkspaceConfigurations.workspaceId, workspace.id),
        });
    expect(workspace).toBeDefined();
    expect(before).toMatchObject({
      moduleVersionId: versionTwoId,
      moduleVersion: "2.0.0",
      inputs: { region: "eu-west-1", replicas: 2 },
    });

    await writeFile(join(moduleDir, "target-version.txt"), "3.0.0");
    const targetArchive = Bun.spawn(["tar", "-czf", targetModuleArchivePath, "-C", moduleDir, "."]);
    expect(await targetArchive.exited).toBe(0);
    await db.insert(registryModuleVersions).values({
      id: versionThreeId,
      moduleId,
      version: "3.0.0",
      status: "ok",
      archivePath: targetModuleArchivePath,
      createdAt: Date.now() + 1,
    });
    expect((await request(`/api/v2/no-code-modules/${noCodeId}`, "PATCH", {
      data: {
        type: "no-code-modules",
        attributes: { enabled: true, "version-pin": "3.0.0" },
      },
    }, workspaceTeamToken)).status).toBe(404);
    const selected = await request(`/api/v2/no-code-modules/${noCodeId}`, "PATCH", {
      data: {
        type: "no-code-modules",
        attributes: { enabled: true, "version-pin": "3.0.0" },
      },
    }, moduleTeamToken);
    expect(selected.status).toBe(200);

    const upgradePayload = (replicas: number): Record<string, unknown> => ({
      data: {
        type: "workspaces",
        relationships: {
          vars: {
            data: [
              {
                type: "vars",
                attributes: {
                  key: "region",
                  value: "eu-west-1",
                  category: "terraform",
                },
              },
              {
                type: "vars",
                attributes: {
                  key: "replicas",
                  value: String(replicas),
                  category: "terraform",
                  hcl: true,
                },
              },
              {
                type: "vars",
                attributes: {
                  key: "enable_monitoring",
                  value: "false",
                  category: "terraform",
                  hcl: true,
                },
              },
            ],
          },
        },
      },
    });
    const upgradePath = `/api/v2/no-code-modules/${noCodeId}/workspaces/${workspace?.id ?? ""}/upgrade`;
    expect((await request(upgradePath, "POST", upgradePayload(3), otherUserToken)).status).toBe(404);
    expect((await request(upgradePath, "POST", upgradePayload(3), moduleTeamToken)).status).toBe(404);
    expect((await request(
      `/api/v2/no-code-modules/${noCodeId}/workspaces/not-this-workspace/upgrade`,
      "POST",
      upgradePayload(3),
    )).status).toBe(404);

    const first = await request(upgradePath, "POST", upgradePayload(3), workspaceTeamToken);
    const stale = await request(upgradePath, "POST", upgradePayload(1));
    expect(first.status).toBe(200);
    expect(stale.status).toBe(200);
    const firstBody = await first.json();
    const staleBody = await stale.json();
    const firstRunId = firstBody.data.id as string;
    const staleRunId = staleBody.data.id as string;
    generatedRunIds.add(firstRunId);
    generatedRunIds.add(staleRunId);
    expect(firstBody.data).toMatchObject({
      type: "workspace-upgrade",
      attributes: {
        status: "pending",
        "plan-url": expect.stringContaining(`/runs/${firstRunId}`),
      },
      relationships: {
        workspace: { data: { id: workspace?.id, type: "workspaces" } },
      },
    });

    const [firstRun, staleRun] = await Promise.all([
      db.query.runs.findFirst({ where: eq(runs.id, firstRunId) }),
      db.query.runs.findFirst({ where: eq(runs.id, staleRunId) }),
    ]);
    expect(firstRun).toMatchObject({
      workspaceId: workspace?.id,
      savePlan: true,
      autoApply: false,
      message: "Queued by no-code workspace upgrade",
    });
    expect(staleRun?.savePlan).toBe(true);
    expect(firstRun?.configurationVersionId).not.toBeNull();
    expect(staleRun?.configurationVersionId).not.toBeNull();
    const [firstConfiguration, staleConfiguration] = await Promise.all([
      db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, firstRun?.configurationVersionId ?? ""),
      }),
      db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, staleRun?.configurationVersionId ?? ""),
      }),
    ]);
    for (const configuration of [firstConfiguration, staleConfiguration]) {
      expect(configuration?.source).toBe(
        `tfe-no-code-upgrade|${noCodeId}|${moduleId}|${versionThreeId}|${before?.configurationVersionId ?? ""}`,
      );
      if (configuration?.archivePath !== null && configuration?.archivePath !== undefined) {
        configurationArchivePaths.add(configuration.archivePath);
      }
    }

    await executeRun(firstRunId);
    await executeRun(staleRunId);
    const firstWorkDirectory = join(tmpdir(), "terrence", "runs", firstRunId);
    const [targetMarker, proposedTfvars] = await Promise.all([
      readFile(join(firstWorkDirectory, "module", "target-version.txt"), "utf8"),
      readFile(join(firstWorkDirectory, "terrence.workspace.tfvars"), "utf8"),
    ]);
    expect(targetMarker).toBe("3.0.0");
    expect(proposedTfvars).toContain("region = \"eu-west-1\"");
    expect(proposedTfvars).toContain("replicas = 3");
    expect(proposedTfvars).toContain("enable_monitoring = false");
    expect(proposedTfvars).not.toContain("replicas = 2");
    const statusPath = `${upgradePath}/${firstRunId}`;
    const planned = await request(statusPath, "GET", undefined, teamToken);
    expect(planned.status).toBe(200);
    expect((await planned.json()).data.attributes.status).toBe("planned_and_saved");
    expect((await request(`${upgradePath}/not-this-run`, "GET", undefined, teamToken)).status).toBe(404);
    expect((await request(
      `/api/v2/no-code-modules/${noCodeId}/workspaces/not-this-workspace/upgrade/${firstRunId}`,
      "GET",
      undefined,
      teamToken,
    )).status).toBe(404);

    const stillCurrent = await db.query.noCodeWorkspaceConfigurations.findFirst({
      where: eq(noCodeWorkspaceConfigurations.workspaceId, workspace?.id ?? ""),
    });
    const stillVariables = await db.query.workspaceVariables.findMany({
      where: eq(workspaceVariables.workspaceId, workspace?.id ?? ""),
    });
    expect(stillCurrent?.configurationVersionId).toBe(before?.configurationVersionId);
    expect(stillCurrent?.moduleVersionId).toBe(versionTwoId);
    expect(Object.fromEntries(stillVariables.map((variable): [string, string] => [variable.key, variable.value]))).toEqual({
      region: "\"eu-west-1\"",
      replicas: "2",
    });

    const confirmed = await request(statusPath, "POST", undefined, teamToken);
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).data.type).toBe("workspace-upgrade");
    let appliedStatus = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const polled = await request(statusPath, "GET", undefined, teamToken);
      appliedStatus = (await polled.json()).data.attributes.status as string;
      if (appliedStatus === "applied" || appliedStatus === "errored") break;
      await Bun.sleep(10);
    }
    expect(appliedStatus).toBe("applied");

    const [advanced, advancedVariables] = await Promise.all([
      db.query.noCodeWorkspaceConfigurations.findFirst({
        where: eq(noCodeWorkspaceConfigurations.workspaceId, workspace?.id ?? ""),
      }),
      db.query.workspaceVariables.findMany({
        where: eq(workspaceVariables.workspaceId, workspace?.id ?? ""),
      }),
    ]);
    expect(advanced).toMatchObject({
      noCodeModuleId: noCodeId,
      moduleId,
      moduleVersionId: versionThreeId,
      configurationVersionId: firstRun?.configurationVersionId,
      moduleVersion: "3.0.0",
      inputs: { region: "eu-west-1", replicas: 3, enable_monitoring: false },
    });
    expect(Object.fromEntries(advancedVariables.map((variable): [string, unknown] => [
      variable.key,
      { value: variable.value, hcl: variable.hcl },
    ]))).toEqual({
      region: { value: "\"eu-west-1\"", hcl: true },
      replicas: { value: "3", hcl: true },
      enable_monitoring: { value: "false", hcl: true },
    });

    expect((await request(statusPath, "POST", undefined, teamToken)).status).toBe(409);
    expect((await request(`${upgradePath}/${staleRunId}`, "POST", undefined, teamToken)).status).toBe(409);
    expect((await db.query.runs.findFirst({ where: eq(runs.id, staleRunId) }))?.status).toBe("planned_and_saved");
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
