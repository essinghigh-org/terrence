import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  runs,
  runTokens,
  stateVersions,
  users,
  workspaces,
} from "../../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { hashRunToken, mintRunToken } from "../../src/lib/run-token";
import { hashAuthenticationToken } from "../../src/lib/token-service";

// STATE-003: sensitive output authorization + masking.
//
// the reference format contract pinned here:
//  - `state-version-outputs` (and `current-state-version-outputs`) expose the
//    value of a sensitive output to an authorized principal;
//  - the `?include=outputs` workspace-outputs path MUST mask sensitive values
//    (authorized clients fetch them via the state-version-outputs endpoint);
//  - a run-scoped token for the producing workspace is an authorized principal
//    and may read sensitive outputs.

const STATE_PAYLOAD = JSON.stringify({
  version: 4,
  terraform_version: "1.7.0",
  outputs: {
    secret_output: { value: "super-secret", sensitive: true, type: "string" },
    plain_output: { value: "visible", type: "string" },
  },
});

describe("sensitive state output authorization (STATE-003)", () => {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const username = `outowner-${suffix}`;
  const orgName = `outorg-${suffix}`;
  const userTokenId = `utok-${suffix}`;
  const orgId = `org-out-${suffix}`;
  const wsId = `ws-out-${suffix}`;
  const runId = `run-out-${suffix}`;
  const otherUserId = `user-out-other-${suffix}`;
  const otherUserTokenId = `utok-other-${suffix}`;
  let userToken = "";
  let otherUserToken = "";
  let stateVersionId = "";

  const request = (path: string, auth: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: `user-out-${suffix}`, username, passwordHash: "unused" },
      { id: otherUserId, username: `outother-${suffix}`, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({ id: `mem-out-${suffix}`, userId: `user-out-${suffix}`, orgId, role: "owner" });
    await db.insert(apiTokens).values([
      { id: userTokenId, token: hashAuthenticationToken(`out-user-token-${suffix}`), userId: `user-out-${suffix}` },
      { id: otherUserTokenId, token: hashAuthenticationToken(`out-other-token-${suffix}`), userId: otherUserId },
    ]);
    userToken = `out-user-token-${suffix}`;
    otherUserToken = `out-other-token-${suffix}`;
    await db.insert(workspaces).values({ id: wsId, name: `out-ws-${suffix}`, orgId });
    await db.insert(runs).values({ id: runId, workspaceId: wsId, status: "planned", isDestroy: false, createdAt: Date.now() });
    const lock = await app.handle(new Request(`http://terrence.test/api/v2/workspaces/${wsId}/actions/lock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    }));
    if (lock.status !== 200) throw new Error(`workspace lock failed: ${lock.status}`);

    const svRes = await request(
      `/api/v2/workspaces/${wsId}/state-versions`,
      userToken,
      "POST",
      { data: { type: "state-versions", attributes: { serial: 1, state: STATE_PAYLOAD, md5: createHash("md5").update(STATE_PAYLOAD).digest("base64") } } },
    );
    expect(svRes.status).toBe(201);
    stateVersionId = (await svRes.json()).data.id as string;
  });

  afterAll(async () => {
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, wsId));
    await db.delete(runTokens).where(eq(runTokens.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-out-${suffix}`));
    await db.delete(apiTokens).where(inArray(apiTokens.id, [userTokenId, otherUserTokenId]));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, [`user-out-${suffix}`, otherUserId]));
  });

  const outputsById = (body: { data: { id: string; attributes: Record<string, unknown> }[] }) =>
    new Map(body.data.map((o) => [o.attributes["name"] as string, o.attributes]));

  it("exposes the sensitive output value to an authorized user token (state-version-outputs)", async () => {
    const res = await request(`/api/v2/state-versions/${stateVersionId}/state-version-outputs`, userToken);
    expect(res.status).toBe(200);
    const m = outputsById(await res.json());
    expect(m.get("secret_output")?.["value"]).toBe("super-secret");
    expect(m.get("secret_output")?.["sensitive"]).toBe(true);
    expect(m.get("plain_output")?.["value"]).toBe("visible");
  });

  it("exposes the sensitive output value through current-state-version-outputs", async () => {
    const res = await request(`/api/v2/workspaces/${wsId}/current-state-version-outputs`, userToken);
    expect(res.status).toBe(200);
    const m = outputsById(await res.json());
    expect(m.get("secret_output")?.["value"]).toBe("super-secret");
  });

  it("masks the sensitive output value on the ?include=outputs workspace path", async () => {
    const res = await request(`/api/v2/workspaces/${wsId}?include=outputs`, userToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const included = (body.included ?? []) as { type: string; attributes: Record<string, unknown> }[];
    const outputs = included.filter((r) => r.type === "workspace-outputs");
    const byName = new Map(outputs.map((o) => [o.attributes["name"] as string, o.attributes]));
    // Sensitive value is masked; the non-sensitive one is present.
    expect(byName.get("secret_output")?.["value"]).toBeNull();
    expect(byName.get("plain_output")?.["value"]).toBe("visible");
    expect(byName.get("secret_output")?.["sensitive"]).toBe(true);
  });

  it("grants a run-scoped token access to sensitive outputs of its workspace", async () => {
    const runToken = await mintRunToken(runId, wsId, orgId);
    const res = await request(`/api/v2/state-versions/${stateVersionId}/state-version-outputs`, runToken);
    expect(res.status).toBe(200);
    const m = outputsById(await res.json());
    expect(m.get("secret_output")?.["value"]).toBe("super-secret");
    await db.delete(runTokens).where(eq(runTokens.tokenHash, hashRunToken(runToken)));
  });

  it("denies sensitive output access to an unauthenticated request", async () => {
    const res = await request(`/api/v2/state-versions/${stateVersionId}/state-version-outputs`, "bogus-token");
    expect(res.status).toBe(401);
  });

  it("denies sensitive output access to a valid token from outside the organization", async () => {
    // A properly authenticated user with no membership in orgId must not be
    // able to read the workspace's outputs — this is an authorization check,
    // not merely an authentication check.
    const res = await request(`/api/v2/state-versions/${stateVersionId}/state-version-outputs`, otherUserToken);
    expect(res.status).toBe(404);
  });
});
