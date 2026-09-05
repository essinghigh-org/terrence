import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, configurationVersions, organizationMemberships, organizations, runs, users, workspaces,
} from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { validTarGzip } from "./test-archives";

// Issue #574: creating a run with no configuration available must fail fast
// with an actionable 422 instead of dying deep in the worker log.
describe("run creation requires a configuration (#574)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const userId = `usr-nocv-${suffix}`;
  const orgId = `org-nocv-${suffix}`;
  const orgName = `nocv-${suffix}`;
  const token = `token-nocv-${suffix}`;
  const emptyWsId = `ws-nocv-empty-${suffix}`;
  const seededWsId = `ws-nocv-seeded-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, contentType = "application/vnd.api+json") =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": contentType }),
      },
      ...(body === undefined ? {} : {
        body: body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body),
      }),
    }));

  const createRun = (workspaceId: string) => request("/api/v2/runs", "POST", {
    data: {
      type: "runs",
      attributes: { message: "configuration probe" },
      relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
    },
  });

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(workspaces).values([
      { id: emptyWsId, name: `nocv-empty-${suffix}`, orgId, executionMode: "remote" },
      { id: seededWsId, name: `nocv-seeded-${suffix}`, orgId, executionMode: "remote" },
    ]);
    // Seeded workspace gets one uploaded configuration version.
    const cvRes = await request(`/api/v2/workspaces/${seededWsId}/configuration-versions`, "POST", {
      data: { type: "configuration-versions", attributes: { auto_queue_runs: false, speculative: false } },
    });
    expect(cvRes.status).toBe(201);
    const cvId = (await cvRes.json() as { data: { id: string } }).data.id;
    const uploadRes = await request(
      `/api/v2/configuration-versions/${cvId}/upload`, "PUT",
      validTarGzip("nocv"), "application/octet-stream",
    );
    expect(uploadRes.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.workspaceId, emptyWsId)).catch((): void => {});
    await db.delete(runs).where(eq(runs.workspaceId, seededWsId)).catch((): void => {});
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, seededWsId)).catch((): void => {});
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId)).catch((): void => {});
    await db.delete(apiTokens).where(eq(apiTokens.id, `tok-${suffix}`)).catch((): void => {});
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`)).catch((): void => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch((): void => {});
    await db.delete(users).where(eq(users.id, userId)).catch((): void => {});
  });

  it("rejects runs on workspaces with no configuration version", async () => {
    const res = await createRun(emptyWsId);
    expect(res.status).toBe(422);
    const body = await res.json() as { errors?: { detail?: string }[] };
    expect(body.errors?.[0]?.detail).toContain("Upload a configuration version or connect a VCS repository");
  });

  it("creates runs once a configuration version is uploaded", async () => {
    const res = await createRun(seededWsId);
    expect(res.status).toBe(201);
  });
});
