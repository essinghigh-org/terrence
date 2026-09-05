import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, configurationVersions, organizationMemberships, organizations,
  runs, stateVersions, teams, teamWorkspaces, users, workspaceTags, workspaceVariables, workspaces,
} from "../../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { validTarGzip } from "./test-archives";

const TEST_WORKSPACE_ID = `ws-run-test-${crypto.randomUUID()}`;
const TEST_USERNAME = `run-owner-${crypto.randomUUID()}`;

let workspaceId = "";
let userToken: string;
let userId = "";
let orgId = "";

describe("the reference format API v2 - Runs", () => {
  beforeAll(async () => {
    // Scope cleanup to only the rows this suite owns, so a parallel suite
    // sharing the same database is never wiped. The previous version deleted
    // the shared logs/runs/workspaces/etc. tables wholesale with no WHERE
    // clause — a cross-test contamination landmine.
    await db.delete(runs).where(eq(runs.workspaceId, TEST_WORKSPACE_ID));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, TEST_WORKSPACE_ID));
    await db.delete(stateVersions).where(eq(stateVersions.workspaceId, TEST_WORKSPACE_ID));
    await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, TEST_WORKSPACE_ID));
    await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, TEST_WORKSPACE_ID));
    await db.delete(workspaces).where(eq(workspaces.id, TEST_WORKSPACE_ID));
    await db.delete(users).where(eq(users.username, TEST_USERNAME));

    await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: TEST_USERNAME, password: "securepassword" } },
        }),
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: TEST_USERNAME, password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    const createdUser = await db.query.users.findFirst({ where: eq(users.username, TEST_USERNAME) });
    userId = createdUser?.id ?? "";

    // Create org via API so ownership membership is established
    const orgName = `homelab-runs-${Date.now()}`;
    const orgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: orgName } }
        })
      })
    );
    expect(orgRes.status).toBe(201);
    orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";

    const ws = await db.insert(workspaces).values({
      id: TEST_WORKSPACE_ID,
      name: "run-workspace",
      orgId: orgId,
      autoApply: false
    }).returning();
    workspaceId = ws[0]!.id;

    // Runs require an uploaded configuration version (issue #574), so seed
    // one for every test in this suite.
    const cvRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/configuration-versions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "configuration-versions", attributes: { auto_queue_runs: false, speculative: false } },
        }),
      })
    );
    expect(cvRes.status).toBe(201);
    const seededCvId = (await cvRes.json() as { data: { id: string } }).data.id;
    const uploadRes = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${seededCvId}/upload`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Authorization": `Bearer ${userToken}`
        },
        body: validTarGzip("runs-suite"),
      })
    );
    expect(uploadRes.status).toBe(200);
  });

  it("should create a run", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: {
              message: "Custom run message",
              "auto-apply": true,
            },
            relationships: {
              workspace: {
                data: {
                  id: workspaceId,
                  type: "workspaces",
                },
              },
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("runs");
    expect(data.data.attributes.status).toBe("pending");
    expect(data.data.attributes.message).toBe("Custom run message");
    expect(data.data.attributes["auto-apply"]).toBe(true);
    expect(data.data.attributes.actions["is-force-cancelable"]).toBe(true);
    expect(data.data.attributes.permissions["can-force-cancel"]).toBe(true);

    const runInDb = await db.query.runs.findFirst({
      where: eq(runs.id, data.data.id),
    });
    expect(runInDb).toBeDefined();
    expect(runInDb?.status).toBe("pending");
    expect(runInDb?.autoApply).toBe(true);
  });

  it("should include created-by with included user data when fetching a single run", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: { message: "Test single run creator" },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
            },
          },
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { data: { id: string } };
    const runId = created.data.id;

    const response = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}`, {
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(response.status).toBe(200);
    const document = await response.json() as {
      data: { id: string; relationships?: Record<string, unknown> };
      included?: { id: string; type: string; attributes: Record<string, unknown> }[];
    };

    expect(document.data.relationships).toBeDefined();
    expect(document.data.relationships!["created-by"]).toBeDefined();
    const createdBy = document.data.relationships!["created-by"] as { data: { id: string; type: string } | null };
    expect(createdBy.data).toBeDefined();
    expect(createdBy.data!.type).toBe("users");

    expect(document.included).toBeDefined();
    expect(document.included!.length).toBeGreaterThan(0);
    const includedUser = document.included!.find((u: { type: string }): boolean => u.type === "users");
    expect(includedUser).toBeDefined();
    expect(includedUser!.attributes["username"]).toBe(TEST_USERNAME);
    expect(includedUser!.attributes["avatar-url"]).toMatch(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/);
  });

  it("lists runs with created-by included user data", async () => {
    // Create a run first
    const createRes = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: { message: "Triggered by test user" },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
            },
          },
        }),
      })
    );
    expect(createRes.status).toBe(201);

    // List runs for the workspace
    const listRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/runs`, {
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as {
      data: { id: string; relationships?: { "created-by"?: { data: { id: string; type: string } | null } } }[];
      included?: { id: string; type: string; attributes: { username: string; "avatar-url": string } }[];
    };

    const createdRun = listData.data.find((r) => r.relationships?.["created-by"]?.data?.id !== null);
    expect(createdRun).toBeDefined();
    expect(createdRun!.relationships!["created-by"]!.data!.type).toBe("users");

    // Check that included user data is present
    expect(listData.included).toBeDefined();
    expect(listData.included!.length).toBeGreaterThan(0);
    const includedUser = listData.included!.find((u) => u.type === "users");
    expect(includedUser).toBeDefined();
    expect(includedUser!.attributes.username).toBe(TEST_USERNAME);
    expect(includedUser!.attributes["avatar-url"]).toMatch(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/);
  });

  it("rejects destroy runs when destroy plans are disabled", async () => {
    const body = JSON.stringify({
      data: {
        type: "runs",
        attributes: {
          "is-destroy": true,
          message: "Destroy plan",
        },
        relationships: {
          workspace: {
            data: {
              id: workspaceId,
              type: "workspaces",
            },
          },
        },
      },
    });
    const createDestroyRun = (path: string): Promise<Response> => app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`,
        },
        body,
      }),
    );

    await db.update(workspaces)
      .set({ allowDestroyPlan: false })
      .where(eq(workspaces.id, workspaceId));

    for (const path of ["/api/v2/runs", `/api/v2/workspaces/${workspaceId}/runs`]) {
      const response = await createDestroyRun(path);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        errors: [{
          status: "422",
          title: "Unprocessable Entity",
          detail: "Destroy plans are disabled for this workspace",
        }],
      });
    }

    await db.update(workspaces)
      .set({ allowDestroyPlan: true })
      .where(eq(workspaces.id, workspaceId));
    const response = await createDestroyRun("/api/v2/runs");
    expect(response.status).toBe(201);
    const document = await response.json() as { data: { id: string; attributes: { "is-destroy": boolean } } };
    expect(document.data.attributes["is-destroy"]).toBe(true);
    expect(await db.query.runs.findFirst({ where: eq(runs.id, document.data.id) })).toMatchObject({
      isDestroy: true,
    });
  });

  it("rejects malformed run variables and unsafe target/replace addresses", async () => {
    const post = (attributes: Record<string, unknown>): Promise<Response> => app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          data: {
            attributes,
            relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
          },
        }),
      }),
    );

    // Variables must be objects with a string key and value.
    for (const variables of [
      [{ key: "foo" }],
      [{ value: "bar" }],
      [{ key: "foo", value: "bar" }, "not-an-object"],
      [{ key: "foo", value: "bar" }, null],
      [{ key: "", value: "bar" }],
      [{ key: "-malicious", value: "bar" }],
      [{ key: "foo", value: "bar\nevil" }],
    ]) {
      const response = await post({ variables });
      expect(response.status).toBe(422);
    }

    // A control-character-free, well-formed variable must be accepted.
    const validVariables = [{ key: "region", value: "us-east-1" }];
    const ok = await post({ variables: validVariables });
    expect(ok.status).toBe(201);

    // Unsafe target/replace addresses must be rejected.
    for (const attrs of [
      { "target-addrs": ["-auto-approve"] },
      { "target-addrs": ["aws_instance.foo bar"] },
      { "target-addrs": ["aws_instance.foo\nbar"] },
      { "target-addrs": "not-an-array" },
      { "replace-addrs": ["--flag"] },
    ]) {
      const response = await post(attrs);
      expect(response.status).toBe(422);
    }

    // A valid address must still be accepted.
    const okAddr = await post({ "target-addrs": ["aws_instance.example"] });
    expect(okAddr.status).toBe(201);

    // Valid indexed for_each addresses (quoted string indexes) must be accepted.
    const okIndexedAddr = await post({ "target-addrs": [`aws_instance.web["example"]`] });
    expect(okIndexedAddr.status).toBe(201);

    // A valid replacement address (indexed) must be accepted.
    const okReplaceAddr = await post({ "replace-addrs": [`aws_instance.web["example"]`] });
    expect(okReplaceAddr.status).toBe(201);
  });
});

