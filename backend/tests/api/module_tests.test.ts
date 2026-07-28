import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  registryModules,
  registryModuleVersions,
  users,
} from "../../src/db/schema";

describe("private registry module tests", () => {
  const suffix = crypto.randomUUID();
  const userId = `module-test-user-${suffix}`;
  const orgId = `module-test-org-${suffix}`;
  const moduleId = `module-test-module-${suffix}`;
  const versionId = `module-test-version-${suffix}`;
  const token = `module-test-token-${suffix}`;
  let directory = "";
  let archivePath = "";
  let argumentsPath = "";
  let previousBinary: string | undefined;

  const request = (path: string, method = "GET", body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "terrence-module-tests-"));
    const moduleDirectory = join(directory, "module");
    const testDirectory = join(moduleDirectory, "tests");
    const binaryPath = join(directory, "terraform-test");
    archivePath = join(directory, "module.tar.gz");
    argumentsPath = join(directory, "arguments.txt");
    await mkdir(testDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(moduleDirectory, "main.tf"), "variable \"replicas\" { type = number }\n"),
      writeFile(join(testDirectory, "basic.tftest.hcl"), "run \"basic\" { command = plan }\n"),
      writeFile(binaryPath, [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > '${argumentsPath}'`,
        "printf '%s\\n' '{\"type\":\"test_summary\",\"test_summary\":{\"passed\":2,\"failed\":0,\"errored\":0,\"skipped\":1}}'",
        "",
      ].join("\n")),
    ]);
    await chmod(binaryPath, 0o700);
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", moduleDirectory, "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await tar.exited).toBe(0);

    previousBinary = process.env.TERRAFORM_TEST_BINARY_PATH;
    process.env.TERRAFORM_TEST_BINARY_PATH = binaryPath;

    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: `module-test-${suffix}` });
    await db.insert(organizationMemberships).values({
      id: crypto.randomUUID(),
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(),
      token: createHash("sha256").update(token).digest("hex"),
      userId,
    });
    await db.insert(registryModules).values({
      id: moduleId,
      orgId,
      namespace: `module-test-${suffix}`,
      name: "verified",
      provider: "aws",
    });
    await db.insert(registryModuleVersions).values({
      id: versionId,
      moduleId,
      version: "1.2.3",
      status: "ok",
      archivePath,
    });
  });

  afterAll(async () => {
    if (previousBinary === undefined) delete process.env.TERRAFORM_TEST_BINARY_PATH;
    else process.env.TERRAFORM_TEST_BINARY_PATH = previousBinary;
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, versionId));
    await db.delete(registryModules).where(eq(registryModules.id, moduleId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("runs Terraform tests with validated configuration and persists results", async () => {
    const path = `/api/v2/registry-modules/${moduleId}/versions/1.2.3/test`;
    const response = await request(path, "POST", {
      data: {
        type: "test-runs",
        attributes: {
          verbose: true,
          filters: ["tests/basic.tftest.hcl"],
          "test-directory": "tests",
          variables: [{ key: "replicas", value: 2 }],
        },
      },
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.attributes).toMatchObject({
      status: "finished",
      "test-status": "pass",
      "tests-passed": 2,
      "tests-failed": 0,
      "tests-errored": 0,
      "tests-skipped": 1,
      verbose: true,
      filters: ["tests/basic.tftest.hcl"],
      "test-directory": "tests",
      variables: [{ key: "replicas", value: "2" }],
    });

    const persisted = await request(path);
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toEqual(body);

    const argumentsText = await readFile(argumentsPath, "utf8");
    expect(argumentsText).toContain("test\n");
    expect(argumentsText).toContain("-json\n");
    expect(argumentsText).toContain("-test-directory=tests\n");
    expect(argumentsText).toContain("-verbose\n");
    expect(argumentsText).toContain("-filter=tests/basic.tftest.hcl\n");
    expect(argumentsText).toContain("-var=replicas=2\n");
  });

  it("rejects unsafe test paths before invoking Terraform", async () => {
    const response = await request(
      `/api/v2/registry-modules/${moduleId}/versions/${versionId}/test`,
      "POST",
      {
        data: {
          type: "module-tests",
          attributes: { "test-directory": "../outside" },
        },
      },
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      errors: [{
        status: "422",
        title: "Unprocessable Entity",
        detail: "test-directory must be a safe relative path",
      }],
    });
  });
});
