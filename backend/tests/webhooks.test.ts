import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";
import {
  apiTokens,
  configurationVersions,
  githubAppInstallations,
  githubWebhookDeliveries,
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
const crossOrgId = "org-webhook-cross-tenant";
const userId = "usr-webhook-test";
const authToken = "webhook-test-token";
const installationId = "ghain-webhook-test";
const originalSecret = process.env["GITHUB_WEBHOOK_SECRET"];
const originalAppId = process.env["GITHUB_APP_ID"];
const originalPrivateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
const originalFetch = globalThis.fetch;
let tarballFetches = 0;

const pushPayload = {
  ref: "refs/heads/main",
  after: "1234567890abcdef1234567890abcdef12345678",
  head_commit: {
    message: "Update Terraform",
    url: "https://github.com/hashicorp/terraform/commit/1234567890abcdef1234567890abcdef12345678",
  },
  sender: { login: "octocat" },
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
      "Content-Type": "application/vnd.api+json",
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

describe("GitHub Webhooks", () => {
  beforeAll(async () => {
    process.env["GITHUB_WEBHOOK_SECRET"] = "test-secret";
    process.env["GITHUB_APP_ID"] = "12345";
    process.env["GITHUB_APP_PRIVATE_KEY"] = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "test-token" });
      if (url.includes("/tarball/")) {
        tarballFetches += 1;
        return new Response(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });

    await db.delete(users).where(eq(users.id, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(users).values({ id: userId, username: `webhook-user-${Date.now()}`, passwordHash: "unused" });
    await db.insert(organizationMemberships).values({ id: "orgmem-webhook-test", userId, orgId, role: "member" });
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
    await db.delete(githubWebhookDeliveries);
    await db.delete(workspaces).where(eq(workspaces.id, secondWorkspaceId));
    await db.delete(organizations).where(eq(organizations.id, crossOrgId));
    await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
    await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await db.update(workspaces)
      .set({ speculativeEnabled: true, queueAllRuns: true, triggerPrefixes: ["src/"] })
      .where(eq(workspaces.id, workspaceId));
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    process.env["GITHUB_WEBHOOK_SECRET"] = originalSecret;
    process.env["GITHUB_APP_ID"] = originalAppId;
    process.env["GITHUB_APP_PRIVATE_KEY"] = originalPrivateKey;
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, secondWorkspaceId));
    await db.delete(organizations).where(eq(organizations.id, crossOrgId));
    await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, installationId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("organization members can register and use a scoped installation", async () => {
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
      data: { attributes: { "vcs-repo": { githubAppInstallationId: string } } };
    };
    expect(workspaceResponse.data.attributes["vcs-repo"].githubAppInstallationId).toBe(registered.data.id);
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
    expect(runList.find((run): boolean => run.workspaceId === workspaceId && !run.planOnly)).toBeDefined();
    expect(tarballFetches).toBe(1);
  });

  test("matching pull request creates a speculative run", async () => {
    const deliveryId = crypto.randomUUID();
    expect((await sendWebhook("pull_request", pullRequestPayload(), deliveryId)).status).toBe(200);
    const runList = await waitForRuns((items): boolean => items.some((run): boolean => run.planOnly));
    await waitForDelivery(deliveryId);
    expect(runList.find((run): boolean => run.workspaceId === workspaceId && run.planOnly)).toBeDefined();
  });

  test("non-matching branch creates no run", async () => {
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", { ...pushPayload, ref: "refs/heads/release" }, deliveryId);
    await waitForDelivery(deliveryId);
    expect((await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).length).toBe(0);
  });

  test("changes outside trigger prefixes create no run", async () => {
    const deliveryId = crypto.randomUUID();
    await sendWebhook("push", { ...pushPayload, commits: [{ modified: ["docs/readme.md"] }] }, deliveryId);
    await waitForDelivery(deliveryId);
    expect((await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) })).length).toBe(0);
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

  test("missing token leaves the run and marks its configuration version errored", async () => {
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
    process.env["GITHUB_APP_PRIVATE_KEY"] = "";
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
      process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;
    }
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
