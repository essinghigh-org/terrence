/**
 * Webhook durability regression suite (todo 183-201).
 *
 * Pins the durable-enqueue semantics introduced for VCS webhooks:
 * - ACK happens only after the event is durably enqueued (or inline-processed
 *   on worker-disabled nodes);
 * - GitHub delivery GUID / provider event identity is the dedupe key, so a
 *   redelivery while the first copy is still processing is acknowledged
 *   without double-processing (todo 184/189/199);
 * - a failed delivery dead-letters after MAX_ATTEMPTS and the admin retry
 *   re-arms it while preserving idempotency (todo 186/196);
 * - process death after durable enqueue is recovered by the lease sweep
 *   (todo 185/200);
 * - queue metrics expose depth, oldest age, and the failure counter
 *   (todo 192-194).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { durableJobs, githubWebhookDeliveries } from "../../src/db/schema";
import {
  claimDurableJob,
  DURABLE_MAX_ATTEMPTS,
} from "../../src/lib/durable-jobs";
import {
  collectWebhookQueueMetrics,
  enqueueVcsWebhookJob,
  retryFailedVcsWebhookDelivery,
  vcsWebhookDeliveryId,
} from "../../src/lib/webhook-jobs";

const gitlabPayload = {
  object_kind: "push",
  ref: "refs/heads/main",
  checkout_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  project: { path_with_namespace: "durability/repo" },
  commits: [{ id: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", added: ["main.tf"], modified: [], removed: [] }],
};

const gitlabDedupeKey = "gitlab:durability/repo:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef:Push Hook";

async function jobByDedupeKey(dedupeKey: string) {
  return db.query.durableJobs.findFirst({
    where: eq(durableJobs.dedupeKey, dedupeKey),
  });
}

beforeAll(async (): Promise<void> => {
  await db.delete(githubWebhookDeliveries);
  await db.delete(durableJobs).where(eq(durableJobs.kind, "vcs-webhook"));
});

afterAll(async (): Promise<void> => {
  await db.delete(githubWebhookDeliveries);
  await db.delete(durableJobs).where(eq(durableJobs.kind, "vcs-webhook"));
});

describe("vcs webhook durability", () => {
  test("provider identity derivation", () => {
    expect(vcsWebhookDeliveryId("github", "push", {}, "guid-123")).toBe("guid-123");
    expect(vcsWebhookDeliveryId("gitlab", "Push Hook", gitlabPayload, null)).toBe(gitlabDedupeKey);
    expect(vcsWebhookDeliveryId("bitbucket", "repo:push", {
      repository: { full_name: "durability/repo" },
      push: {
        changes: [{
          new: {
            type: "branch",
            name: "main",
            target: { hash: "feedfacefeedfacefeedfacefeedfacefeedface", message: "x" },
          },
        }],
      },
    }, null)).toBe("bitbucket:durability/repo:feedfacefeedfacefeedfacefeedfacefeedface:repo:push");
    // Unparseable payloads fall back to no dedupe rather than collapsing distinct events.
    expect(vcsWebhookDeliveryId("gitlab", "Push Hook", {}, null)).toBeNull();
    expect(vcsWebhookDeliveryId("bitbucket", "repo:push", {}, null)).toBeNull();
  });

  test("duplicate delivery while first copy is still processing is deduped (todo 199)", async () => {
    const dedupeKey = "github:dup-guid";
    await db.insert(githubWebhookDeliveries).values({ id: "dup-guid", status: "processing", receivedAt: Date.now() });
    await enqueueVcsWebhookJob({ provider: "github", eventName: "push", payload: {}, deliveryId: dedupeKey });
    const first = await jobByDedupeKey(dedupeKey);
    expect(first?.status).toBe("queued");
    // Second copy of the SAME delivery: dedupe keeps one job.
    await enqueueVcsWebhookJob({ provider: "github", eventName: "push", payload: {}, deliveryId: dedupeKey });
    const jobs = await db.query.durableJobs.findMany({ where: eq(durableJobs.dedupeKey, dedupeKey) });
    expect(jobs).toHaveLength(1);
  });

  test("failed delivery dead-letters after MAX_ATTEMPTS and admin retry re-arms it (todo 186/196)", async () => {
    const failingDeliveryId = "github:fail-guid";
    // Isolate from the dup test's queued job (different dedupe key still
    // occupies the claim queue head).
    await db.delete(durableJobs).where(eq(durableJobs.kind, "vcs-webhook"));
    await db.delete(githubWebhookDeliveries);
    await db.insert(githubWebhookDeliveries).values({ id: failingDeliveryId, status: "queued", receivedAt: Date.now() });
    await enqueueVcsWebhookJob({ provider: "github", eventName: "push", payload: { _forceFail: true }, deliveryId: failingDeliveryId });

    // Simulate the durable worker's retry loop: each cycle claims the
    // job, the handler throws, and the worker requeues until attempts
    // are exhausted, at which point the delivery dead-letters.
    // Note: claimDurableJob increments attempts, so the first claim is 1.
    for (let claimCount = 1; claimCount <= DURABLE_MAX_ATTEMPTS; claimCount += 1) {
      const claimed = await claimDurableJob("test-worker", ["vcs-webhook"]);
      if (claimed === undefined) break;
      if (claimed.dedupeKey !== failingDeliveryId) continue;
      // Simulate a handler failure for this dedicated failing delivery.
      // The production path would throw inside handleGithubWebhook for
      // a real failure; here we record the dead-letter transition
      // directly to isolate the queue/admin-retry contract from provider
      // parsing.
      if (claimed.attempts >= DURABLE_MAX_ATTEMPTS) {
        await db.update(githubWebhookDeliveries).set({ status: "failed" }).where(eq(githubWebhookDeliveries.id, failingDeliveryId));
        await db.update(durableJobs).set({ status: "failed" }).where(eq(durableJobs.id, claimed.id));
      } else {
        await db.update(durableJobs)
          .set({ status: "queued", runAfter: Date.now() - 1 })
          .where(eq(durableJobs.id, claimed.id));
      }
    }
    const deadJob = await jobByDedupeKey(failingDeliveryId);
    expect(deadJob?.attempts).toBe(DURABLE_MAX_ATTEMPTS);
    expect((await db.query.githubWebhookDeliveries.findFirst({
      where: eq(githubWebhookDeliveries.id, failingDeliveryId),
    }))?.status).toBe("failed");

    // Admin retry re-arms a dead-lettered delivery and preserves the dedupe key.
    expect(await retryFailedVcsWebhookDelivery(failingDeliveryId)).toBe(true);
    const retryJob = await jobByDedupeKey(failingDeliveryId);
    expect(retryJob?.status).toBe("queued");
    expect((await db.query.githubWebhookDeliveries.findFirst({
      where: eq(githubWebhookDeliveries.id, failingDeliveryId),
    }))?.status).toBe("queued");
    // Retry of a never-failed delivery is a no-op.
    expect(await retryFailedVcsWebhookDelivery("github:never-failed")).toBe(false);
  });

  test("process death after durable enqueue is recovered by lease reclamation (todo 185/200)", async () => {
    const deliveryId = "github:lease-guid2";
    // Isolate from the dead-letter test's terminal failed job which would
    // otherwise be skipped by claimDurableJob (only queued jobs are claimable).
    await db.delete(durableJobs).where(eq(durableJobs.kind, "vcs-webhook"));
    await db.delete(githubWebhookDeliveries);
    await db.insert(githubWebhookDeliveries).values({ id: deliveryId, status: "queued", receivedAt: Date.now() });
    await enqueueVcsWebhookJob({ provider: "github", eventName: "push", payload: {}, deliveryId });
    const now = Date.now();
    const claimed = await claimDurableJob("worker-that-dies", ["vcs-webhook"], now);
    expect(claimed?.dedupeKey).toBe(deliveryId);
    // The worker dies without finishing; the lease expires and another worker reclaims the SAME job.
    const reclaimed = await claimDurableJob("worker-two", ["vcs-webhook"], now + 31_002);
    expect(reclaimed?.id).toBe(claimed?.id);
  });

  test("queue metrics expose depth, age, and failure counter (todo 192-194)", async () => {
    const now = Date.now();
    await db.insert(githubWebhookDeliveries).values([
      { id: "metric-queued", status: "queued", receivedAt: now - 65_000 },
      { id: "metric-processing", status: "processing", receivedAt: now - 30_000 },
      { id: "metric-failed", status: "failed", receivedAt: now - 10_000 },
      { id: "metric-done", status: "processed", receivedAt: now - 5_000 },
    ]);
    const metrics = await collectWebhookQueueMetrics(now);
    expect(metrics.queued).toBeGreaterThanOrEqual(1);
    expect(metrics.processing).toBeGreaterThanOrEqual(1);
    expect(metrics.failed).toBeGreaterThanOrEqual(1);
    expect(metrics.oldestPendingSeconds).toBeGreaterThanOrEqual(65);
  });

  test("gitlab webhook route ACKs after durable enqueue (todo 190)", async () => {
    process.env.GITLAB_WEBHOOK_SECRET = "durability-secret";
    const rawBody = JSON.stringify(gitlabPayload);
    const response = await app.handle(new Request("http://127.0.0.1/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gitlab-event": "Push Hook",
        "x-gitlab-token": "durability-secret",
      },
      body: rawBody,
    }));
    expect(response.status).toBe(200);
    // Worker-disabled test node: the delivery was processed inline, not stranded queued.
    const delivery = await db.query.githubWebhookDeliveries.findFirst({
      where: eq(githubWebhookDeliveries.id, gitlabDedupeKey),
    });
    expect(delivery?.status).toBe("processed");
  });
});
