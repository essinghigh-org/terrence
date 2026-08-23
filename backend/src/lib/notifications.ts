import { createHmac } from "node:crypto";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { envEnabled } from "./env";
import { db } from "../db";
import {
  assessmentResults,
  changeRequests,
  notificationConfigurations,
  notificationConfigurationWorkspaceExclusions,
  organizations,
  organizationMemberships,
  projects,
  runs,
  configurationVersions,
  teamMemberships,
  teamWorkspaces,
  users,
  workspaces,
} from "../db/schema";
import type { DeepReadonly } from "./utils";
import { fetchResolvedExternalUrl, resolveExternalUrl } from "./url-safety";
import { decryptSecret } from "./secrets";
import { _resetSharedDeliveryState as resetSharedStateImpl, sharedBreakerRecordFailure, sharedBreakerRecordSuccess, sharedDedupRecord, sharedDedupSuppressed } from "./notification-state";
import { getSettings } from "./settings";
import { sendEmail } from "./smtp";

type NotificationConfiguration = Readonly<
  Omit<typeof notificationConfigurations.$inferSelect, "triggers">
  & { triggers: readonly string[] }
>;

async function withoutProjectExclusions(
  configurations: readonly NotificationConfiguration[],
  workspaceId: string,
): Promise<NotificationConfiguration[]> {
  const ids = configurations.filter((configuration): boolean => configuration.projectId !== null).map((configuration): string => configuration.id);
  if (ids.length === 0) return [...configurations];
  const exclusions = await db.query.notificationConfigurationWorkspaceExclusions.findMany({
    where: and(
      eq(notificationConfigurationWorkspaceExclusions.workspaceId, workspaceId),
      inArray(notificationConfigurationWorkspaceExclusions.notificationConfigurationId, ids),
    ),
    columns: { notificationConfigurationId: true },
  });
  const excluded = new Set(exclusions.map((row): string => row.notificationConfigurationId));
  return configurations.filter((configuration): boolean => !excluded.has(configuration.id));
}

export type NotificationDelivery = Readonly<{
  body: string;
  code: string;
  headers: Readonly<Record<string, readonly string[]>>;
  sentAt: string;
  successful: boolean;
  url: string;
  attempts: number;
}>;

/** Header names whose values must never be persisted with notification
 * delivery attempts (kanban 17). Response headers can carry upstream
 * credentials (Set-Cookie sessions, Authorization echoes, proxy auth),
 * internal topology (Server, X-Powered-By), and tracing ids that leak
 * infrastructure detail. Matching is lowercase. */
const REDACTED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "proxy-authenticate",
  "proxy-authorization",
  "www-authenticate",
  "cookie",
  "x-api-key",
  "server",
  "x-powered-by",
  "forwarded",
  "via",
  "traceparent",
  "tracestate",
  "x-request-id",
  "x-forwarded-for",
  "x-real-ip",
]);

function responseHeaders(headers: Readonly<Headers>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  headers.forEach((value, key): void => {
    const lower = key.toLowerCase();
    if (REDACTED_RESPONSE_HEADERS.has(lower)) {
      // Record the header's presence without its value: operators can still
      // see the endpoint set a cookie/auth challenge, but never its contents.
      result[lower] = ["[redacted]"];
      return;
    }
    result[lower] = [value];
  });
  return result;
}

/** Test seam for the redaction decision table. */
export function _redactedHeaderNamesForTests(): ReadonlySet<string> {
  return REDACTED_RESPONSE_HEADERS;
}

async function resetSharedDeliveryState(): Promise<void> {
  await resetSharedStateImpl();
}

// ---------------------------------------------------------------------------
// Per-destination circuit breaker (kanban 7.8).
//
// A broken endpoint must not generate endless retry pressure. Each
// notification configuration tracks recent consecutive failures; after
// BREAKER_FAILURE_LIMIT trips in a row the breaker "opens" and deliveries are
// skipped (returning a fast, unsuccessful sentinel) until the cooldown
// elapses. A single successful delivery resets the failure count.
// ---------------------------------------------------------------------------
const BREAKER_FAILURE_LIMIT = 3;
const BREAKER_OPEN_MS = 60_000;

type BreakerState = Readonly<{ failures: number; openedAfterSample: number | null }>;
const breakers = new Map<string, BreakerState>();

