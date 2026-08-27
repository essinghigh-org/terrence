import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";
import { reportRunVcsStatus } from "../src/lib/webhooks";
import {
  apiTokens,
  configurationVersions,
  githubAppInstallations,
  githubWebhookDeliveries,
  oauthClients,
  oauthTokens,
  organizationMemberships,
  organizations,
  runs,
  users,
  workspaces,
} from "../src/db/schema";

const orgId = "org-webhook-test";
const orgName = "webhook-org-test";
const workspaceId = "ws-webhook-test";
const secondWorkspaceId = "ws-webhook-test-2";
const crossProviderWorkspaceId = "ws-webhook-cross-provider";
const crossProviderClientId = "oauthc-webhook-cross-provider";
const crossProviderTokenId = "oautht-webhook-cross-provider";
const crossProviderConfigurationId = "cv-webhook-cross-provider";
const crossProviderRunId = "run-webhook-cross-provider";
const crossOrgId = "org-webhook-cross-tenant";
const userId = "usr-webhook-test";
const authToken = "webhook-test-token";
const installationId = "ghain-webhook-test";
const secondaryInstallationId = "ghain-webhook-test-2";
const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
const originalAppId = process.env.GITHUB_APP_ID;
const originalPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
const originalAppApiUrl = process.env.GITHUB_APP_API_URL;
const originalFetch = globalThis.fetch;
let tarballFetches = 0;
const tarballRequests: { url: string; authorization: string | null }[] = [];
const commitStatuses: Record<string, unknown>[] = [];

const pushPayload = {
  ref: "refs/heads/main",
  after: "1234567890abcdef1234567890abcdef12345678",
  head_commit: {
    message: "Update Terraform\n\nInclude the latest provider changes",
    url: "https://github.com/hashicorp/terraform/commit/1234567890abcdef1234567890abcdef12345678",
    author: { username: "commit-author" },
    committer: { username: "essinghigh" },
  },
  sender: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/110120257?v=4" },
  repository: {
    full_name: "hashicorp/terraform",
    clone_url: "https://github.com/hashicorp/terraform.git",
  },
  commits: [{ added: ["src/new-file.ts"] }],
};

function pullRequestPayload(): Record<string, unknown> {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      head: { ref: "main", sha: "abcdef123abcdef123abcdef123abcdef123abcd" },
      title: "New feature",
      html_url: "https://github.com/hashicorp/terraform/pull/42",
    },
    sender: { login: "octocat" },
    repository: {
      full_name: "hashicorp/terraform",
      clone_url: "https://github.com/hashicorp/terraform.git",
    },
  };
}

async function generateSignature(payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `sha256=${Buffer.from(signature).toString("hex")}`;
}

async function sendWebhook(eventName: string, payload: Readonly<Record<string, unknown>>, deliveryId = crypto.randomUUID()): Promise<Response> {
  const rawPayload = JSON.stringify(payload);
  return app.handle(new Request("http://127.0.0.1/api/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": eventName,
      "x-hub-signature-256": await generateSignature(rawPayload),
    },
    body: rawPayload,
  }));
}

async function waitForRuns(predicate: (runList: readonly (typeof runs.$inferSelect)[]) => boolean): Promise<readonly (typeof runs.$inferSelect)[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const runList = await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) });
    if (predicate(runList)) return runList;
    await Bun.sleep(10);
  }
  return db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) });
}

async function waitForDelivery(deliveryId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const delivery = await db.query.githubWebhookDeliveries.findFirst({
      where: eq(githubWebhookDeliveries.id, deliveryId),
    });
    if (delivery?.status === "processed") return;
    await Bun.sleep(10);
  }
  throw new Error(`Delivery ${deliveryId} was not processed`);
}

async function waitForCommitStatus(): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (commitStatuses.length > 0) return commitStatuses.at(-1);
    await Bun.sleep(10);
  }
  return commitStatuses.at(-1);
}

async function waitForCommitStatusMatching(predicate: (status: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = commitStatuses.find(predicate);
    if (status !== undefined) return status;
    await Bun.sleep(10);
  }
  return commitStatuses.find(predicate);
}

