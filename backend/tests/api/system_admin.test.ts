import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { systemApiApp } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations, users, workspaces } from "../../src/db/schema";
import { setExternalUrlTransportForTests } from "../../src/lib/url-safety";

const SYSTEM_API_RATE_LIMIT_MS = 1100;

describe("System administration API contract", () => {
  const suffix = crypto.randomUUID();
  const adminId = `system-admin-${suffix}`;
  const memberId = `system-member-${suffix}`;
  const organizationId = `system-org-${suffix}`;
  const workspaceId = `system-workspace-${suffix}`;
  const adminToken = `system-admin-token-${suffix}`;
  const memberToken = `system-member-token-${suffix}`;
  let bundleId: string | undefined;

  const request = async (
    path: string,
    options: Readonly<{ method?: string; token?: string | null; body?: unknown; accept?: string }> = {},
  ): Promise<Response> => {
    // Use a fresh system token per request unless the caller pins one: the
    // System API rate-limits each token to one request/second (matching the reference format),
    // so back-to-back calls need distinct tokens.
    const bearer = options.token === null ? null : options.token ?? (await tokenFor(path));
    return systemApiApp.handle(new Request(`http://terrence.test${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
        ...(options.accept === undefined ? {} : { Accept: options.accept }),
        ...(options.body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: options.body === undefined ? null : JSON.stringify(options.body),
    }));
  };

  const systemTokenIds: string[] = [];

  // Mint one fresh system token per system-token request so consecutive calls
  // never trip the 1 req/sec/token limit.
  async function tokenFor(path: string): Promise<string> {
    const systemToken = `tfe-system-${path}-${crypto.randomUUID()}`;
    const { hashSystemApiToken } = await import("../../src/lib/system-api");
    const { systemApiTokens } = await import("../../src/db/schema");
    const tokenId = `system-api-token-${crypto.randomUUID()}`;
    systemTokenIds.push(tokenId);
    await db.insert(systemApiTokens).values({
      id: tokenId,
      tokenHash: hashSystemApiToken(systemToken),
      description: `system admin contract test ${path}`,
      expiresAt: Date.now() + 7_200_000,
    });
    return systemToken;
  }

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: memberId, username: memberId, passwordHash: "unused", isSiteAdmin: false },
    ]);
    await db.insert(apiTokens).values([
      {
        id: crypto.randomUUID(),
        token: hashAuthenticationToken(adminToken),
        userId: adminId,
      },
      {
        id: crypto.randomUUID(),
        token: hashAuthenticationToken(memberToken),
        userId: memberId,
      },
    ]);
    await db.insert(organizations).values({ id: organizationId, name: organizationId });
    await db.insert(workspaces).values({ id: workspaceId, orgId: organizationId, name: workspaceId });
  });

  afterAll(async () => {
    if (bundleId !== undefined) {
      const storage = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
      await unlink(join(storage, "support-bundles", `${bundleId}.json`)).catch((): undefined => undefined);
      await unlink(join(storage, "support-bundles", `${bundleId}.tar.gz`)).catch((): undefined => undefined);
    }
    const { systemApiTokens } = await import("../../src/db/schema");
    const { inArray } = await import("drizzle-orm");
    if (systemTokenIds.length > 0) {
      await db.delete(systemApiTokens).where(inArray(systemApiTokens.id, systemTokenIds));
    }
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, adminId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, memberId));
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, memberId));
  });

  it("requires a valid system token", async () => {
    expect((await request("/api/v1/diagnostics", { token: null, accept: "application/json" })).status).toBe(401);
    for (const path of [
      "/api/v1/diagnostics",
      "/api/v1/usage/bundle",
      "/api/v1/support/bundle-requests",
    ]) {
      // Application (user) tokens carry a credential, so the System API hides
      // the resource (404) rather than leaking it with a 403.
      const response = await request(path, { token: memberToken, accept: "application/json" });
      expect(response.status).toBe(404);
    }
  });

  it("runs filtered diagnostics and validates requests", async () => {
    const response = await request("/api/v1/diagnostics?check=database.connection&timeout=5", {
      accept: "application/json",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    const results = await response.json();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("OK");
    expect(results[0].checks).toEqual([{
      group: "database",
      status: "OK",
      checks: [{ name: "connection", status: "OK" }],
    }]);

    await Bun.sleep(SYSTEM_API_RATE_LIMIT_MS);
    const invalidTimeout = await request("/api/v1/diagnostics?timeout=0", { accept: "application/json" });
    expect(invalidTimeout.status).toBe(400);
    await Bun.sleep(SYSTEM_API_RATE_LIMIT_MS);
    const invalidAccept = await request("/api/v1/diagnostics", { accept: "text/plain" });
    expect(invalidAccept.status).toBe(406);
    await Bun.sleep(SYSTEM_API_RATE_LIMIT_MS);
    const invalidNode = await request("/api/v1/diagnostics?nodes=not-this-node", { accept: "application/json" });
    expect(invalidNode.status).toBe(400);
  });

  it("returns a privacy-limited usage bundle", async () => {
    const response = await request("/api/v1/usage/bundle");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    const bundle = await response.json();
    expect(bundle.version).toBe("2");
    expect(bundle.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.snapshots).toHaveLength(1);
    expect(bundle.snapshots[0].metrics.workspacecount.value).toBeGreaterThanOrEqual(1);
    expect(bundle.snapshots[0].metrics.workspacecount.mode).toBe("write");
  });

  it("validates dependency URLs before using the pinned transport", async () => {
    const originalEndpoint = process.env["TERRENCE_ARCHIVIST_URL"];
    const requests: { method: string; url: string }[] = [];
    setExternalUrlTransportForTests(async (target, init): Promise<Response> => {
      requests.push({ method: init.method, url: target.url });
      return new Response(null, { status: 204 });
    });
    try {
      process.env["TERRENCE_ARCHIVIST_URL"] = "https://archivist.test/health";
      const healthy = await request("/api/v1/diagnostics?check=archivist.connection", { accept: "application/json" });
      expect(healthy.status).toBe(200);
      const healthyResults = await healthy.json();
      expect(healthyResults[0].checks[0].checks[0].status).toBe("OK");
      expect(requests).toEqual([{ method: "GET", url: "https://archivist.test/health" }]);

      process.env["TERRENCE_ARCHIVIST_URL"] = "https://user:password@archivist.test/health";
      const beforeRejectedProbe = requests.length;
      const rejected = await request("/api/v1/diagnostics?check=archivist.connection", { accept: "application/json" });
      expect(rejected.status).toBe(503);
      const rejectedResults = await rejected.json();
      expect(rejectedResults[0].checks[0].checks[0].status).toBe("ERROR");
      expect(requests).toHaveLength(beforeRejectedProbe);
    } finally {
      if (originalEndpoint === undefined) Reflect.deleteProperty(process.env, "TERRENCE_ARCHIVIST_URL");
      else process.env["TERRENCE_ARCHIVIST_URL"] = originalEndpoint;
      setExternalUrlTransportForTests(undefined);
    }
  });

  it("generates, lists, downloads, and deletes a local support bundle", async () => {
    const createResponse = await request("/api/v1/support/bundle-requests", {
      method: "POST",
      body: {},
    });
    expect(createResponse.status).toBe(202);
    bundleId = (await createResponse.json()).data.id;
    expect(bundleId).toMatch(/^[0-9a-f-]{36}$/);

    let status = "generating";
    for (let attempt = 0; attempt < 100 && status === "generating"; attempt += 1) {
      await Bun.sleep(10);
      const detailResponse = await request(`/api/v1/support/bundle-requests/${String(bundleId)}`);
      expect(detailResponse.status).toBe(200);
      status = (await detailResponse.json()).data.attributes.status;
    }
    expect(status).toBe("finished");

    const listResponse = await request("/api/v1/support/bundle-requests?filter[status]=finished");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expect(list.data.some((bundle: Readonly<{ id: string }>): boolean => bundle.id === bundleId)).toBeTrue();
    expect((await request("/api/v1/support-bundle-requests")).status).toBe(200);

    const downloadResponse = await request(`/api/v1/support/bundle-requests/${String(bundleId)}/download`);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("application/gzip");
    expect(downloadResponse.headers.get("content-disposition")).toContain(`support-bundle-${String(bundleId)}.tar.gz`);
    const files = await new Bun.Archive(await downloadResponse.arrayBuffer()).files();
    const names = [...files.keys()];
    expect(names.some((name): boolean => name.endsWith("/diagnostics.json"))).toBeTrue();
    expect(names.some((name): boolean => name.endsWith("/usage.json"))).toBeTrue();
    expect(names.some((name): boolean => name.endsWith("/instance.json"))).toBeTrue();
    const contents = (await Promise.all([...files.values()].map((file): Promise<string> => file.text()))).join("\n");
    expect(contents).not.toContain(adminToken);
    expect(contents).not.toContain(memberToken);
    expect((await request(`/api/v1/support-bundle-requests/${String(bundleId)}`)).status).toBe(200);

    const deleteResponse = await request(`/api/v1/support/bundle-requests/${String(bundleId)}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);
    const goneResponse = await request(`/api/v1/support/bundle-requests/${String(bundleId)}`);
    expect(goneResponse.status).toBe(410);
  });
});