/** Only exported for tests. */
export function _breakerState(configurationId: string): Readonly<{ open: boolean; remainingMs: number; failures: number }> {
  const state = breakers.get(configurationId);
  if (state === undefined) return { open: false, remainingMs: 0, failures: 0 };
  const open = state.openedAfterSample !== null && Date.now() < state.openedAfterSample + BREAKER_OPEN_MS;
  if (open) return { open: true, remainingMs: state.openedAfterSample + BREAKER_OPEN_MS - Date.now(), failures: state.failures };
  return { open: false, remainingMs: 0, failures: state.failures };
}

function recordBreakerFailure(configurationId: string): void {
  const current = breakers.get(configurationId);
  const failures = (current?.failures ?? 0) + 1;
  const openedAfterSample = failures >= BREAKER_FAILURE_LIMIT ? Date.now() : current?.openedAfterSample ?? null;
  breakers.set(configurationId, { failures, openedAfterSample });
  // Mirror into the shared store (kanban 15): other replicas must see the
  // breaker trip without waiting for their own three failures. Fire-and-
  // forget: the local map already bounds this replica; shared convergence is
  // eventual and failures here only delay it.
  void sharedBreakerRecordFailure(configurationId).catch((): void => {
    /* shared state is best-effort; local breaker still protects this replica */
  });
}

function recordBreakerSuccess(configurationId: string): void {
  breakers.delete(configurationId);
  void sharedBreakerRecordSuccess(configurationId).catch((): void => {
    /* best-effort, same as failure mirroring */
  });
}

function breakerRefusesDelivery(configurationId: string): boolean {
  const state = breakers.get(configurationId);
  if (state === undefined) return false;
  const open = state.openedAfterSample !== null && Date.now() < state.openedAfterSample + BREAKER_OPEN_MS;
  // Once the cooldown elapses, reopen the breaker by clearing its state so the
  // next attempt re-enters the failure counter fresh.
  if (state.openedAfterSample !== null && !open) {
    breakers.delete(configurationId);
    return false;
  }
  return open;
}

// ---------------------------------------------------------------------------
// Logical-notification dedup (kanban 7.9).
//
// A run's status can be written more than once (retries, reconcile loops,
// webhook replays). These repeatedly call deliverRunNotifications with the
// same (runId, trigger, status). We keep a short in-process TTL so the SAME
// logical notification is emitted at most once per DEDUP_WINDOW_MS. A distinct
// trigger or a status change produces a fresh key and is always delivered.
// ---------------------------------------------------------------------------
const DEDUP_WINDOW_MS = 5_000;
const emittedKeys = new Map<string, number>();

/** Only exported for tests. */
export function _dedup(reset?: boolean): void {
  if (reset === true) emittedKeys.clear();
}

/** Only exported for tests: clear the replica-shared delivery state so a
 * test's breaker/dedup sequence starts from a clean slate. */
export function _resetSharedDeliveryState(): Promise<void> {
  return resetSharedDeliveryState();
}

function dedupSuppressed(scope: "run" | "assessment", key: string): boolean {
  const now = Date.now();
  const fullKey = `${scope}:${key}`;
  const prior = emittedKeys.get(fullKey);
  if (prior !== undefined && now - prior < DEDUP_WINDOW_MS) {
    return true;
  }
  // Not suppressed locally — the async wrapper (deliveryDeduplicated) consults
  // the shared store (kanban 16) so another replica's emission inside the
  // window suppresses this one too. The local map stays as the no-I/O fast
  // path.
  return false;
}

/** Record that a logical notification was emitted for a (scope, key). */
function dedupRecord(scope: "run" | "assessment", key: string): void {
  const now = Date.now();
  emittedKeys.set(`${scope}:${key}`, now);
  // Opportunistically prune stale entries so the map never grows unbounded.
  if (emittedKeys.size > 1_000) {
    for (const [mapKey, ts] of emittedKeys) {
      if (now - ts >= DEDUP_WINDOW_MS) emittedKeys.delete(mapKey);
    }
  }
}

/** Async dedup gate: local TTL map first (no I/O), then the shared store. */
export async function deliveryDeduplicated(scope: "run" | "assessment", key: string): Promise<boolean> {
  if (dedupSuppressed(scope, key)) return true;
  try {
    return await sharedDedupSuppressed(scope, key);
  } catch {
    // Shared state unavailable (DB hiccup): fail OPEN so notifications are
    // at-least-once rather than silently lost. Dedup is an optimization.
    return false;
  }
}

/** Record a logical emission in both the local TTL map and the shared store. */
export function deliveryDedupRecord(scope: "run" | "assessment", key: string): void {
  dedupRecord(scope, key);
  void sharedDedupRecord(scope, key).catch((): void => {
    /* best-effort: worst case a duplicate notification on failover */
  });
}

