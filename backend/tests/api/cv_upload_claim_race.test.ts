import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  configurationVersions,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../../src/db/schema";
import { validTarGzip } from "./test-archives";

// Configuration-version upload claim race (todo 278): two simultaneous signed
// PUTs against the same pending configuration-version must not both write the
// archive. The atomic conditional-UPDATE claim lets exactly one request win;
// the loser gets 409.
describe("configuration-version upload claim race", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `cvrace-org-${suffix}`;
  const auth = `user-token-${suffix}`;
  const workspaceId = `ws-cvrace-${suffix}`;

  const request = (path: string, method = "GET", body?: BodyInit, headers: Record<string, string> = {}) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/octet-stream" }),
        ...headers,
      },
      body: body === undefined ? null : body,
    }));

  const requestJson = (path: string, method: string, body?: unknown): Promise<Response> =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  let cvId = "";

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: crypto.randomUUID(), userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({ id: crypto.randomUUID(), token: hashAuthenticationToken(auth), userId });
    await db.insert(workspaces).values({ id: workspaceId, name: `cvrace-${suffix}`, orgId });
    const cvRes = await requestJson(`/api/v2/workspaces/${workspaceId}/configuration-versions`, "POST", {
      data: { attributes: {} },
    });
    expect(cvRes.status).toBe(201);
    cvId = ((await cvRes.json()) as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await db.delete(configurationVersions).where(eq(configurationVersions.id, cvId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  const tarball = (tag: string): Uint8Array<ArrayBuffer> => validTarGzip(`fake-tar-gz-payload-${tag}-${"x".repeat(256)}`);

  it("only one of two simultaneous uploads wins; the loser gets 409", async () => {
    const [a, b] = await Promise.all([
      request(`/api/v2/configuration-versions/${cvId}/upload`, "PUT", tarball("a")),
      request(`/api/v2/configuration-versions/${cvId}/upload`, "PUT", tarball("b")),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
    expect(row?.status).toBe("uploaded");
    expect(row?.archivePath).not.toBeNull();
    // Claim lease is released after finalization.
    expect(row?.uploadClaimExpiresAt).toBeNull();
  });

  it("an in-progress claim blocks a third upload until it expires", async () => {
    // Simulate a crashed in-flight upload: a live claim, still pending.
    const claimedId = `cv-claim-${crypto.randomUUID()}`;
    await db.insert(configurationVersions).values({
      id: claimedId,
      workspaceId,
      status: "pending",
      autoQueueRuns: true,
      archivePath: null,
      speculative: false,
      provisional: false,
      source: "tfe-api",
      ingressAttributes: null,
      statusTimestamps: null,
      uploadClaimExpiresAt: Date.now() + 10 * 60 * 1000,
      error: null,
      errorMessage: null,
      softDeletedAt: null,
      createdAt: Date.now(),
    });

    const claimed = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, claimedId),
    });
    expect(claimed?.uploadClaimExpiresAt).not.toBeNull();

    const res = await request(`/api/v2/configuration-versions/${claimed!.id}/upload`, "PUT", tarball("c"));
    expect(res.status).toBe(409);

    // Once the claim is expired, the upload succeeds.
    await db.update(configurationVersions)
      .set({ uploadClaimExpiresAt: Date.now() - 1000 })
      .where(eq(configurationVersions.id, claimed!.id));
    const ok = await request(`/api/v2/configuration-versions/${claimed!.id}/upload`, "PUT", tarball("d"));
    expect(ok.status).toBe(200);

    await db.delete(configurationVersions).where(eq(configurationVersions.id, claimed!.id));
  });
});