describe("Run list sorting (kanban 14.8)", () => {
  const base = Date.now();
  let erroredId = "";
  let appliedId = "";
  let pendingId = "";

  // Retry 429s on the server's Retry-After hint instead of guessing a fixed
  // sleep (issue #382): a fixed nap fails under loaded runners when the window
  // needs longer, and wastes time when it does not.
  const handleWithRateLimitRetry = async (buildRequest: () => Request): Promise<Response> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await app.handle(buildRequest());
      if (res.status !== 429) return res;
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(Math.ceil(retryAfter * 1000), 5000)
        : 250 * (attempt + 1);
      await Bun.sleep(waitMs);
    }
    // Make one final request after the last retry wait. Returning the last
    // 429 would hide whether the rate-limit window has actually cleared.
    return app.handle(buildRequest());
  };

  const listRunIds = async (sort: string | null): Promise<string[]> => {
    const url = sort === null
      ? `http://localhost/api/v2/workspaces/${TEST_WORKSPACE_ID}/runs`
      : `http://localhost/api/v2/workspaces/${TEST_WORKSPACE_ID}/runs?sort=${encodeURIComponent(sort)}`;
    const response = await handleWithRateLimitRetry(
      () => new Request(url, { headers: { "Authorization": `Bearer ${userToken}` } }),
    );
    expect(response.status).toBe(200);
    const document = await response.json() as { data: { id: string }[] };
    return document.data.map((run): string => run.id);
  };

  const createRunFromApi = async (message: string): Promise<string> => {
    const res = await handleWithRateLimitRetry(
      () => new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          data: {
            attributes: { message },
            relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    // Isolate this workspace's list so the sort assertions are deterministic.
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));

    erroredId = await createRunFromApi("run-sort-errored");
    appliedId = await createRunFromApi("run-sort-applied");
    pendingId = await createRunFromApi("run-sort-pending");
    await db.update(runs).set({ status: "errored", createdAt: base - 3000 }).where(eq(runs.id, erroredId));
    await db.update(runs).set({ status: "applied", createdAt: base - 2000 }).where(eq(runs.id, appliedId));
    await db.update(runs).set({ status: "pending", createdAt: base - 1000 }).where(eq(runs.id, pendingId));
    // No fixed sleep here: the list/create helpers above retry 429s on the
    // server's Retry-After hint (issue #382).
  });

  it("defaults to newest-first", async () => {
    const ids = await listRunIds(null);
    expect(ids).toEqual([pendingId, appliedId, erroredId]);
  });

  it("honors explicit descending via -created-at", async () => {
    const ids = await listRunIds("-created-at");
    expect(ids).toEqual([pendingId, appliedId, erroredId]);
  });

  it("sorts ascending with created-at", async () => {
    const ids = await listRunIds("created-at");
    expect(ids).toEqual([erroredId, appliedId, pendingId]);
  });

  it("sorts by status lexicographically with created-at tiebreaker", async () => {
    const ids = await listRunIds("status");
    expect(ids).toEqual([appliedId, erroredId, pendingId]);
    const descIds = await listRunIds("-status");
    expect(descIds).toEqual([pendingId, erroredId, appliedId]);
  });

  it("falls back to newest-first for unknown sort keys", async () => {
    const ids = await listRunIds("message");
    expect(ids).toEqual([pendingId, appliedId, erroredId]);
  });

  it("breaks createdAt ties deterministically by run id", async () => {
    // Two runs sharing status and createdAt must still come back in a stable
    // order; the tiebreaker is id descending (newest id first).
    const twinIds = [await createRunFromApi("run-sort-twin-a"), await createRunFromApi("run-sort-twin-b")];
    await db.update(runs).set({ status: "applied", createdAt: base - 2000 }).where(inArray(runs.id, twinIds));
    const ids = await listRunIds("status");
    // appliedId shares the twins' status and createdAt, so all three must be
    // ordered purely by the id-descending tiebreaker.
    const tieExpected = [appliedId, ...twinIds].sort((a, b): number => b.localeCompare(a));
    expect(ids).toEqual([...tieExpected, erroredId, pendingId]);
  });
});