export function postNotification(
  configuration: NotificationConfiguration,
  payload: Readonly<Record<string, unknown>>,
): Promise<NotificationDelivery> {
  if (breakerRefusesDelivery(configuration.id)) {
    return Promise.resolve({
      body: `Destination temporarily disabled by circuit breaker (${BREAKER_OPEN_MS / 1000}s cooldown).`,
      code: "0",
      headers: {},
      sentAt: new Date().toISOString(),
      successful: false,
      url: configuration.url,
      attempts: 0,
    });
  }
  return doPostNotification(configuration, payload);
}

async function doPostNotification(
  configuration: NotificationConfiguration,
  payload: Readonly<Record<string, unknown>>,
): Promise<NotificationDelivery> {
  if (configuration.destinationType === "email") {
    return deliverEmailNotification(configuration, payload);
  }

  const render = renderPayloadForDestination(configuration, payload);
  const body = render.body;
  const headers: Record<string, string> = { "Content-Type": render.contentType };
  if (configuration.destinationType === "generic" && configuration.token !== null) {
    headers["X-TFE-Notification-Signature"] = createHmac("sha512", await decryptSecret(configuration.token))
      .update(body)
      .digest("hex");
  }

  let lastResponse: Response | undefined;
  let lastError = "";
  const allowPrivate = envEnabled(process.env.TERRENCE_ALLOW_PRIVATE_URLS);
  const destination = await resolveExternalUrl(configuration.url, allowPrivate);
  if ("error" in destination) {
    return { body: destination.error, code: "422", headers: {}, sentAt: new Date().toISOString(), successful: false, url: configuration.url, attempts: 0 };
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lastResponse = await fetchResolvedExternalUrl(destination.target, {
        method: "POST",
        headers,
        body,
        timeoutMs: 5_000,
        maxResponseBytes: 16_384,
      });
      const responseBody = await lastResponse.text();
      if (lastResponse.ok || (lastResponse.status < 500 && lastResponse.status !== 429)) {
        // Reachable endpoint: the breaker resets regardless of HTTP status
        // (a 4xx means the destination is up and responding).
        recordBreakerSuccess(configuration.id);
        return {
          body: responseBody.slice(0, 16_384),
          code: String(lastResponse.status),
          headers: responseHeaders(lastResponse.headers),
          sentAt: new Date().toISOString(),
          successful: lastResponse.ok,
          url: configuration.url,
          attempts: attempt,
        };
      }
      lastError = responseBody;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  // Exhausted retries while the endpoint was unreachable, timing out, or
  // consistently 5xx/429 — count this toward opening the circuit breaker.
  recordBreakerFailure(configuration.id);
  return {
    body: lastError.slice(0, 16_384),
    code: lastResponse === undefined ? "0" : String(lastResponse.status),
    headers: lastResponse === undefined ? {} : responseHeaders(lastResponse.headers),
    sentAt: new Date().toISOString(),
    successful: false,
    url: configuration.url,
    attempts: 3,
  };
}

/**
 * Build a human-readable subject/body for email notifications from the
 * generic payload shape shared by run and assessment notifications.
 */
function emailContent(payload: Readonly<Record<string, unknown>>): Readonly<{ subject: string; text: string }> {
  const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
  const first = (notifications[0] ?? {}) as Readonly<Record<string, unknown>>;
  const message = typeof first.message === "string" && first.message !== "" ? first.message : "Terrence notification";
  const workspace = typeof payload.workspace_name === "string" ? payload.workspace_name : undefined;
  const subject = workspace === undefined ? message : `${message} - ${workspace}`;

  const lines: string[] = [];
  if (workspace !== undefined) lines.push(`Workspace: ${workspace}`);
  if (typeof payload.organization_name === "string") lines.push(`Organization: ${payload.organization_name}`);
  if (typeof payload.run_id === "string") lines.push(`Run: ${payload.run_id}`);
  if (typeof first.trigger === "string") lines.push(`Trigger: ${first.trigger}`);
  if (typeof first.run_status === "string") lines.push(`Status: ${first.run_status}`);
  if (typeof payload.run_message === "string" && payload.run_message !== "") lines.push(`Message: ${payload.run_message}`);
  if (typeof payload.run_url === "string") lines.push(`Details: ${payload.run_url}`);
  return { subject, text: lines.join("\n") };
}

/**
 * Deliver an email notification through the organization's SMTP settings.
 * Without configured SMTP the delivery is recorded as unsuccessful, so
 * admins see the failure instead of silently losing notifications.
 */
async function deliverEmailNotification(
  configuration: NotificationConfiguration,
  payload: Readonly<Record<string, unknown>>,
): Promise<NotificationDelivery> {
  const smtp = await getSettings("smtp");
  const enabled = smtp.enabled === true;
  const host = typeof smtp.host === "string" && smtp.host !== "" ? smtp.host : null;
  const senderEmail = typeof smtp["sender-email"] === "string" && smtp["sender-email"] !== "" ? smtp["sender-email"] : null;
  const recipients = new Set(configuration.emailAddresses ?? []);
  if ((configuration.teamId !== null || configuration.projectId !== null) && (configuration.emailAllMembers === true || (configuration.emailUserIds ?? []).length > 0)) {
    const memberIds = configuration.emailAllMembers
      ? configuration.teamId !== null
        ? (await db.query.teamMemberships.findMany({ where: eq(teamMemberships.teamId, configuration.teamId), columns: { userId: true } })).map((member): string => member.userId)
        : configuration.projectId !== null
          ? (await db.query.projects.findFirst({ where: eq(projects.id, configuration.projectId), columns: { orgId: true } }).then(async (project) => project === undefined ? [] : (await db.query.organizationMemberships.findMany({ where: eq(organizationMemberships.orgId, project.orgId), columns: { userId: true } })).map((member): string => member.userId)))
          : []
      : configuration.emailUserIds ?? [];
    if (memberIds.length > 0) {
      const memberRows = await db.query.users.findMany({ where: inArray(users.id, [...new Set(memberIds)]), columns: { email: true } });
      for (const member of memberRows) if (typeof member.email === "string" && member.email !== "") recipients.add(member.email);
    }
  }
  const recipientList = [...recipients];
  const now = new Date().toISOString();

  const missing = !enabled
    ? "SMTP is disabled"
    : host === null
      ? "SMTP host is not configured"
      : senderEmail === null
        ? "SMTP sender email is not configured"
          : recipientList.length === 0
          ? "no email recipients"
          : null;
  if (missing !== null) {
    return {
      body: `Email delivery skipped: ${missing}`,
      code: "0",
      headers: {},
      sentAt: now,
      successful: false,
      url: "",
      attempts: 0,
    };
  }

  const { subject, text } = emailContent(payload);
  try {
    await sendEmail(
      {
        host: host as string,
        port: typeof smtp.port === "number" ? smtp.port : 25,
        username: typeof smtp.username === "string" && smtp.username !== "" ? smtp.username : null,
        password: typeof smtp.password === "string" ? smtp.password : null,
        senderEmail: senderEmail as string,
      },
      { to: recipientList, subject, text },
    );
    recordBreakerSuccess(configuration.id);
    return {
      body: `Sent to ${recipientList.join(", ")}`,
      code: "250",
      headers: {},
      sentAt: new Date().toISOString(),
      successful: true,
      url: "",
      attempts: 1,
    };
  } catch (error: unknown) {
    recordBreakerFailure(configuration.id);
    const message = error instanceof Error ? error.message : String(error);
    return {
      body: message.slice(0, 16_384),
      code: "0",
      headers: {},
      sentAt: new Date().toISOString(),
      successful: false,
      url: "",
      attempts: 1,
    };
  }
}

function runNotificationMessage(trigger: string, status: string): string {
  switch (trigger) {
    case "run:created": return "Run Created";
    case "run:planning": return "Run Planning";
    case "run:needs_attention": return "Run Needs Attention";
    case "run:applying": return "Run Applying";
    case "run:completed": return "Run Completed";
    case "run:errored": return `Run ${status === "canceled" ? "Canceled" : "Errored"}`;
    case "run:confirmed": return "Run Confirmed";
    default: return trigger;
  }
}

// ---------------------------------------------------------------------------
// Rich destination adapters (kanban 7.11).
//
// Generic webhook destinations receive the raw structured JSON payload. When a
// notification is configured for Slack or Microsoft Teams we instead render a
// destination-native structured payload (Slack blocks / Teams MessageCard) that
// surfaces the same high-signal fields — what happened, which run/workspace,
// who triggered it, and where to look — without the caller needing to choose a
// format. The generic wire contract is untouched (fully additive).
// ---------------------------------------------------------------------------
type DestinationRender = Readonly<{ body: string; contentType: string }>;

interface NotificationSummary {
  title: string;
  subtext: string;
  fields: ReadonlyArray<Readonly<{ label: string; value: string }>>;
  linkLabel: string;
  linkUrl: string;
  status?: string;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object" && Array.isArray(value)) return value.length === 0 ? "" : String(value.length);
  return String(value);
}

function firstUrl(payload: Readonly<Record<string, unknown>>): string {
  const candidates = [
    payload.run_url,
    payload.change_request_url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  // Assessment notifications carry the result under `details`.
  const details = payload.details as Readonly<Record<string, unknown>> | undefined;
  const newResult = details?.new_assessment_result as Readonly<Record<string, unknown>> | undefined;
  if (typeof newResult?.url === "string" && newResult.url.length > 0) return newResult.url;
  return "";
}

function summarizePayload(payload: Readonly<Record<string, unknown>>): NotificationSummary {
  const notifications = payload.notifications;
  const notification = (Array.isArray(notifications) ? notifications[0] : notifications) as
    | Readonly<Record<string, unknown>>
    | undefined;
  const message =
    typeof notification?.message === "string" && notification.message.length > 0
      ? notification.message
      : (typeof payload.message === "string" ? payload.message : "Terrence notification");

  const fields: Array<{ label: string; value: string }> = [];

  const addField = (label: string, value: unknown): void => {
    const text = stringify(value);
    if (text.length > 0) fields.push({ label, value: text });
  };

  addField("Organization", payload.organization_name);
  addField("Workspace", payload.workspace_name);
  addField("Run", payload.run_id);
  addField("Change request", payload.change_request_subject);
  addField("Triggered by", payload.run_created_by ?? payload.run_updated_by);
  addField("Status", payload.run_status ?? payload.change_request_status ?? notification?.run_status);

  const details = payload.details as Readonly<Record<string, unknown>> | undefined;
  if (details !== undefined) {
    const result = details.new_assessment_result as Readonly<Record<string, unknown>> | undefined;
    const drifted = result?.resources_drifted;
    if (typeof drifted === "number") addField("Resources drifted", drifted);
    const checksFailed = result?.checks_failed as number | undefined;
    if (typeof checksFailed === "number") addField("Failed checks", checksFailed);
  }

  const linkUrl = firstUrl(payload);
  const linkLabel = typeof payload.run_id === "string" ? "Open run" : "Open workspace";
  const status = typeof payload.run_status === "string"
    ? payload.run_status
    : (typeof payload.change_request_status === "string" ? payload.change_request_status : notification?.run_status);
  return {
    title: message,
    subtext: stringify(payload.run_message ?? payload.change_request_message),
    fields,
    linkLabel,
    linkUrl,
    ...(typeof status === "string" ? { status } : {}),
  };
}

function renderSlack(payload: Readonly<Record<string, unknown>>): string {
  const summary = summarizePayload(payload);
  const blocks: Array<Record<string, unknown>> = [{ type: "header", text: { type: "plain_text", text: summary.title.slice(0, 150) } }];
  if (summary.subtext.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: summary.subtext.slice(0, 2_900) } });
  }
  if (summary.fields.length > 0) {
    const pairs: Record<string, unknown>[] = [];
    for (const field of summary.fields) {
      pairs.push({ type: "mrkdwn", text: `*${field.label}:* ${field.value.slice(0, 1_900)}` });
    }
    blocks.push({ type: "section", fields: pairs.slice(0, 10) });
  }
  const href = summary.linkUrl.length > 0 ? summary.linkUrl : "https://terrence.local";
  blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: summary.linkLabel }, url: href }] });
  return JSON.stringify({ text: summary.title, blocks });
}

