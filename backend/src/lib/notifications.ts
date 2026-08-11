import { createHmac } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../db";
import {
  assessmentResults,
  changeRequests,
  notificationConfigurations,
  organizations,
  runs,
  teamWorkspaces,
  users,
  workspaces,
} from "../db/schema";
import { validateExternalUrl , type DeepReadonly } from "./utils";

type NotificationConfiguration = Readonly<
  Omit<typeof notificationConfigurations.$inferSelect, "triggers">
  & { triggers: readonly string[] }
>;

export type NotificationDelivery = Readonly<{
  body: string;
  code: string;
  headers: Readonly<Record<string, readonly string[]>>;
  sentAt: string;
  successful: boolean;
  url: string;
  attempts: number;
}>;

function responseHeaders(headers: Readonly<Headers>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  headers.forEach((value, key): void => {
    result[key.toLowerCase()] = [value];
  });
  return result;
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
}

function recordBreakerSuccess(configurationId: string): void {
  breakers.delete(configurationId);
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

function dedupAlreadyDelivered(scope: "run" | "assessment", key: string): boolean {
  const now = Date.now();
  const fullKey = `${scope}:${key}`;
  const prior = emittedKeys.get(fullKey);
  if (prior !== undefined && now - prior < DEDUP_WINDOW_MS) {
    return true;
  }
  // Prune stale entries opportunistically so the map does not grow unbounded.
  if (emittedKeys.size > 1_000) {
    for (const [mapKey, ts] of emittedKeys) {
      if (now - ts >= DEDUP_WINDOW_MS) emittedKeys.delete(mapKey);
    }
  }
  emittedKeys.set(fullKey, now);
  return false;
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
  const render = renderPayloadForDestination(configuration, payload);
  const body = render.body;
  const headers: Record<string, string> = { "Content-Type": render.contentType };
  if (configuration.destinationType === "generic" && configuration.token !== null) {
    headers["X-TFE-Notification-Signature"] = createHmac("sha512", configuration.token)
      .update(body)
      .digest("hex");
  }

  let lastResponse: Response | undefined;
  let lastError = "";
  const allowPrivate = process.env.TERRENCE_ALLOW_PRIVATE_URLS === "true";
  const urlError = validateExternalUrl(configuration.url, allowPrivate);
  if (urlError !== null) {
    return { body: urlError, code: "422", headers: {}, sentAt: new Date().toISOString(), successful: false, url: configuration.url, attempts: 0 };
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lastResponse = await fetch(configuration.url, {
        method: "POST",
        headers,
        body,
        // redirect:"error" stops a redirect from a checked public host to an
        // internal endpoint (redirect-based SSRF) — we never follow 3xx.
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
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

function runNotificationMessage(trigger: string, status: string): string {
  switch (trigger) {
    case "run:created": return "Run Created";
    case "run:planning": return "Run Planning";
    case "run:needs_attention": return "Run Needs Attention";
    case "run:applying": return "Run Applying";
    case "run:completed": return "Run Completed";
    case "run:errored": return `Run ${status === "canceled" ? "Canceled" : "Errored"}`;
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
  return { title: message, subtext: stringify(payload.run_message ?? payload.change_request_message), fields, linkLabel, linkUrl };
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
  const card: Record<string, unknown> = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: summary.status !== undefined ? "c0392b" : "2b579a",
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

  const allowPrivate = process.env.TERRENCE_ALLOW_PRIVATE_URLS === "true";
  const urlError = validateExternalUrl(configuration.url, allowPrivate);
  if (urlError !== null) {
    return { successful: false, echoed: null, bodyLacksEcho: true, headerLacksEcho: true };
  }

  let response: Response;
  try {
    response = await fetch(configuration.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { successful: false, echoed: null, bodyLacksEcho: true, headerLacksEcho: true };
  }

  const responseBody = await response.text();
  const headerEcho = response.headers.get("x-terrence-ownership-challenge") ?? "";
  const bodyLacksEcho = !responseBody.includes(challenge);
  const headerLacksEcho = headerEcho !== challenge;

  const successful = !bodyLacksEcho || !headerLacksEcho;
  if (successful) recordOwnershipVerified(configuration.id);
  return { successful, echoed: responseBody.slice(0, 256), bodyLacksEcho, headerLacksEcho };
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

  const matching = configurations.filter((configuration: NotificationConfiguration): boolean =>
    configuration.enabled === true && configuration.triggers.includes(trigger));
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  const runUrl = new URL(
    `/app/${encodeURIComponent(organization?.name ?? workspace.orgId)}/workspaces/${encodeURIComponent(workspace.name)}/runs/${encodeURIComponent(run.id)}`,
    baseUrl,
  ).toString();
  const updatedAt = new Date().toISOString();
  const runStatus = statusOverride ?? run.status;

  if (dedupAlreadyDelivered("run", `${run.id}:${trigger}:${runStatus}`)) {
    return [];
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

  if (dedupAlreadyDelivered("assessment", `${assessmentResultId}:${trigger}`)) {
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

  const matching = configurations.filter((configuration: NotificationConfiguration): boolean =>
    configuration.enabled === true && configuration.triggers.includes(trigger));
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  const messages = {
    "assessment:drifted": "Drift Detected",
    "assessment:check_failure": "Continuous Validation Check Failed",
    "assessment:failed": "Health Assessment Errored",
  } as const;

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

  const allConfigurations = [...configurations, ...teamConfigurations];

  const matching = allConfigurations.filter((configuration: NotificationConfiguration): boolean =>
    configuration.enabled === true && configuration.triggers.includes("team:change_request"));
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  // No change-request detail route exists in the frontend yet, so link to the
  // workspace page until a dedicated change-request UI is built (review item 1.4).
  const changeRequestUrl = new URL(
    `/app/${encodeURIComponent(organization?.name ?? workspace.orgId)}/workspaces/${encodeURIComponent(workspace.name)}`,
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
