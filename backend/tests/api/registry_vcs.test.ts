import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  oauthClients,
  oauthTokens,
  organizationMemberships,
  organizations,
  registryModules,
  registryModuleVersions,
  users,
} from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/secrets";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";
import { makeRegistryModuleArchive } from "../registry-module-helpers";

describe("VCS-backed registry modules", () => {
  type VcsPayload = { data: { type: string; attributes: Record<string, unknown> } };
  type VersionResource = { id: string; attributes: Record<string, unknown> };
  const suffix = crypto.randomUUID();
  const orgId = `registry-vcs-org-${suffix}`;
  const orgName = `registry-vcs-${suffix}`;
  const ownerId = `registry-vcs-owner-${suffix}`;
  const readerId = `registry-vcs-reader-${suffix}`;
  const ownerToken = `registry-vcs-owner-token-${suffix}`;
  const readerToken = `registry-vcs-reader-token-${suffix}`;
  const oauthClientId = `registry-vcs-client-${suffix}`;
  const oauthTokenId = `registry-vcs-oauth-token-${suffix}`;

  let directory = "";
  let archiveBytes = new Uint8Array();
  let tags = [
    { name: "networking-v1.2.3", commit: { sha: "sha-123" } },
    { name: "networking-v1.2", commit: { sha: "bad-short" } },
    { name: "v9.0.0", commit: { sha: "wrong-prefix" } },
  ];

  function request(path: string, method = "GET", body?: unknown, token = ownerToken): Promise<Response> {
    return app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));
  }

  function vcsPayload(name: string, extra: Record<string, unknown> = {}): VcsPayload {
    return {
      data: {
        type: "registry-modules",
        attributes: {
          "module-name": name,
          "module-provider": "aws",
          "vcs-repo": {
            identifier: "acme/terraform-aws-networking",
            "display-identifier": "acme/terraform-aws-networking",
            "oauth-token-id": oauthTokenId,
          },
          ...extra,
        },
      },
    };
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "terrence-registry-vcs-"));
    const archive = join(directory, "repository.tar.gz");
    await makeRegistryModuleArchive(archive);
    archiveBytes = new Uint8Array(await Bun.file(archive).arrayBuffer());

    await db.insert(users).values([
      { id: ownerId, username: ownerId, passwordHash: "unused" },
      { id: readerId, username: readerId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId: ownerId, orgId, role: "owner", status: "active" },
      { id: crypto.randomUUID(), userId: readerId, orgId, role: "member", status: "active" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), userId: ownerId, token: createHash("sha256").update(ownerToken).digest("hex") },
      { id: crypto.randomUUID(), userId: readerId, token: createHash("sha256").update(readerToken).digest("hex") },
    ]);
    await db.insert(oauthClients).values({
      id: oauthClientId,
      orgId,
      name: "GitHub Enterprise",
      serviceProvider: "github_enterprise",
      apiUrl: "https://github.example/api/v3",
      httpUrl: "https://github.example",
      createdAt: Date.now(),
    });
    await db.insert(oauthTokens).values({
      id: oauthTokenId,
      oauthClientId,
      token: await encryptSecret("private-vcs-token"),
      createdAt: Date.now(),
    });

    setExternalUrlTransportForTests(async (target): Promise<Response> => {
      const url = new URL(target.url);
      if (url.pathname.endsWith("/tags")) return Response.json(tags);
      if (url.pathname.includes("/branches/")) return Response.json({ commit: { sha: "sha-branch" } });
      if (url.pathname.includes("/tarball/")) {
        return new Response(archiveBytes.slice(), {
          status: 200,
          headers: { "Content-Type": "application/gzip", "Content-Length": String(archiveBytes.byteLength) },
        });
      }
      throw new Error(`Unexpected VCS request: ${url}`);
    });
  });

  afterAll(async () => {
    setExternalUrlTransportForTests(undefined);
    const modules = await db.query.registryModules.findMany({ where: eq(registryModules.orgId, orgId) });
    const versions = await Promise.all(modules.map((module) => db.query.registryModuleVersions.findMany({
      where: eq(registryModuleVersions.moduleId, module.id),
    })));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, readerId));
    await Promise.allSettled(versions.flat().flatMap((version): Promise<void>[] =>
      version.archivePath === null ? [] : [rm(version.archivePath, { force: true })]));
    await rm(directory, { recursive: true, force: true });
  });

  test("authorizes publication and rejects invalid repositories or connections before persistence", async () => {
    expect((await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", vcsPayload("denied"), readerToken)).status).toBe(404);
    expect((await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", {
      data: { type: "registry-modules", attributes: { ...vcsPayload("bad-repo").data.attributes, "vcs-repo": { identifier: "not-a-repository", "oauth-token-id": oauthTokenId } } },
    })).status).toBe(422);
    expect((await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", {
      data: { type: "registry-modules", attributes: { ...vcsPayload("dot-repo").data.attributes, "vcs-repo": { identifier: "acme/..", "oauth-token-id": oauthTokenId } } },
    })).status).toBe(422);
    expect((await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", {
      data: { type: "registry-modules", attributes: { ...vcsPayload("bad-connection").data.attributes, "vcs-repo": { identifier: "acme/terraform-aws-networking", "oauth-token-id": "missing" } } },
    })).status).toBe(422);
    expect(await db.query.registryModules.findFirst({ where: eq(registryModules.name, "bad-connection") })).toBeUndefined();
  });

  test("imports prefixed tags from a source directory and resyncs idempotently", async () => {
    const created = await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", vcsPayload("networking", {
      "source-directory": "modules/subnet",
      "tag-prefix": "networking-",
    }));
    expect(created.status).toBe(201);
    const document = await created.json();
    const moduleId = document.data.id as string;
    expect(JSON.stringify(document)).not.toContain("private-vcs-token");
    expect(document.data.attributes.status).toBe("setup_complete");
    expect(document.data.attributes["vcs-repo"]).toMatchObject({
      "display-identifier": "acme/terraform-aws-networking",
      "repository-url": "https://github.example/acme/terraform-aws-networking",
      "source-directory": "modules/subnet",
      "tag-prefix": "networking-",
    });

    const versionsResponse = await request(`/api/v2/registry-modules/${moduleId}/versions`);
    const firstVersions = (await versionsResponse.json()).data as VersionResource[];
    expect(firstVersions).toHaveLength(1);
    const firstVersion = firstVersions[0];
    expect(firstVersion).toBeDefined();
    expect(firstVersion!.attributes).toMatchObject({
      version: "1.2.3",
      status: "ok",
      tag: "networking-v1.2.3",
      "commit-sha": "sha-123",
      "source-directory": "modules/subnet",
    });
    const metadata = firstVersion!.attributes["metadata"] as Record<string, unknown>;
    expect(metadata["readme"]).toContain("Subnet submodule");
    const stored = await db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, firstVersion!.id) });
    const listing = Bun.spawn(["tar", "-tzf", stored!.archivePath!], { stdout: "pipe" });
    const listed = await new Response(listing.stdout).text();
    expect(await listing.exited).toBe(0);
    expect(listed).toContain("./main.tf");
    expect(listed).not.toContain("examples/");

    const unchanged = await request(`/api/v2/registry-modules/${moduleId}/actions/resync`, "POST");
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()).meta.imported).toBe(0);

    tags = [...tags, { name: "networking-v1.3.0", commit: { sha: "sha-130" } }];
    const updated = await request(`/api/v2/registry-modules/${moduleId}/actions/resync`, "POST");
    expect(updated.status).toBe(200);
    expect((await updated.json()).meta).toMatchObject({ imported: 1, versions: ["1.3.0"] });
    expect(await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, moduleId) })).toHaveLength(2);

    tags = [...tags, { name: "networking-v1.4.0", commit: { sha: "sha-140" } }];
    const concurrent = await Promise.all([
      request(`/api/v2/registry-modules/${moduleId}/actions/resync`, "POST"),
      request(`/api/v2/registry-modules/${moduleId}/actions/resync`, "POST"),
    ]);
    expect(concurrent.map(({ status }): number => status)).toEqual([200, 200]);
    expect((await concurrent[0]!.json()).meta).toMatchObject({ imported: 1, versions: ["1.4.0"] });
    expect((await concurrent[1]!.json()).meta).toMatchObject({ imported: 1, versions: ["1.4.0"] });
    expect(await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, moduleId) })).toHaveLength(3);
  });

  test("publishes an immutable branch revision with an initial version", async () => {
    const payload = vcsPayload("branch-networking", { version: "2.0.0" });
    const vcsRepo = payload.data.attributes["vcs-repo"] as Record<string, unknown>;
    vcsRepo["branch"] = "release";
    const created = await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", payload);
    expect(created.status).toBe(201);
    const moduleId = (await created.json()).data.id as string;
    const versions = await request(`/api/v2/registry-modules/${moduleId}/versions`);
    expect((await versions.json()).data[0].attributes).toMatchObject({
      version: "2.0.0",
      branch: "release",
      "commit-sha": "sha-branch",
      status: "ok",
    });
  });

  test("rejects source archives above the network download limit", async () => {
    const goodArchive = archiveBytes;
    archiveBytes = new Uint8Array((1 * 1024 * 1024) + 1);
    let failed: Response | undefined;
    try {
      failed = await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", vcsPayload("oversized-download"));
    } finally {
      archiveBytes = goodArchive;
    }
    expect(failed?.status).toBe(422);
    const oversized = await db.query.registryModules.findFirst({ where: eq(registryModules.name, "oversized-download") });
    expect(oversized?.lastSyncError).toContain("too large");
  });

  test("keeps a failed ingest explicitly errored and out of protocol discovery", async () => {
    const goodArchive = archiveBytes;
    archiveBytes = new TextEncoder().encode("not a tar archive");
    const failed = await request(`/api/v2/organizations/${orgName}/registry-modules/vcs`, "POST", vcsPayload("broken", {
      "tag-prefix": "networking-",
    }));
    archiveBytes = goodArchive;
    expect(failed.status).toBe(422);
    const broken = await db.query.registryModules.findFirst({ where: eq(registryModules.name, "broken") });
    expect(broken).toMatchObject({ status: "errored" });
    expect(broken?.lastSyncError).toMatch(/gzip|archive|header/i);
    expect(await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, broken!.id) })).toHaveLength(0);
    const protocol = await request(`/api/registry/v1/modules/${orgName}/broken/aws/versions`);
    expect(protocol.status).toBe(200);
    expect((await protocol.json()).modules[0].versions).toEqual([]);
  });
});