function renderTeams(payload: Readonly<Record<string, unknown>>): string {
  const summary = summarizePayload(payload);
  const facts = summary.fields.slice(0, 10).map((field) => ({ name: field.label, value: field.value }));
  const FAILED_STATUS_COLORS: ReadonlySet<string> = new Set([
    "canceled",
    "errored",
    "force_canceled",
    "discarded",
  ]);
  const card: Record<string, unknown> = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    // Failure states get the alert accent; everything else (including a run
    // with no status yet) keeps the default blue.
    themeColor: summary.status !== undefined && FAILED_STATUS_COLORS.has(summary.status) ? "c0392b" : "2b579a",
    summary: summary.title,
    title: summary.title,
  };
  if (summary.subtext.length > 0) card.text = summary.subtext;
  if (facts.length > 0) card.sections = [{ facts }];
  if (summary.linkUrl.length > 0) {
    card.potentialAction = [{ "@type": "OpenUri", name: summary.linkLabel, targets: [{ os: "default", uri: summary.linkUrl }] }];
  }
  return JSON.stringify(card);
}

export function renderPayloadForDestination(
  configuration: NotificationConfiguration,
  payload: Readonly<Record<string, unknown>>,
): DestinationRender {
  if (configuration.destinationType === "slack") {
    return { body: renderSlack(payload), contentType: "application/json" };
  }
  if (configuration.destinationType === "microsoft-teams") {
    return { body: renderTeams(payload), contentType: "application/json" };
  }
  return { body: JSON.stringify(payload), contentType: "application/json" };
}