describe("run execution correctness (issues #583, #601)", () => {
  const suffix = crypto.randomUUID();
  const execWsId = `ws-run-exec-${suffix}`;
  const execCvId = `cv-run-exec-${suffix}`;
  const planTeamId = `team-run-exec-plan-${suffix}`;
  const planToken = `plan-token-${suffix}`;

  const authed = (token: string, init?: RequestInit): RequestInit => ({
    ...init,
    headers: {
      "Content-Type": "application/vnd.api+json",
      "Authorization": `Bearer ${token}`,
    },
  });

  const createRun = async (token: string, attributes: Record<string, unknown> = {}): Promise<Response> =>
    app.handle(new Request("http://localhost/api/v2/runs", authed(token, {
      method: "POST",
      body: JSON.stringify({
        data: {
          attributes,
          relationships: { workspace: { data: { id: execWsId, type: "workspaces" } } },
        },
      }),
    })));

  beforeAll(async () => {
    await db.insert(workspaces).values({ id: execWsId, name: `run-exec-${suffix}`, orgId, autoApply: true });
    await db.insert(configurationVersions).values({ id: execCvId, workspaceId: execWsId, status: "uploaded", archivePath: `test-only/cv-exec-${suffix}.tar.gz` });
    await db.insert(teams).values({ id: planTeamId, orgId, name: `plan-${suffix}` });
    await db.insert(teamWorkspaces).values({ id: `tw-exec-plan-${suffix}`, teamId: planTeamId, workspaceId: execWsId, access: "plan" });
    await db.insert(apiTokens).values({
      id: `token-exec-plan-${suffix}`,
      token: createHash("sha256").update(planToken).digest("hex"),
      teamId: planTeamId,
    });
  });

  afterAll(async () => {
    await db.delete(runs).where(eq(runs.workspaceId, execWsId));
    await db.delete(apiTokens).where(eq(apiTokens.id, `token-exec-plan-${suffix}`));
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.id, `tw-exec-plan-${suffix}`));
    await db.delete(teams).where(eq(teams.id, planTeamId));
    await db.delete(configurationVersions).where(eq(configurationVersions.id, execCvId));
    await db.delete(workspaces).where(eq(workspaces.id, execWsId));
  });

  it("warns when the workspace default auto-apply is suppressed by permissions (issue #601)", async () => {
    const response = await createRun(planToken);
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { attributes: Record<string, unknown> } };
    // The planner cannot apply, so the run waits even though the workspace
    // defaults to auto-apply — and now says so.
    expect(body.data.attributes["auto-apply"]).toBe(false);
    expect(typeof body.data.attributes["auto-apply-warning"]).toBe("string");
    expect(body.data.attributes["auto-apply-warning"] as string).toContain("apply permission");
  });

  it("still rejects an explicit auto-apply request without apply permission", async () => {
    const response = await createRun(planToken, { "auto-apply": true });
    expect(response.status).toBe(403);
  });

  it("carries no warning when the caller can apply", async () => {
    const response = await createRun(userToken);
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes["auto-apply"]).toBe(true);
    expect("auto-apply-warning" in body.data.attributes).toBe(false);
  });

  it("force-executes past a fetching blocker (issue #583)", async () => {
    const blockerId = `run-exec-blocker-${suffix}`;
    const pendingId = `run-exec-pending-${suffix}`;
    await db.insert(runs).values([
      { id: blockerId, workspaceId: execWsId, configurationVersionId: execCvId, status: "fetching", autoApply: false, createdAt: Date.now() },
      { id: pendingId, workspaceId: execWsId, configurationVersionId: execCvId, status: "pending", autoApply: false, createdAt: Date.now() },
    ]);
    const response = await app.handle(new Request(
      `http://localhost/api/v2/runs/${pendingId}/actions/force-execute`,
      authed(userToken, { method: "POST" }),
    ));
    expect(response.status).toBe(202);
    const blocker = await db.query.runs.findFirst({ where: eq(runs.id, blockerId) });
    expect(blocker?.status).toBe("force_canceled");
  });

  it("names the discardable blocker instead of claiming nothing blocks (issue #583)", async () => {
    const restingId = `run-exec-resting-${suffix}`;
    const pendingId = `run-exec-pending2-${suffix}`;
    await db.insert(runs).values([
      { id: restingId, workspaceId: execWsId, configurationVersionId: execCvId, status: "planned", autoApply: false, createdAt: Date.now() },
      { id: pendingId, workspaceId: execWsId, configurationVersionId: execCvId, status: "pending", autoApply: false, createdAt: Date.now() },
    ]);
    const response = await app.handle(new Request(
      `http://localhost/api/v2/runs/${pendingId}/actions/force-execute`,
      authed(userToken, { method: "POST" }),
    ));
    expect(response.status).toBe(409);
    const body = await response.json() as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail).toContain("discard");
    expect(body.errors[0]?.detail).toContain(restingId);
  });

  it("prefers the discard hint over force-canceling when active and resting blockers mix (issue #583)", async () => {
    // Hermetic: earlier tests in this block leave runs behind.
    await db.delete(runs).where(eq(runs.workspaceId, execWsId));
    const activeId = `run-exec-mixed-active-${suffix}`;
    const restingId = `run-exec-mixed-resting-${suffix}`;
    const pendingId = `run-exec-mixed-pending-${suffix}`;
    await db.insert(runs).values([
      { id: activeId, workspaceId: execWsId, configurationVersionId: execCvId, status: "fetching", autoApply: false, createdAt: Date.now() },
      { id: restingId, workspaceId: execWsId, configurationVersionId: execCvId, status: "planned", autoApply: false, createdAt: Date.now() },
      { id: pendingId, workspaceId: execWsId, configurationVersionId: execCvId, status: "pending", autoApply: false, createdAt: Date.now() },
    ]);
    const response = await app.handle(new Request(
      `http://localhost/api/v2/runs/${pendingId}/actions/force-execute`,
      authed(userToken, { method: "POST" }),
    ));
    // Clearing only the fetching run would 202 while the planned run still
    // holds the queue, so the endpoint must refuse and name the discard.
    expect(response.status).toBe(409);
    const body = await response.json() as { errors: { detail: string }[] };
    expect(body.errors[0]?.detail).toContain(restingId);
    const active = await db.query.runs.findFirst({ where: eq(runs.id, activeId) });
    expect(active?.status).toBe("fetching");
  });

  it("ignores a speculative resting blocker that holds no queue (issue #583)", async () => {
    // Hermetic: earlier tests in this block leave runs behind.
    await db.delete(runs).where(eq(runs.workspaceId, execWsId));
    const speculativeId = `run-exec-spec-${suffix}`;
    const activeId = `run-exec-spec-active-${suffix}`;
    const pendingId = `run-exec-spec-pending-${suffix}`;
    await db.insert(runs).values([
      { id: speculativeId, workspaceId: execWsId, configurationVersionId: execCvId, status: "planned", planOnly: true, autoApply: false, createdAt: Date.now() },
      { id: activeId, workspaceId: execWsId, configurationVersionId: execCvId, status: "fetching", autoApply: false, createdAt: Date.now() },
      { id: pendingId, workspaceId: execWsId, configurationVersionId: execCvId, status: "pending", autoApply: false, createdAt: Date.now() },
    ]);
    const response = await app.handle(new Request(
      `http://localhost/api/v2/runs/${pendingId}/actions/force-execute`,
      authed(userToken, { method: "POST" }),
    ));
    expect(response.status).toBe(202);
    const active = await db.query.runs.findFirst({ where: eq(runs.id, activeId) });
    expect(active?.status).toBe("force_canceled");
  });
});

afterAll(async () => {
  // Scope teardown to only what this suite created, in dependency order.
  await db.delete(runs).where(eq(runs.workspaceId, TEST_WORKSPACE_ID));
  await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, TEST_WORKSPACE_ID));
  await db.delete(stateVersions).where(eq(stateVersions.workspaceId, TEST_WORKSPACE_ID));
  await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, TEST_WORKSPACE_ID));
  await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, TEST_WORKSPACE_ID));
  await db.delete(workspaces).where(eq(workspaces.id, TEST_WORKSPACE_ID));
  if (orgId !== "") {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  if (userId !== "") {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
    await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
  }
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
});
