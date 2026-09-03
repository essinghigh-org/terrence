/**
 * Durable VCS webhook processing (todo 183-190).
 *
 * Webhook deliveries used to be handled fire-and-forget (`void handler(...)`)
 * after the HTTP acknowledgement: a process death between ACK and completion
 * silently dropped the event, and a stuck row was never retried. Every
 * provider delivery now enters the durable job queue BEFORE the route ACKs,
 * keyed by a provider-specific delivery identity so redeliveries dedupe:
 *
 * - github:    `github:<x-github-delivery>`
 * - gitlab:    provider UUID, or `gitlab:<repo>:<event>:<ref>:<before>:<after>`
 * - bitbucket: provider UUID, or `bitbucket:<repo>:<event>:<all changes>`
 *
 * Recovery and dead-lettering reuse the durable job machinery: an expired
 * lease (process death mid-run) is reclaimed by another worker, and a job
 * that exhausts MAX_ATTEMPTS lands in the terminal `failed` state, mirrored
 * onto the delivery row for the admin retry surface.
 */
import { and, count, eq, inArray, min } from "drizzle-orm";
import { db } from "../db";
import { durableJobs, githubWebhookDeliveries } from "../db/schema";
import { DURABLE_MAX_ATTEMPTS, enqueueDurableJob, type DurableJob } from "./durable-jobs";
import { handleBitbucketWebhook, handleGithubWebhook, handleGitlabWebhook } from "./webhooks";
import { log } from "./log";
import { recordFailure } from "./process-metrics";

export type VcsWebhookProvider = "github" | "gitlab" | "bitbucket";

const VCS_WEBHOOK_KIND = "vcs-webhook" as const;

export type VcsWebhookJobPayload = Readonly<{
  provider: VcsWebhookProvider;
  eventName: string;
  payload: Record<string, unknown>;
  /** Delivery-row id when the provider/request carried a usable identity. */
  deliveryId: string | null;
}>;

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function encodedEventIdentity(parts: readonly string[]): string {
  return parts.map(encodeURIComponent).join(":");
}

function gitlabRef(payload: Readonly<Record<string, unknown>>): string | undefined {
  const attributes = objectValue(payload["object_attributes"]);
  return nonEmptyString(payload["ref"])
    ?? nonEmptyString(attributes?.["source_branch"])
    ?? nonEmptyString(attributes?.["target_branch"]);
}

function gitlabEventIdentity(eventName: string, payload: Readonly<Record<string, unknown>>): string | null {
  const repo = nonEmptyString(objectValue(payload["project"])?.["path_with_namespace"]);
  const ref = gitlabRef(payload);
  const before = nonEmptyString(payload["before"]);
  const after = nonEmptyString(payload["checkout_sha"]) ?? nonEmptyString(payload["after"]);
  return repo !== undefined && ref !== undefined && after !== undefined
    ? encodedEventIdentity(["gitlab", repo, eventName, ref, before ?? "", after])
    : null;
}

function bitbucketChangeIdentity(value: unknown): string | undefined {
  const change = objectValue(value);
  const next = objectValue(change?.["new"]);
  const previous = objectValue(change?.["old"]);
  const reference = next ?? previous;
  const type = nonEmptyString(reference?.["type"]);
  const name = nonEmptyString(reference?.["name"]);
  const nextTarget = objectValue(next?.["target"]);
  const previousTarget = objectValue(previous?.["target"]);
  const before = nonEmptyString(previousTarget?.["hash"]);
  const after = nonEmptyString(nextTarget?.["hash"]);
  if (type === undefined || name === undefined || (before === undefined && after === undefined)) return undefined;
  return encodedEventIdentity([type, name, before ?? "", after ?? ""]);
}

function bitbucketEventIdentity(eventName: string, payload: Readonly<Record<string, unknown>>): string | null {
  const repo = nonEmptyString(objectValue(payload["repository"])?.["full_name"]);
  const changes = objectValue(payload["push"])?.["changes"];
  if (repo === undefined || !Array.isArray(changes) || changes.length === 0) return null;
  const changeIdentities: string[] = [];
  for (const change of changes) {
    const identity = bitbucketChangeIdentity(change);
    if (identity === undefined) return null;
    changeIdentities.push(identity);
  }
  changeIdentities.sort();
  return encodedEventIdentity(["bitbucket", repo, eventName, ...changeIdentities]);
}

function stableEventIdentity(provider: VcsWebhookProvider, eventName: string, payload: Readonly<Record<string, unknown>>): string | null {
  // Light extraction mirroring the provider parsers. Ref and before/after
  // identity distinguish legitimate same-SHA ref updates; malformed shapes
  // fall back to no dedupe rather than collapsing unrelated deliveries.
  if (provider === "gitlab") return gitlabEventIdentity(eventName, payload);
  if (provider === "bitbucket") return bitbucketEventIdentity(eventName, payload);
  return null;
}

/**
 * Derive the delivery identity for an inbound webhook. GitHub uses its
 * delivery GUID; GitLab/Bitbucket prefer a provider delivery UUID and fall
 * back to a stable repo/ref/change identity so redeliveries dedupe without
 * collapsing distinct ref updates.
 */
export function vcsWebhookDeliveryId(
  provider: VcsWebhookProvider,
  eventName: string,
  payload: Readonly<Record<string, unknown>>,
  headerDeliveryId: string | null,
): string | null {
  const header = nonEmptyString(headerDeliveryId);
  if (header !== undefined) return provider === "github" ? header : encodedEventIdentity([provider, header]);
  return stableEventIdentity(provider, eventName, payload);
}