// ---------------------------------------------------------------------------
// Destination ownership verification (kanban 7.7).
//
// Verifying that a webhook URL actually belongs to the operator prevents both
// mis-configuration and sending orchestration payloads to a URL the operator
// does not control. The flow is a one-time challenge/echo handshake:
//
//   1. The caller requests verification; we POST a payload containing a fresh
//      `ownership_challenge` token to the destination.
//   2. The destination proves ownership by echoing that exact token — either
//      in its HTTP response body or in the `X-Terrence-Ownership-Challenge`
//      response header.
//   3. If the echo matches, the configuration is recorded as ownership-verified
//      (in-process, with a TTL). Verification is OPTIONAL: enabling notifications
//      never depends on it, so existing deployments are unaffected.
//
// The verification outcome is surfaced via a dedicated endpoint and recorded
// in-process purely to let operators confirm, before enablement, that the
// endpoint is genuinely theirs.
// ---------------------------------------------------------------------------
const OWNERSHIP_VERIFIED_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const ownershipVerified = new Map<string, number>();

/** Only exported for tests. */
export function _ownershipVerified(configurationId: string): boolean {
  const ts = ownershipVerified.get(configurationId);
  if (ts === undefined) return false;
  if (Date.now() - ts < OWNERSHIP_VERIFIED_TTL_MS) return true;
  ownershipVerified.delete(configurationId);
  return false;
}

