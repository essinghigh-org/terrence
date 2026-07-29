import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

test("workspace core routes persist settings and execute from the configured subdirectory", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-workspace-core-"));

  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", `
      const { chmod, mkdir, readFile, rm, writeFile } = await import("fs/promises");
      const { join } = await import("path");
      const { tmpdir } = await import("os");
      const { app } = await import("./src/app.ts");
      const { db } = await import("./src/db/index.ts");
      const { configurationVersions, runs, stateVersions } = await import("./src/db/schema.ts");
      const { executeRun } = await import("./src/worker.ts");

      let token = "";
      const api = (method, path, body) => app.handle(new Request("http://localhost" + path, {
        method,
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));

      await api("POST", "/api/v2/users", {
        data: { type: "users", attributes: { username: "workspace-owner", password: "workspace-password" } },
      });
      const login = await api("POST", "/api/v2/users/login", {
        data: { attributes: { username: "workspace-owner", password: "workspace-password" } },
      });
      token = (await login.json()).data.attributes.token;
      await api("POST", "/api/v2/organizations", {
        data: { type: "organizations", attributes: { name: "workspace-org" } },
      });

      const createBody = {
        data: {
          type: "workspaces",
          attributes: {
            name: "primary",
            description: "Primary workspace",
            "working-directory": "infra",
            "iac-binary": "tofu",
            "terraform-version": "1.2.3",
            "source-name": "terraform-cli",
            "source-url": "https://developer.hashicorp.com/terraform/cli",
          },
          relationships: {
            "tag-bindings": {
              data: [
                { type: "tag-bindings", attributes: { key: "app", value: "web" } },
                { type: "tag-bindings", attributes: { key: "environment", value: "production" } },
              ],
            },
          },
        },
      };
      const create = await api("POST", "/api/v2/organizations/workspace-org/workspaces", createBody);
      const created = await create.json();
      const workspaceId = created.data.id;
      const nativeTerraformCreate = await app.handle(new Request(
        "http://localhost/api/v2/organizations/workspace-org/workspaces",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/vnd.api+json",
            "Terraform-Version": "1.10.0",
          },
          body: JSON.stringify({
            data: { type: "workspaces", attributes: { name: "native-terraform" } },
          }),
        },
      ));
      const nativeTerraform = await nativeTerraformCreate.json();
      await api("DELETE", "/api/v2/organizations/workspace-org/workspaces/native-terraform");
      const filteredByTags = await api(
        "GET",
        "/api/v2/organizations/workspace-org/workspaces?search[tags]=app,environment",
      );
      const excludedByTag = await api(
        "GET",
        "/api/v2/organizations/workspace-org/workspaces?search[exclude-tags]=app",
      );
      const filteredByTagBindings = await api(
        "GET",
        "/api/v2/organizations/workspace-org/workspaces?filter[tagged][0][key]=app&filter[tagged][0][value]=web&filter[tagged][1][key]=environment&filter[tagged][1][value]=production",
      );
      const excludedByTagBindingValue = await api(
        "GET",
        "/api/v2/organizations/workspace-org/workspaces?filter[tagged][0][key]=app&filter[tagged][0][value]=api",
      );
      const updateTagBindings = await api("PATCH", "/api/v2/workspaces/" + workspaceId + "/tag-bindings", {
        data: [{ type: "tag-bindings", attributes: { key: "environment", value: "staging" } }],
      });
      const tagBindings = await api("GET", "/api/v2/workspaces/" + workspaceId + "/tag-bindings");
      const effectiveTagBindings = await api(
        "GET",
        "/api/v2/workspaces/" + workspaceId + "/effective-tag-bindings",
      );
      const clearTagBindings = await api("PATCH", "/api/v2/workspaces/" + workspaceId, {
        data: {
          type: "workspaces",
          relationships: { "tag-bindings": { data: [] } },
        },
      });
      const duplicateCreate = await api("POST", "/api/v2/organizations/workspace-org/workspaces", createBody);
      const invalidDirectory = await api("POST", "/api/v2/organizations/workspace-org/workspaces", {
        data: { type: "workspaces", attributes: { name: "escape", "working-directory": "../outside" } },
      });

      await api("POST", "/api/v2/organizations/workspace-org/workspaces", {
        data: { type: "workspaces", attributes: { name: "taken" } },
      });
      const patch = await api("PATCH", "/api/v2/organizations/workspace-org/workspaces/primary", {
        data: { type: "workspaces", attributes: { name: "renamed", description: "Updated workspace" } },
      });
      const patched = await patch.json();
      const duplicatePatch = await api("PATCH", "/api/v2/organizations/workspace-org/workspaces/renamed", {
        data: { type: "workspaces", attributes: { name: "taken" } },
      });
      const forceDeleteByName = await api("DELETE", "/api/v2/organizations/workspace-org/workspaces/taken");

      const addTag = await api("POST", "/api/v2/workspaces/" + workspaceId + "/relationships/tags", {
        data: [{ type: "tags", attributes: { key: "environment:production" } }],
      });
      const tagId = (await addTag.json()).data[0].id;
      const deleteTag = await api("DELETE", "/api/v2/workspaces/" + workspaceId + "/relationships/tags", {
        data: [{ type: "tags", id: tagId }],
      });
      const tags = await api("GET", "/api/v2/workspaces/" + workspaceId + "/relationships/tags");

      const lock = await api("POST", "/api/v2/workspaces/" + workspaceId + "/actions/lock");
      const locked = await lock.json();
      const forceUnlock = await api("POST", "/api/v2/workspaces/" + workspaceId + "/actions/force-unlock");
      const unlocked = await forceUnlock.json();

      const recordDir = join(process.env.TEST_DIR, "record");
      const binaryDir = join(process.env.STORAGE_DIR, "binaries", "tofu", "1.2.3");
      const binaryPath = join(binaryDir, "tofu");
      await mkdir(recordDir, { recursive: true });
      await mkdir(binaryDir, { recursive: true });
      await writeFile(binaryPath, [
        "#!/bin/sh",
        "record_dir=" + JSON.stringify(recordDir),
        "case \\"$1\\" in",
        '  init) pwd > "$record_dir/init-cwd" ;;',
        '  plan) test -f terraform.tfstate || exit 3; pwd > "$record_dir/plan-cwd"; : > tfplan ;;',
        "  apply) ;;",
        "  *) exit 2 ;;",
        "esac",
      ].join("\\n"));
      await chmod(binaryPath, 0o755);

      const configDir = join(process.env.TEST_DIR, "configuration");
      const archivePath = join(process.env.TEST_DIR, "configuration.tar.gz");
      await mkdir(join(configDir, "infra"), { recursive: true });
      await writeFile(join(configDir, "infra", "main.tf"), "terraform {}");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
      if (await tar.exited !== 0) throw new Error("tar failed");

      const configurationId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      await db.insert(configurationVersions).values({
        id: configurationId,
        workspaceId,
        status: "uploaded",
        archivePath,
      });
      await db.insert(stateVersions).values({
        id: crypto.randomUUID(),
        workspaceId,
        serial: 1,
        statePayload: JSON.stringify({ version: 4, serial: 1, resources: [{ mode: "managed", type: "test_resource" }] }),
      });
      await db.insert(runs).values({
        id: runId,
        workspaceId,
        configurationVersionId: configurationId,
        status: "planning",
        createdAt: Date.now(),
      });
      await executeRun(runId);
      const run = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, runId) });
      const publicPlanLogUrl = (await (await api("GET", "/api/v2/plans/plan-" + runId)).json())
        .data.attributes["log-read-url"];
      const initCwd = (await readFile(join(recordDir, "init-cwd"), "utf8")).trim();
      const planCwd = (await readFile(join(recordDir, "plan-cwd"), "utf8")).trim();
      await rm(join(tmpdir(), "terrence", "runs", runId), { recursive: true, force: true });

      const blockedSafeDelete = await api("POST", "/api/v2/workspaces/" + workspaceId + "/actions/safe-delete");
      await db.insert(stateVersions).values({
        id: crypto.randomUUID(),
        workspaceId,
        serial: 2,
        statePayload: JSON.stringify({ version: 4, serial: 2, resources: [] }),
      });
      const safeDeleteById = await api("POST", "/api/v2/workspaces/" + workspaceId + "/actions/safe-delete");

      await api("POST", "/api/v2/organizations/workspace-org/workspaces", {
        data: { type: "workspaces", attributes: { name: "safe-by-name" } },
      });
      const safeDeleteByName = await api("POST", "/api/v2/organizations/workspace-org/workspaces/safe-by-name/actions/safe-delete");

      console.log(JSON.stringify({
        createStatus: create.status,
        description: created.data.attributes.description,
        workingDirectory: created.data.attributes["working-directory"],
        sourceName: created.data.attributes["source-name"],
        sourceUrl: created.data.attributes["source-url"],
        tagNames: created.data.attributes["tag-names"],
        filteredWorkspaceIds: (await filteredByTags.json()).data.map(workspace => workspace.id),
        excludedWorkspaceIds: (await excludedByTag.json()).data.map(workspace => workspace.id),
        tagBindingWorkspaceIds: (await filteredByTagBindings.json()).data.map(workspace => workspace.id),
        wrongTagBindingWorkspaceIds: (await excludedByTagBindingValue.json()).data.map(workspace => workspace.id),
        updatedTagValue: (await updateTagBindings.json()).data.find(
          tag => tag.attributes.key === "environment",
        )?.attributes.value,
        tagBindingValues: (await tagBindings.json()).data.map(tag => tag.attributes.value).sort(),
        effectiveTagTypes: (await effectiveTagBindings.json()).data.map(tag => tag.type),
        clearTagBindings: clearTagBindings.status,
        nativeTerraformCreate: nativeTerraformCreate.status,
        nativeTerraformBinary: nativeTerraform.data.attributes["iac-binary"],
        duplicateCreate: duplicateCreate.status,
        invalidDirectory: invalidDirectory.status,
        patchStatus: patch.status,
        patchedDescription: patched.data.attributes.description,
        duplicatePatch: duplicatePatch.status,
        forceDeleteByName: forceDeleteByName.status,
        deleteTag: deleteTag.status,
        remainingTags: (await tags.json()).data.length,
        forceUnlock: forceUnlock.status,
        lockedReason: locked.data.attributes["locked-reason"],
        locked: unlocked.data.attributes.locked,
        runStatus: run?.status,
        publicPlanLogUrl,
        cwdMatches: initCwd === planCwd && initCwd.endsWith("/infra"),
        blockedSafeDelete: blockedSafeDelete.status,
        safeDeleteById: safeDeleteById.status,
        safeDeleteByName: safeDeleteByName.status,
      }));
      process.exit(0);
    `], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        TEST_DIR: testDir,
        DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
        STORAGE_DIR: join(testDir, "storage"),
        NODE_ENV: "production",
        PUBLIC_URL: "https://tfe.example.test",
        SIMULATED_RUNS: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr || stdout);

    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      createStatus: 201,
      description: "Primary workspace",
      workingDirectory: "infra",
      sourceName: "terraform-cli",
      sourceUrl: "https://developer.hashicorp.com/terraform/cli",
      tagNames: ["app", "environment"],
      filteredWorkspaceIds: [expect.any(String)],
      excludedWorkspaceIds: [],
      tagBindingWorkspaceIds: [expect.any(String)],
      wrongTagBindingWorkspaceIds: [],
      updatedTagValue: "staging",
      tagBindingValues: ["staging", "web"],
      effectiveTagTypes: ["effective-tag-bindings", "effective-tag-bindings"],
      clearTagBindings: 200,
      nativeTerraformCreate: 201,
      nativeTerraformBinary: "terraform",
      duplicateCreate: 409,
      invalidDirectory: 422,
      patchStatus: 200,
      patchedDescription: "Updated workspace",
      duplicatePatch: 409,
      forceDeleteByName: 204,
      deleteTag: 204,
      remainingTags: 0,
      forceUnlock: 200,
      lockedReason: "Locked manually",
      locked: false,
      runStatus: expect.stringMatching(/^(planned|planned_and_finished|applied)$/),
      publicPlanLogUrl: expect.stringMatching(/^https:\/\/tfe\.example\.test\/api\/v2\/runs\/.+\/plan\/log\//),
      cwdMatches: true,
      blockedSafeDelete: 409,
      safeDeleteById: 204,
      safeDeleteByName: 204,
    });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