describe("GitHub Webhooks", () => {
  beforeAll(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/access_tokens")) {
        return Response.json({ token: url.includes("/67891/") ? "secondary-token" : "test-token" });
      }
      if (url.includes("/pulls/42/files")) return Response.json([{ filename: "src/main.tf" }]);
      if (url.includes("/tarball/")) {
        tarballFetches += 1;
        tarballRequests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return new Response(new Uint8Array([1, 2, 3]));
      }
      if (url.includes("/statuses/")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : {};
        if (body !== null && typeof body === "object" && !Array.isArray(body)) {
          commitStatuses.push(body as Record<string, unknown>);
        }
        return Response.json({});
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });

    await db.delete(users).where(eq(users.id, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(users).values({ id: userId, username: `webhook-user-${Date.now()}`, passwordHash: "unused" });
    await db.insert(organizationMemberships).values({ id: "orgmem-webhook-test", userId, orgId, role: "owner" });
    await db.insert(apiTokens).values({
      id: "token-webhook-test",
      token: createHash("sha256").update(authToken).digest("hex"),
      userId,
      createdAt: Date.now(),
    });
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, installationId));
    await db.insert(githubAppInstallations).values({
      id: installationId,
      orgId,
      name: "webhook-install",
      installationId: 12345,
    });
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      name: "webhook-ws",
      vcsRepo: { identifier: "hashicorp/terraform", branch: "main", githubAppInstallationId: installationId },
      fileTriggersEnabled: true,
      triggerPrefixes: ["src/"],
      speculativeEnabled: true,
      queueAllRuns: true,
    });
  });

  beforeEach(async () => {
    tarballFetches = 0;
    tarballRequests.length = 0;
    commitStatuses.length = 0;
    await db.delete(githubWebhookDeliveries);
    await db.delete(runs).where(eq(runs.id, crossProviderRunId));
    await db.delete(configurationVersions).where(eq(configurationVersions.id, crossProviderConfigurationId));
    await db.delete(workspaces).where(eq(workspaces.id, secondWorkspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, crossProviderWorkspaceId));
    await db.delete(oauthTokens).where(eq(oauthTokens.id, crossProviderTokenId));
    await db.delete(oauthClients).where(eq(oauthClients.id, crossProviderClientId));
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, secondaryInstallationId));
    await db.delete(organizations).where(eq(organizations.id, crossOrgId));
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await db.update(workspaces)
      .set({
        speculativeEnabled: true,
        queueAllRuns: true,
        triggerPrefixes: ["src/"],
        triggerPatterns: [],
        vcsRepo: { identifier: "hashicorp/terraform", branch: "main", githubAppInstallationId: installationId },
      })
      .where(eq(workspaces.id, workspaceId));
    await db.update(organizations).set({
      aggregatedCommitStatusEnabled: true,
      sendPassingStatusesForUntriggeredSpeculativePlans: false,
    }).where(eq(organizations.id, orgId));
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    process.env.GITHUB_APP_ID = originalAppId;
    process.env.GITHUB_APP_PRIVATE_KEY = originalPrivateKey;
    process.env.GITHUB_APP_API_URL = originalAppApiUrl;
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, secondWorkspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, crossProviderWorkspaceId));
    await db.delete(oauthTokens).where(eq(oauthTokens.id, crossProviderTokenId));
    await db.delete(oauthClients).where(eq(oauthClients.id, crossProviderClientId));
    await db.delete(organizations).where(eq(organizations.id, crossOrgId));
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, installationId));
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, secondaryInstallationId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("organization owners can register and use a scoped installation", async () => {
    const registerResponse = await app.handle(new Request(`http://127.0.0.1/api/v2/organizations/${orgName}/github-app/installations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: {
          type: "github-app-installations",
          attributes: { name: "secondary-installation", "installation-id": 67890 },
        },
      }),
    }));
    expect(registerResponse.status).toBe(201);
    const registered = await registerResponse.json() as { data: { id: string } };

    const createWorkspaceResponse = await app.handle(new Request(`http://127.0.0.1/api/v2/organizations/${orgName}/workspaces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: {
          type: "workspaces",
          attributes: {
            name: "scoped-installation-workspace",
            "vcs-repo": {
              identifier: "hashicorp/terraform",
              "github-app-installation-id": registered.data.id,
            },
          },
        },
      }),
    }));
    expect(createWorkspaceResponse.status).toBe(201);
    const workspaceResponse = await createWorkspaceResponse.json() as {
      data: { attributes: { "vcs-repo": { "github-app-installation-id": string } } };
    };
    expect(workspaceResponse.data.attributes["vcs-repo"]["github-app-installation-id"]).toBe(registered.data.id);
    await db.delete(workspaces).where(eq(workspaces.name, "scoped-installation-workspace"));
  });

  test("missing signature returns 401 when secret is configured", async () => {
    const response = await app.handle(new Request("http://127.0.0.1/api/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(401);
  });

  test("invalid signature is rejected", async () => {
    const response = await app.handle(new Request("http://127.0.0.1/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: JSON.stringify({ test: "data" }),
    }));
    expect(response.status).toBe(401);
  });

  test("matching push creates a standard run", async () => {
    const deliveryId = crypto.randomUUID();
    expect((await sendWebhook("push", pushPayload, deliveryId)).status).toBe(200);
    const runList = await waitForRuns((items): boolean => items.some((run): boolean => !run.planOnly));
    await waitForDelivery(deliveryId);
    const run = runList.find((item): boolean => item.workspaceId === workspaceId && !item.planOnly);
    expect(run).toBeDefined();
    if (run === undefined) return;
    expect(run.message).toBe("Update Terraform");
    expect(run.createdBy).toBeNull();
    const runResponse = await app.handle(new Request(`http://127.0.0.1/api/v2/runs/${run.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    }));
    const runDocument = await runResponse.json() as {
      data: { attributes: Record<string, unknown> };
    };
    expect(runDocument.data.attributes).toMatchObject({
      "triggered-by": "octocat",
      "triggered-by-avatar-url": expect.stringMatching(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/),
    });
    const eventResponse = await app.handle(new Request(`http://127.0.0.1/api/v2/runs/${run.id}/run-events`, {
      headers: { Authorization: `Bearer ${authToken}` },
    }));
    const eventDocument = await eventResponse.json() as {
      data: { attributes: Record<string, unknown> }[];
    };
    expect(eventDocument.data[0]?.attributes).toMatchObject({
      "actor-username": "octocat",
      "actor-avatar-url": expect.stringMatching(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/),
    });
    expect(tarballFetches).toBe(1);
    expect(await waitForCommitStatus()).toMatchObject({ state: "pending" });
  });

  test("push attributed to sender not web-flow committer (GH squash-merge regression)", async () => {
    const webFlowPayload = {
      ...pushPayload,
      head_commit: {
        message: "Squash merge",
        url: "https://github.com/hashicorp/terraform/commit/aaaaaaaa",
        author: { username: "henry" },
        committer: { username: "web-flow" },
      },
      sender: { login: "henry", avatar_url: "https://avatars.githubusercontent.com/u/123" },
    };
    const deliveryId = crypto.randomUUID();
    expect((await sendWebhook("push", webFlowPayload, deliveryId)).status).toBe(200);
    const runList = await waitForRuns((items): boolean => items.some((run): boolean => !run.planOnly));
    await waitForDelivery(deliveryId);
    const run = runList.find((item): boolean => item.workspaceId === workspaceId && !item.planOnly);
    expect(run).toBeDefined();
    if (run === undefined) return;
    const runResponse = await app.handle(new Request(`http://127.0.0.1/api/v2/runs/${run.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    }));
    const runDocument = await runResponse.json() as { data: { attributes: Record<string, unknown> } };
    expect(runDocument.data.attributes["triggered-by"]).toBe("henry");
  });

  test("supports aggregated and per-workspace commit statuses", async () => {
    await db.update(organizations).set({ aggregatedCommitStatusEnabled: false }).where(eq(organizations.id, orgId));
    const nonAggregatedDelivery = crypto.randomUUID();
    await sendWebhook("push", pushPayload, nonAggregatedDelivery);
    await waitForDelivery(nonAggregatedDelivery);
    expect(await waitForCommitStatusMatching((status): boolean => status.context === "terrence/webhook-ws")).toBeDefined();

    commitStatuses.length = 0;
    await db.update(organizations).set({ aggregatedCommitStatusEnabled: true }).where(eq(organizations.id, orgId));
    const aggregatedDelivery = crypto.randomUUID();
    await sendWebhook("push", pushPayload, aggregatedDelivery);
    await waitForDelivery(aggregatedDelivery);
    expect(await waitForCommitStatusMatching((status): boolean => status.context === "terrence")).toBeDefined();
  });

  test("reports failed runs as failure", async () => {
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", pushPayload, deliveryId);
    const runList = await waitForRuns((items): boolean => items.length === 1);
    await waitForDelivery(deliveryId);
    const run = runList[0];
    expect(run).toBeDefined();
    if (run === undefined) return;
    await db.update(runs).set({ status: "errored" }).where(eq(runs.id, run.id));
    await reportRunVcsStatus(run.id, "errored");
    expect(await waitForCommitStatusMatching((status): boolean => status.state === "failure")).toMatchObject({ state: "failure" });
  });

  test("matching pull request creates a speculative run", async () => {
    const deliveryId = crypto.randomUUID();
    expect((await sendWebhook("pull_request", pullRequestPayload(), deliveryId)).status).toBe(200);
    const runList = await waitForRuns((items): boolean => items.some((run): boolean => run.planOnly));
    await waitForDelivery(deliveryId);
    expect(runList.find((run): boolean => run.workspaceId === workspaceId && run.planOnly)).toBeDefined();
  });

  test("can pass unaffected pull requests when non-aggregated statuses are enabled", async () => {
    await db.update(organizations).set({
      aggregatedCommitStatusEnabled: false,
      sendPassingStatusesForUntriggeredSpeculativePlans: true,
    }).where(eq(organizations.id, orgId));
    await db.update(workspaces).set({ triggerPrefixes: ["infra/"] }).where(eq(workspaces.id, workspaceId));
    const deliveryId = crypto.randomUUID();
    await sendWebhook("pull_request", pullRequestPayload(), deliveryId);
    await waitForDelivery(deliveryId);
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(0);
    expect(await waitForCommitStatusMatching((status): boolean => status.state === "success")).toMatchObject({ state: "success" });
  });

  test("non-matching branch creates no run", async () => {
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", { ...pushPayload, ref: "refs/heads/release" }, deliveryId);
    await waitForDelivery(deliveryId);
    expect((await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).length).toBe(0);
  });

  test("matching tag regex creates a run and records the tag", async () => {
    await db.update(workspaces).set({
      vcsRepo: {
        identifier: "hashicorp/terraform",
        branch: "main",
        githubAppInstallationId: installationId,
        tagsRegex: "^v\\d+\\.\\d+\\.\\d+$",
      },
    }).where(eq(workspaces.id, workspaceId));
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", {
      ...pushPayload,
      ref: "refs/tags/v1.2.3",
      commits: [{ modified: ["docs/readme.md"] }],
    }, deliveryId);
    const runList = await waitForRuns((items): boolean => items.length === 1);
    await waitForDelivery(deliveryId);
    const run = runList[0];
    expect(run?.message).toBe("Update Terraform");
    const configurationVersion = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, run?.configurationVersionId ?? ""),
    });
    expect(configurationVersion?.ingressAttributes?.tag).toBe("v1.2.3");
    expect(configurationVersion?.ingressAttributes?.branch).toBeUndefined();
    expect(tarballFetches).toBe(1);
  });

  test("tag-triggered workspaces ignore ordinary branch pushes", async () => {
    await db.update(workspaces).set({
      vcsRepo: {
        identifier: "hashicorp/terraform",
        branch: "main",
        githubAppInstallationId: installationId,
        tagsRegex: "^v\\d+\\.\\d+\\.\\d+$",
      },
    }).where(eq(workspaces.id, workspaceId));
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", pushPayload, deliveryId);
    await waitForDelivery(deliveryId);
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(0);
  });

  test("non-matching or invalid tag regex creates no run", async () => {
    for (const tagsRegex of ["^release-", "["]) {
      await db.update(workspaces).set({
        vcsRepo: {
          identifier: "hashicorp/terraform",
          branch: "main",
          githubAppInstallationId: installationId,
          tagsRegex,
        },
      }).where(eq(workspaces.id, workspaceId));
      const deliveryId = crypto.randomUUID();
      await sendWebhook("push", { ...pushPayload, ref: "refs/tags/v1.2.3" }, deliveryId);
      await waitForDelivery(deliveryId);
    }
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(0);
  });

  test("changes outside trigger prefixes create no run", async () => {
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", { ...pushPayload, commits: [{ modified: ["docs/readme.md"] }] }, deliveryId);
    await waitForDelivery(deliveryId);
    expect((await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).length).toBe(0);
  });

  test("empty commit on a matching branch creates no run", async () => {
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", {
      ...pushPayload,
      commits: [{ added: [], modified: [], removed: [] }],
    }, deliveryId);
    await waitForDelivery(deliveryId);
    expect((await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).length).toBe(0);
    expect((await db.query.configurationVersions.findMany({ where: eq(configurationVersions.workspaceId, workspaceId) })).length).toBe(0);
    expect(tarballFetches).toBe(0);
    expect(commitStatuses).toHaveLength(0);
  });

  test("empty-commit tag push matching the tags regex still creates a run", async () => {
    await db.update(workspaces).set({
      vcsRepo: {
        identifier: "hashicorp/terraform",
        branch: "main",
        githubAppInstallationId: installationId,
        tagsRegex: "^v\\d+\\.\\d+\\.\\d+$",
      },
    }).where(eq(workspaces.id, workspaceId));
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", {
      ...pushPayload,
      ref: "refs/tags/v2.3.4",
      commits: [],
    }, deliveryId);
    const runList = await waitForRuns((items): boolean => items.some((run): boolean => !run.planOnly));
    await waitForDelivery(deliveryId);
    const run = runList.find((item): boolean => item.workspaceId === workspaceId && !item.planOnly);
    expect(run).toBeDefined();
    if (run === undefined) return;
    expect(run.message).toBe("Update Terraform");
    expect(tarballFetches).toBe(1);
  });

  test("trigger patterns use repository-root glob matching", async () => {
    await db.update(workspaces).set({ triggerPatterns: ["/**/networking/*.tf"] }).where(eq(workspaces.id, workspaceId));
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", {
      ...pushPayload,
      commits: [{ modified: ["environments/dev/networking/main.tf"] }],
    }, deliveryId);
    const runList = await waitForRuns((items): boolean => items.length === 1);
    await waitForDelivery(deliveryId);
    expect(runList).toHaveLength(1);
  });

  test("disabled speculative runs create no pull request run", async () => {
    await db.update(workspaces).set({ speculativeEnabled: false, queueAllRuns: true }).where(eq(workspaces.id, workspaceId));
    const deliveryId = crypto.randomUUID();
    await sendWebhook("pull_request", pullRequestPayload(), deliveryId);
    await waitForDelivery(deliveryId);
    expect((await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).length).toBe(0);
  });

  test("duplicate delivery IDs create only one run", async () => {
    const deliveryId = crypto.randomUUID();
    await Promise.all([
      sendWebhook("push", pushPayload, deliveryId),
      sendWebhook("push", pushPayload, deliveryId),
    ]);
    const runList = await waitForRuns((items): boolean => items.length === 1);
    await waitForDelivery(deliveryId);
    expect(runList).toHaveLength(1);
  });

  test("one tarball download serves all matching workspaces", async () => {
    await db.insert(workspaces).values({
      id: secondWorkspaceId,
      orgId,
      name: "webhook-ws-2",
      vcsRepo: { identifier: "hashicorp/terraform", branch: "main", githubAppInstallationId: installationId },
      fileTriggersEnabled: true,
      triggerPrefixes: ["src/"],
      queueAllRuns: true,
    });
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", pushPayload, deliveryId);
    await waitForDelivery(deliveryId);
    const runList = await db.query.runs.findMany();
    expect(runList.filter((run): boolean => run.workspaceId === workspaceId || run.workspaceId === secondWorkspaceId)).toHaveLength(2);
    expect(tarballFetches).toBe(1);
  });

  test("aggregates same-commit runs across distinct GitHub installations", async () => {
    await db.insert(githubAppInstallations).values({
      id: secondaryInstallationId,
      orgId,
      name: "webhook-install-2",
      installationId: 67891,
    });
    await db.insert(workspaces).values({
      id: secondWorkspaceId,
      orgId,
      name: "webhook-ws-2",
      vcsRepo: { identifier: "hashicorp/terraform", branch: "main", githubAppInstallationId: secondaryInstallationId },
      fileTriggersEnabled: true,
      triggerPrefixes: ["src/"],
      queueAllRuns: true,
    });

    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", pushPayload, deliveryId);
    await waitForDelivery(deliveryId);
    const matchingRuns = (await db.query.runs.findMany()).filter(
      (run): boolean => run.workspaceId === workspaceId || run.workspaceId === secondWorkspaceId,
    );
    expect(matchingRuns).toHaveLength(2);
    const primaryRun = matchingRuns.find((run): boolean => run.workspaceId === workspaceId);
    const secondaryRun = matchingRuns.find((run): boolean => run.workspaceId === secondWorkspaceId);
    expect(primaryRun).toBeDefined();
    expect(secondaryRun).toBeDefined();
    if (primaryRun === undefined || secondaryRun === undefined) return;

    await db.update(runs).set({ status: "errored" }).where(eq(runs.id, primaryRun.id));
    await db.update(runs).set({ status: "applied" }).where(eq(runs.id, secondaryRun.id));
    commitStatuses.length = 0;
    await reportRunVcsStatus(secondaryRun.id, "applied");

    expect(commitStatuses.at(-1)).toMatchObject({
      state: "failure",
      context: "terrence",
      description: "2 workspace runs: failure",
    });
  });

  test("does not route a GitHub event to a non-GitHub workspace with the same identifier", async () => {
    await db.insert(oauthClients).values({
      id: crossProviderClientId,
      orgId,
      name: "cross-provider-gitlab",
      serviceProvider: "gitlab",
      apiUrl: "https://gitlab.example/api/v4",
      httpUrl: "https://gitlab.example",
      key: "test-key",
      secret: "test-secret",
    });
    await db.insert(oauthTokens).values({
      id: crossProviderTokenId,
      oauthClientId: crossProviderClientId,
      token: "cross-provider-token",
      createdAt: Date.now(),
    });
    await db.insert(workspaces).values({
      id: crossProviderWorkspaceId,
      orgId,
      name: "cross-provider-workspace",
      vcsRepo: { identifier: "hashicorp/terraform", branch: "main", oauthTokenId: crossProviderTokenId },
      fileTriggersEnabled: true,
      triggerPrefixes: ["src/"],
      queueAllRuns: true,
    });

    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", pushPayload, deliveryId);
    await waitForDelivery(deliveryId);
    const githubRun = await db.query.runs.findFirst({ where: eq(runs.workspaceId, workspaceId) });
    expect(githubRun).toBeDefined();
    if (githubRun === undefined) return;
    await db.insert(configurationVersions).values({
      id: crossProviderConfigurationId,
      workspaceId: crossProviderWorkspaceId,
      status: "uploaded",
      source: "gitlab",
      ingressAttributes: { commitSha: pushPayload.after },
    });
    await db.insert(runs).values({
      id: crossProviderRunId,
      workspaceId: crossProviderWorkspaceId,
      configurationVersionId: crossProviderConfigurationId,
      status: "applied",
      createdAt: Date.now(),
    });
    await db.update(runs).set({ status: "applied" }).where(eq(runs.id, githubRun.id));
    commitStatuses.length = 0;
    await reportRunVcsStatus(githubRun.id, "applied");

    expect(commitStatuses.at(-1)).toMatchObject({
      state: "success",
      context: "terrence",
      description: "1 workspace run: success",
    });
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, crossProviderWorkspaceId) })).toHaveLength(1);
    expect(tarballFetches).toBe(1);
  });

  test("uses each matching workspace's GitHub installation credentials", async () => {
    await db.insert(githubAppInstallations).values({
      id: secondaryInstallationId,
      orgId,
      name: "webhook-install-2",
      installationId: 67891,
    });
    await db.insert(workspaces).values({
      id: secondWorkspaceId,
      orgId,
      name: "webhook-ws-2",
      vcsRepo: { identifier: "hashicorp/terraform", branch: "main", githubAppInstallationId: secondaryInstallationId },
      fileTriggersEnabled: true,
      triggerPrefixes: ["src/"],
      queueAllRuns: true,
    });
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", pushPayload, deliveryId);
    await waitForDelivery(deliveryId);
    const runList = await db.query.runs.findMany();
    expect(runList.filter((run): boolean => run.workspaceId === workspaceId || run.workspaceId === secondWorkspaceId)).toHaveLength(2);
    expect(tarballFetches).toBe(2);
    expect(tarballRequests.map((request): string | null => request.authorization).sort()).toEqual([
      "Bearer secondary-token",
      "Bearer test-token",
    ]);
  });

  test("uses the configured GitHub Enterprise API URL", async () => {
    const enterpriseApiUrl = "https://github-enterprise.example/api/v3";
    const previousApiUrl = process.env.GITHUB_APP_API_URL;
    process.env.GITHUB_APP_API_URL = enterpriseApiUrl;
    try {
      const deliveryId = crypto.randomUUID();
      await sendWebhook("push", pushPayload, deliveryId);
      await waitForDelivery(deliveryId);
      expect(tarballRequests).toHaveLength(1);
      expect(tarballRequests[0]?.url).toBe(`${enterpriseApiUrl}/repos/hashicorp/terraform/tarball/${pushPayload.after}`);
      expect(tarballRequests[0]?.authorization).toBe("Bearer test-token");
    } finally {
      process.env.GITHUB_APP_API_URL = previousApiUrl;
    }
  });

  test("missing token leaves the run and marks its configuration version errored", async () => {
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY = "";
    try {
      const deliveryId = crypto.randomUUID();
      await sendWebhook("push", pushPayload, deliveryId);
      await waitForDelivery(deliveryId);
      const run = (await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) }))[0];
      expect(run).toBeDefined();
      const configurationVersion = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, run?.configurationVersionId ?? ""),
      });
      expect(configurationVersion?.status).toBe("errored");
      expect(tarballFetches).toBe(0);
    } finally {
      process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    }
  });

  test("scopes a GitHub App delivery to its installation organization", async () => {
    await db.insert(organizations).values({ id: crossOrgId, name: `cross-org-scoped-${Date.now()}` });
    await db.insert(workspaces).values({
      id: secondWorkspaceId,
      orgId: crossOrgId,
      name: "cross-org-scoped-workspace",
      vcsRepo: { identifier: "hashicorp/terraform", branch: "main", githubAppInstallationId: installationId },
      fileTriggersEnabled: true,
      triggerPrefixes: ["src/"],
      queueAllRuns: true,
    });
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", { ...pushPayload, installation: { id: 12345 } }, deliveryId);
    await waitForDelivery(deliveryId);

    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).toHaveLength(1);
    expect(await db.query.runs.findMany({ where: eq(runs.workspaceId, secondWorkspaceId) })).toHaveLength(0);
  });

  test("an installation from another organization is not resolved", async () => {
    await db.insert(organizations).values({ id: crossOrgId, name: `cross-org-${Date.now()}` });
    await db.insert(workspaces).values({
      id: secondWorkspaceId,
      orgId: crossOrgId,
      name: "cross-org-workspace",
      vcsRepo: { identifier: "hashicorp/terraform", branch: "main", githubAppInstallationId: installationId },
      fileTriggersEnabled: true,
      triggerPrefixes: ["src/"],
      queueAllRuns: true,
    });
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", pushPayload, deliveryId);
    await waitForDelivery(deliveryId);
    const crossOrgRun = (await db.query.runs.findMany({ where: eq(runs.workspaceId, secondWorkspaceId) }))[0];
    expect(crossOrgRun).toBeDefined();
    const configurationVersion = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, crossOrgRun?.configurationVersionId ?? ""),
    });
    expect(configurationVersion?.status).toBe("errored");
    expect(configurationVersion?.archivePath).toBeNull();
  });
});