export function recordOwnershipVerified(configurationId: string): void {
  ownershipVerified.set(configurationId, Date.now());
}

export type OwnershipVerification = Readonly<{
  successful: boolean;
  echoed: string | null;
  bodyLacksEcho: boolean;
  headerLacksEcho: boolean;
}>;

/**
 * POST a one-time `ownership_challenge` to the destination and verify the
 * destination echoes it back (response body or header). Returns a structured
 * result with the echo outcome so the caller can surface a clear error.
 */
export async function verifyDestinationOwnership(
  configuration: NotificationConfiguration,
): Promise<OwnershipVerification> {
  const challenge = crypto.randomUUID();
  const payload: Record<string, unknown> = {
    payload_version: 1,
    notification_configuration_id: configuration.id,
    ownership_challenge: challenge,
    ownership_verification: true,
  };

  const allowPrivate = envEnabled(process.env.TERRENCE_ALLOW_PRIVATE_URLS);
  const destination = await resolveExternalUrl(configuration.url, allowPrivate);
  if ("error" in destination) {
    return { successful: false, echoed: null, bodyLacksEcho: true, headerLacksEcho: true };
  }

  let response: Response;
  try {
    response = await fetchResolvedExternalUrl(destination.target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 5_000,
      maxResponseBytes: 4_096,
    });
  } catch {
    return { successful: false, echoed: null, bodyLacksEcho: true, headerLacksEcho: true };
  }

  // Reading the response body is bounded so a malicious/hostile endpoint cannot
  // force us to buffer an unbounded payload. An explicit `X-Terrence-Ownership-Challenge`
  // response header is the verification condition; body reflection alone is a
  // weaker proof (a generic echo server echoes anything, including our token)
  // and is not sufficient on its own.
  const boundedBody = await response.arrayBuffer().then(
    (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer).slice(0, 4096),
  ).catch(() => "");
  const headerEcho = response.headers.get("x-terrence-ownership-challenge") ?? "";
  const bodyLacksEcho = !boundedBody.includes(challenge);
  const headerLacksEcho = headerEcho !== challenge;

  const successful = !headerLacksEcho;
  if (successful) recordOwnershipVerified(configuration.id);
  return { successful, echoed: boundedBody.slice(0, 256), bodyLacksEcho, headerLacksEcho };
}

