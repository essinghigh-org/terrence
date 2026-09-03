import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  registryProviders,
  teams,
  users,
} from "../../src/db/schema";

describe("private registry GPG keys", () => {
  const suffix = crypto.randomUUID();
  const userId = `gpg-user-${suffix}`;
  const outsiderId = `gpg-outsider-${suffix}`;
  const orgId = `gpg-org-${suffix}`;
  const otherOrgId = `gpg-other-org-${suffix}`;
  const orgName = `gpg-${suffix}`;
  const otherOrgName = `gpg-other-${suffix}`;
  const teamId = `gpg-module-team-${suffix}`;
  const userToken = `gpg-user-token-${suffix}`;
  const outsiderToken = `gpg-outsider-token-${suffix}`;
  const moduleToken = `gpg-module-token-${suffix}`;
  const providerId = `gpg-provider-${suffix}`;
  const moduleId = `gpg-module-${suffix}`;
  const fingerprint = "111111111111111111111111AABBCCDDEEFF0011";
  const keyId = "AABBCCDDEEFF0011";
  const asciiArmor = [
    "-----BEGIN PGP PUBLIC KEY BLOCK-----",
    "",
    "ZmFrZS1wdWJsaWMta2V5",
    "-----END PGP PUBLIC KEY BLOCK-----",
    "",
  ].join("\n");
  let directory = "";
  let previousBinary: string | undefined;

  const request = (path: string, method = "GET", body?: unknown, token = userToken): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  const payload = (namespace: string, armor = asciiArmor): Record<string, unknown> => ({
    data: {
      type: "gpg-keys",
      attributes: { namespace, "ascii-armor": armor },
    },
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "terrence-gpg-api-"));
    const binary = join(directory, "gpg");
    await writeFile(binary, [
      "#!/bin/sh",
      "cat >/dev/null",
      `printf '%s\\n' 'pub:-:2048:1:${keyId}:1785256911:::-:::scSC::::::23::0:'`,
      `printf '%s\\n' 'fpr:::::::::${fingerprint}:'`,
      "",
    ].join("\n"));
    await chmod(binary, 0o700);
    previousBinary = process.env["GPG_BINARY_PATH"];
    process.env["GPG_BINARY_PATH"] = binary;

    await db.insert(users).values([
      { id: userId, username: userId, passwordHash: "unused" },
      { id: outsiderId, username: outsiderId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: otherOrgId, name: otherOrgName },
    ]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId, orgId: otherOrgId, role: "owner" },
    ]);
    await db.insert(teams).values({
      id: teamId,
      orgId,
      name: `gpg-module-managers-${suffix}`,
      organizationAccess: { "manage-modules": true },
    });
    await db.insert(apiTokens).values([
      {
        id: crypto.randomUUID(),
        token: createHash("sha256").update(userToken).digest("hex"),
        userId,
      },
      {
        id: crypto.randomUUID(),
        token: createHash("sha256").update(outsiderToken).digest("hex"),
        userId: outsiderId,
      },
      {
        id: crypto.randomUUID(),
        token: createHash("sha256").update(moduleToken).digest("hex"),
        teamId,
      },
    ]);
    await db.insert(registryProviders).values({
      id: providerId,
      orgId,
      namespace: orgName,
      type: `cloud-${suffix}`,
      registryName: "private",
    });
    await db.insert(registryModules).values({
      id: moduleId,
      orgId,
      namespace: orgName,
      name: `network-${suffix}`,
      provider: "aws",
    });
  });

  afterAll(async () => {
    if (previousBinary === undefined) delete process.env["GPG_BINARY_PATH"];
    else process.env["GPG_BINARY_PATH"] = previousBinary;
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, outsiderId));
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("validates, lists, moves, and deletes signing keys with namespace authorization", async () => {
    expect((await request("/api/registry/private/v2/gpg-keys")).status).toBe(400);
    expect((await request("/api/registry/public/v2/gpg-keys", "POST", payload(orgName))).status).toBe(403);
    expect((await request("/api/registry/private/v2/gpg-keys", "POST", payload(orgName, "not a key"))).status).toBe(422);

    const createResponse = await request(
      "/api/registry/private/v2/gpg-keys",
      "POST",
      payload(orgName),
      moduleToken,
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.data.attributes).toMatchObject({
      namespace: orgName,
      "key-id": keyId,
      "ascii-armor": asciiArmor,
    });
    expect((await request("/api/registry/private/v2/gpg-keys", "POST", payload(orgName))).status).toBe(422);

    const listPath = `/api/registry/private/v2/gpg-keys?filter%5Bnamespace%5D=${encodeURIComponent(orgName)}&page%5Bsize%5D=1`;
    const listResponse = await request(listPath, "GET", undefined, moduleToken);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed.data).toHaveLength(1);
    expect(listed.meta.pagination).toMatchObject({ "page-size": 1, "total-count": 1 });
    const keyPath = `/api/registry/private/v2/gpg-keys/${orgName}/${keyId}`;
    expect((await request(keyPath)).status).toBe(200);
    expect((await request(keyPath, "GET", undefined, outsiderToken)).status).toBe(404);

    const providerVersionResponse = await request(`/api/v2/registry-providers/${providerId}/versions`, "POST", {
      data: {
        type: "registry-provider-versions",
        attributes: { version: "1.0.0", "key-id": keyId, protocols: ["5.0"] },
      },
    });
    expect(providerVersionResponse.status).toBe(201);
    const providerVersion = await providerVersionResponse.json();
    const providerVersionId = providerVersion.data.id as string;
    expect(providerVersion.data.attributes["key-id"]).toBe(keyId);
    const platformResponse = await request(`/api/v2/registry-provider-versions/${providerVersionId}/platforms`, "POST", {
      data: {
        type: "registry-provider-platforms",
        attributes: {
          os: "linux",
          arch: "amd64",
          filename: "terraform-provider-cloud_linux_amd64.zip",
          "download-url": "https://example.invalid/provider.zip",
          shasum: "a".repeat(64),
        },
      },
    });
    expect(platformResponse.status).toBe(201);
    const download = await request(`/api/registry/v1/providers/${orgName}/cloud-${suffix}/1.0.0/download/linux/amd64`);
    expect(download.status).toBe(200);
    expect((await download.json()).signing_keys.gpg_public_keys).toEqual([{
      key_id: keyId,
      ascii_armor: asciiArmor,
    }]);

    const moduleVersionResponse = await request(`/api/v2/registry-modules/${moduleId}/versions`, "POST", {
      data: {
        type: "registry-module-versions",
        attributes: { version: "2.0.0", "key-id": keyId },
      },
    }, moduleToken);
    expect(moduleVersionResponse.status).toBe(201);
    const moduleVersion = await moduleVersionResponse.json();
    const moduleVersionId = moduleVersion.data.id as string;
    expect(moduleVersion.data.attributes["key-id"]).toBe(keyId);
    expect((await request(keyPath, "DELETE")).status).toBe(409);

    expect((await request(`/api/v2/registry-provider-versions/${providerVersionId}`, "DELETE")).status).toBe(204);
    expect((await request(`/api/v2/registry-module-versions/${moduleVersionId}`, "DELETE", undefined, moduleToken)).status).toBe(204);
    const moveResponse = await request(keyPath, "PATCH", {
      data: { type: "gpg-keys", attributes: { namespace: otherOrgName } },
    });
    expect(moveResponse.status).toBe(201);
    expect((await moveResponse.json()).data.attributes.namespace).toBe(otherOrgName);

    const movedPath = `/api/registry/private/v2/gpg-keys/${otherOrgName}/${keyId}`;
    expect((await request(keyPath)).status).toBe(404);
    expect((await request(movedPath)).status).toBe(200);
    expect((await request(movedPath, "DELETE")).status).toBe(204);
    expect((await request(movedPath)).status).toBe(404);
  });
});