/** Enqueue one delivery onto the durable queue; resolves after the DB insert. */
export async function enqueueVcsWebhookJob(input: Readonly<{
  provider: VcsWebhookProvider;
  eventName: string;
  payload: Record<string, unknown>;
  deliveryId: string | null;
  /** Re-arm a terminal/running job (admin retry or failed-delivery redelivery). */
  rescheduleRunning?: boolean;
}>): Promise<void> {
  const body: VcsWebhookJobPayload = {
    provider: input.provider,
    eventName: input.eventName,
    payload: input.payload,
    deliveryId: input.deliveryId,
  };
  await enqueueDurableJob(
    VCS_WEBHOOK_KIND,
    body,
    input.deliveryId !== null
      ? { dedupeKey: input.deliveryId, rescheduleRunning: input.rescheduleRunning === true }
      : {},
  );
}

async function setDeliveryStatus(deliveryId: string, status: string, extra: Readonly<{ processedAt?: number }> = {}): Promise<void> {
  await db.update(githubWebhookDeliveries)
    .set({ status, ...(extra.processedAt !== undefined ? { processedAt: extra.processedAt } : {}) })
    .where(eq(githubWebhookDeliveries.id, deliveryId));
}

async function dispatch(provider: VcsWebhookProvider, eventName: string, payload: Record<string, unknown>): Promise<void> {
  if (provider === "github") {
    await handleGithubWebhook(eventName, payload);
    return;
  }
  const handler = provider === "gitlab" ? handleGitlabWebhook : handleBitbucketWebhook;
  const matched = await handler(eventName, payload);
  // An unmatched provider event (wrong repo shape, irrelevant event) is not a
  // failure; false simply means nothing matched the configured workspaces.
  if (!matched) log.debug("VCS webhook matched no workspace", { provider, event: eventName });
}

/**
 * Run one delivery synchronously. Used by the durable worker AND by routes on
 * worker-disabled nodes (tests, benchmarks, API-only processes) so deliveries
 * never strand in `queued`.
 */
export async function processVcsWebhookPayload(body: VcsWebhookJobPayload, attempts = 1): Promise<void> {
  const provider = body.provider;
  const eventName = body.eventName;
  const deliveryId = body.deliveryId;
  const payload = body.payload;
  try {
    if (deliveryId !== null) await setDeliveryStatus(deliveryId, "processing");
    await dispatch(provider, eventName, payload);
    if (deliveryId !== null) await setDeliveryStatus(deliveryId, "processed", { processedAt: Date.now() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("VCS webhook delivery failed", { provider, event: eventName, deliveryId, attempts, error: message });
    recordFailure("webhookDeliveries");
    if (deliveryId !== null) {
      // Dead-letter only once the durable queue has exhausted its attempts;
      // earlier failures stay claimable for the next retry pass.
      if (attempts >= DURABLE_MAX_ATTEMPTS) await setDeliveryStatus(deliveryId, "failed");
    }
    throw error;
  }
}

/** Durable-job handler registered in worker.ts. */
export async function handleVcsWebhookJob(job: DurableJob): Promise<void> {
  const body = job.payload as unknown as VcsWebhookJobPayload;
  if (body === null || typeof body !== "object" || typeof body.provider !== "string") {
    throw new Error(`Malformed vcs-webhook job payload on ${job.id}`);
  }
  await processVcsWebhookPayload(body, job.attempts);
}

export type WebhookQueueMetrics = Readonly<{
  queued: number;
  processing: number;
  failed: number;
  /** Age in seconds of the oldest delivery not yet processed; 0 when empty. */
  oldestPendingSeconds: number;
}>;

/** Queue depth / oldest-age / dead-letter gauges for /metrics (todo 192-194). */
export async function collectWebhookQueueMetrics(now = Date.now()): Promise<WebhookQueueMetrics> {
  const [byStatus, oldestRows] = await Promise.all([
    db.select({ status: githubWebhookDeliveries.status, value: count() })
      .from(githubWebhookDeliveries)
      .groupBy(githubWebhookDeliveries.status),
    db.select({ oldest: min(githubWebhookDeliveries.receivedAt) })
      .from(githubWebhookDeliveries)
      .where(inArray(githubWebhookDeliveries.status, ["queued", "processing"])),
  ]);
  const counts = new Map(byStatus.map((row): [string, number] => [row.status, row.value]));
  const oldest = oldestRows[0]?.oldest ?? null;
  return {
    queued: counts.get("queued") ?? 0,
    processing: counts.get("processing") ?? 0,
    failed: counts.get("failed") ?? 0,
    oldestPendingSeconds: oldest === null ? 0 : Math.max(0, Math.round((now - oldest) / 1000)),
  };
}

/** Re-arm a dead-lettered delivery; preserves idempotency via the same key. */
export async function retryFailedVcsWebhookDelivery(deliveryId: string): Promise<boolean> {
  const delivery = await db.query.githubWebhookDeliveries.findFirst({ where: eq(githubWebhookDeliveries.id, deliveryId) });
  if (delivery === undefined || delivery.status !== "failed") return false;
  const existing = await db.query.durableJobs.findFirst({
    where: and(
      eq(durableJobs.kind, VCS_WEBHOOK_KIND),
      eq(durableJobs.dedupeKey, deliveryId),
    ),
  });
  if (existing === undefined) return false;
  await setDeliveryStatus(deliveryId, "queued");
  await enqueueVcsWebhookJob({
    provider: existing.payload["provider"] as VcsWebhookProvider,
    eventName: existing.payload["eventName"] as string,
    payload: existing.payload["payload"] as Record<string, unknown>,
    deliveryId,
    rescheduleRunning: true,
  });
  return true;
}