export async function deliverRunNotifications(
  runId: string,
  trigger: string,
  statusOverride?: string,
): Promise<NotificationDelivery[]> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (run === undefined) return [];
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
  if (workspace === undefined) return [];

  // the reference format parity: notifications are not delivered for local-execution runs.
  if (workspace.executionMode === "local") {
    return [];
  }

  // the reference format parity: notifications are not delivered for speculative runs
  // (e.g. runs queued from VCS pull-request comments).
  if (run.configurationVersionId !== null) {
    const configurationVersion = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, run.configurationVersionId),
      columns: { speculative: true },
    });
    if (configurationVersion?.speculative === true) {
      return [];
    }
  }

  const [organization, creator, configurations] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) }),
    run.createdBy === null
      ? Promise.resolve(undefined)
      : db.query.users.findFirst({ where: eq(users.id, run.createdBy) }),
    db.query.notificationConfigurations.findMany({
      where: workspace.projectId === null
        ? eq(notificationConfigurations.workspaceId, workspace.id)
        : or(
            eq(notificationConfigurations.workspaceId, workspace.id),
            eq(notificationConfigurations.projectId, workspace.projectId),
          ),
    }),
  ]);

  const matching = (await withoutProjectExclusions(configurations, workspace.id)).filter((configuration: NotificationConfiguration): boolean =>
    configuration.enabled === true && configuration.triggers.includes(trigger));
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  const runUrl = new URL(
    `/app/${encodeURIComponent(organization?.name ?? workspace.orgId)}/workspaces/${encodeURIComponent(workspace.name)}/runs/${encodeURIComponent(run.id)}`,
    baseUrl,
  ).toString();
  const updatedAt = new Date().toISOString();
  const runStatus = statusOverride ?? run.status;

  const dedupKey = `${run.id}:${trigger}:${runStatus}`;
  if (await deliveryDeduplicated("run", dedupKey)) {
    return [];
  }
  // Only record the logical emission when there is at least one matching
  // destination and a delivery will actually be attempted, so a config-less
  // or breaker-closed run does not consume the dedup window.
  if (matching.length > 0) {
    dedupRecord("run", dedupKey);
    deliveryDedupRecord("run", dedupKey);
  }

  return Promise.all(matching.map(async (configuration: NotificationConfiguration): Promise<NotificationDelivery> =>
    postNotification(configuration, {
      payload_version: 1,
      notification_configuration_id: configuration.id,
      run_url: runUrl,
      run_id: run.id,
      run_message: run.message ?? "",
      run_created_at: new Date(run.createdAt).toISOString(),
      run_created_by: creator?.username ?? null,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      organization_name: organization?.name ?? workspace.orgId,
      notifications: [{
        message: runNotificationMessage(trigger, runStatus),
        trigger,
        run_status: runStatus,
        run_updated_at: updatedAt,
        run_updated_by: creator?.username ?? null,
      }],
    })));
}

export function queueRunNotification(runId: string, trigger: string, status?: string): void {
  void deliverRunNotifications(runId, trigger, status).catch((error: unknown): void => {
    console.error(`[terrence] Failed to deliver ${trigger} notification for run ${runId}:`, error);
  });
}


type AssessmentResult = DeepReadonly<typeof assessmentResults.$inferSelect>;

function assessmentNotificationResult(result: AssessmentResult, baseUrl: string): Record<string, unknown> {
  return {
    id: result.id,
    url: new URL(`/api/v2/assessment-results/${encodeURIComponent(result.id)}`, baseUrl).toString(),
    succeeded: result.succeeded === true,
    drifted: result.drifted === true,
    all_checks_succeeded: result.allChecksSucceeded === true,
    resources_drifted: result.resourcesDrifted,
    resources_undrifted: result.resourcesUndrifted,
    checks_passed: result.checksPassed,
    checks_failed: result.checksFailed,
    checks_errored: result.checksErrored,
    checks_unknown: result.checksUnknown,
    created_at: new Date(result.createdAt).toISOString(),
  };
}

export async function deliverAssessmentNotifications(
  assessmentResultId: string,
  trigger: "assessment:drifted" | "assessment:check_failure" | "assessment:failed",
): Promise<NotificationDelivery[]> {
  const result = await db.query.assessmentResults.findFirst({
    where: eq(assessmentResults.id, assessmentResultId),
  });
  if (result === undefined) return [];
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, result.workspaceId) });
  if (workspace === undefined) return [];

  if (await deliveryDeduplicated("assessment", `${assessmentResultId}:${trigger}`)) {
    return [];
  }

  const [organization, prior, configurations] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) }),
    db.query.assessmentResults.findFirst({
      where: and(
        eq(assessmentResults.workspaceId, workspace.id),
        lt(assessmentResults.createdAt, result.createdAt),
      ),
      orderBy: [desc(assessmentResults.createdAt)],
    }),
    db.query.notificationConfigurations.findMany({
      where: workspace.projectId === null
        ? eq(notificationConfigurations.workspaceId, workspace.id)
        : or(
            eq(notificationConfigurations.workspaceId, workspace.id),
            eq(notificationConfigurations.projectId, workspace.projectId),
          ),
    }),
  ]);

  const matching = (await withoutProjectExclusions(configurations, workspace.id)).filter((configuration: NotificationConfiguration): boolean =>
    configuration.enabled === true && configuration.triggers.includes(trigger));
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  const messages = {
    "assessment:drifted": "Drift Detected",
    "assessment:check_failure": "Continuous Validation Check Failed",
    "assessment:failed": "Health Assessment Errored",
  } as const;

  if (matching.length > 0) {
    dedupRecord("assessment", `${assessmentResultId}:${trigger}`);
    deliveryDedupRecord("assessment", `${assessmentResultId}:${trigger}`);
  }

  return Promise.all(matching.map(async (configuration: NotificationConfiguration): Promise<NotificationDelivery> =>
    postNotification(configuration, {
      payload_version: "2",
      notification_configuration_id: configuration.id,
      notification_configuration_url: new URL(
        `/api/v2/notification-configurations/${encodeURIComponent(configuration.id)}`,
        baseUrl,
      ).toString(),
      trigger_scope: "assessment",
      trigger,
      message: messages[trigger],
      details: {
        new_assessment_result: assessmentNotificationResult(result, baseUrl),
        prior_assessment_result: prior === undefined ? null : assessmentNotificationResult(prior, baseUrl),
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        organization_name: organization?.name ?? workspace.orgId,
      },
    })));
}

export function queueAssessmentNotification(
  assessmentResultId: string,
  trigger: "assessment:drifted" | "assessment:check_failure" | "assessment:failed",
): void {
  void deliverAssessmentNotifications(assessmentResultId, trigger).catch((error: unknown): void => {
    console.error(`[terrence] Failed to deliver ${trigger} notification for assessment ${assessmentResultId}:`, error);
  });
}

async function deliverChangeRequestNotifications(
  changeRequestId: string,
): Promise<NotificationDelivery[]> {
  const changeRequest = await db.query.changeRequests.findFirst({
    where: eq(changeRequests.id, changeRequestId),
  });
  if (changeRequest === undefined) return [];
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, changeRequest.workspaceId),
  });
  if (workspace === undefined) return [];

  const [organization, configurations] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) }),
    db.query.notificationConfigurations.findMany({
      where: or(
        eq(notificationConfigurations.workspaceId, workspace.id),
        eq(notificationConfigurations.projectId, workspace.projectId ?? ""),
      ),
    }),
  ]);

  // Also find team-scoped notification configurations for teams associated with this workspace
  const workspaceTeams = await db.query.teamWorkspaces.findMany({
    where: eq(teamWorkspaces.workspaceId, workspace.id),
  });
  const teamIds: string[] = workspaceTeams.map((tw: Readonly<{ teamId: string }>): string => tw.teamId);
  const teamConfigurations = teamIds.length > 0
    ? await db.query.notificationConfigurations.findMany({
        where: or(...teamIds.map((id: string) => eq(notificationConfigurations.teamId, id))),
      })
    : [];

  const allConfigurations = await withoutProjectExclusions([...configurations, ...teamConfigurations], workspace.id);

  const matching = allConfigurations.filter((configuration: NotificationConfiguration): boolean =>
    configuration.enabled === true && configuration.triggers.includes("team:change_request"));
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  const changeRequestUrl = new URL(
    `/app/${encodeURIComponent(organization?.name ?? workspace.orgId)}/change-requests/${encodeURIComponent(changeRequest.id)}`,
    baseUrl,
  ).toString();

  return Promise.all(matching.map(async (configuration: NotificationConfiguration): Promise<NotificationDelivery> =>
    postNotification(configuration, {
      payload_version: 1,
      notification_configuration_id: configuration.id,
      change_request_id: changeRequest.id,
      change_request_subject: changeRequest.subject,
      change_request_message: changeRequest.message,
      change_request_status: changeRequest.status,
      change_request_url: changeRequestUrl,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      organization_name: organization?.name ?? workspace.orgId,
      notifications: [{
        message: "Change Request Created",
        trigger: "team:change_request",
        change_request_subject: changeRequest.subject,
        change_request_status: changeRequest.status,
      }],
    })));
}

export function queueChangeRequestNotification(changeRequestId: string): void {
  void deliverChangeRequestNotifications(changeRequestId).catch((error: unknown): void => {
    console.error(`[terrence] Failed to deliver team:change_request notification for change request ${changeRequestId}:`, error);
  });
}
