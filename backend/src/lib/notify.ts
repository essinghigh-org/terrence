import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  assessmentResults,
  configurationVersions,
  notificationDeliveries,
  notificationDestinations,
  notificationRules,
  notificationTemplates,
  organizations,
  runs,
  workspaces,
  workspaceTags,
} from "../db/schema";
import {
  isNotificationEventType,
  type EventContext,
} from "./events";

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Substitute {{dotted.path}} placeholders with values from the context.
 * Null values render as ""; unknown paths (undefined) are left intact so
 * template typos stay visible. Pure string substitution — no evaluation.
 */
export function renderTemplate(template: string, context: EventContext): string {
  return template.replace(PLACEHOLDER_RE, (match, path: string): string => {
    const value = path.split(".").reduce<unknown>((current, key): unknown => {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[key];
    }, context);
    if (value === null) return "";
    if (value === undefined) return match;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}

// ---------------------------------------------------------------------------
// Apprise URL compilation
// ---------------------------------------------------------------------------

export type NotificationDestination = Readonly<{
  id: string;
  orgId: string;
  name: string;
  type: "slack" | "discord" | "sendgrid" | "apprise-custom";
  config: Readonly<Record<string, string>>;
  enabled: boolean;
}>;

/**
 * Build the Apprise URL for a destination.
 * - slack:  slack://xoxb-<token>/<channel>  (bot token) — channel may be #name
 * - discord: discord://<webhookId>/<webhookToken>/ (webhook URL is parsed)
 * - sendgrid: sendgrid:///<apikey>:<fromEmail>/<toEmail>
 * - apprise-custom: the raw string stored in config.url
 */
export function appriseUrlFor(destination: NotificationDestination): string {
  switch (destination.type) {
    case "slack": {
      const token = destination.config.token ?? "";
      const channel = destination.config.channel ?? "";
      return `slack://${token}/${channel}`;
    }
    case "discord": {
      const webhook = destination.config.webhookUrl ?? "";
      // discord://<webhook_id>/<webhook_token>/
      const match = /discord(?:app)?\.com\/api\/webhooks\/([^/]+)\/([^/]+)/.exec(webhook);
      if (match !== null) return `discord://${match[1]}/${match[2]}/`;
      return webhook; // already an apprise-style discord url
    }
    case "sendgrid": {
      const apiKey = destination.config.apiKey ?? "";
      const from = destination.config.fromEmail ?? "";
      const to = destination.config.toEmail ?? "";
      return `sendgrid:///${apiKey}:${from}/${to}`;
    }
    case "apprise-custom":
      return destination.config.url ?? "";
    default:
      return "";
  }
}

/** Apprise notification type for an event. */
export function notificationTypeFor(eventType: string): "info" | "success" | "warning" | "failure" {
  if (eventType.endsWith(".failed") || eventType === "workspace.drift.detected") return "failure";
  if (eventType.endsWith(".completed")) return "success";
  return "info";
}

// ---------------------------------------------------------------------------
// Delivery (Apprise CLI invocation)
// ---------------------------------------------------------------------------

export type DeliveryResult = Readonly<{
  ok: boolean;
  error: string | null;
  attempts: number;
}>;

const APPRISE_BIN = process.env.TERRENCE_APPRISE_BIN ?? "apprise";

/**
 * Invoke the apprise CLI for one destination. Writes a one-URL config file
 * (some apprise URLs contain characters that are awkward on argv) and runs
 * the CLI; a zero exit code means delivered. `--dry-run` is only used for
 * validation from the API test endpoint, not for real deliveries.
 */
export async function invokeApprise(
  destination: NotificationDestination,
  title: string,
  body: string,
  notificationType: "info" | "success" | "warning" | "failure",
  opts: Readonly<{ dryRun?: boolean }> = {},
): Promise<DeliveryResult> {
  const url = appriseUrlFor(destination);
  if (url === "") {
    return { ok: false, error: `No Apprise URL can be built for destination type ${destination.type}`, attempts: 0 };
  }

  const tmpDir = `${process.env.STORAGE_DIR ?? "/tmp"}/apprise-tmp`;
  const configPath = `${tmpDir}/${destination.id}.yml`;
  // Quote the URL scalar: unquoted, a leading `#` in a Slack channel
  // (e.g. slack://token/#general) would be parsed as a YAML comment and
  // silently truncate the URL. Single quotes are safe here because Apprise
  // URL schemas never contain them.
  const quotedUrl = `'${url}'`;
  await Bun.write(configPath, `urls:\n  - ${quotedUrl}\n`);

  const args = [
    "--config", configPath,
    "--title", title,
    "--body", body,
    "--notification-type", notificationType,
    ...(opts.dryRun === true ? ["--dry-run"] : []),
  ];

  try {
    const proc = Bun.spawn([APPRISE_BIN, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const combined = (stdout + stderr).slice(0, 16_384);
    if (exitCode === 0) {
      return { ok: true, error: null, attempts: 1 };
    }
    return { ok: false, error: combined.trim() === "" ? `apprise exited ${exitCode}` : combined, attempts: 1 };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, attempts: 1 };
  }
}

// ---------------------------------------------------------------------------
// Rule matching + event dispatch
// ---------------------------------------------------------------------------

export type NotificationRule = Readonly<{
  id: string;
  orgId: string;
  name: string;
  eventType: string;
  workspaceTagFilters: readonly Readonly<{ key: string; value: string }>[];
  destinationId: string;
  templateId: string | null;
  enabled: boolean;
}>;

/**
 * Match a rule against an event context: same org, enabled, same event type,
 * and every workspace tag filter satisfied by the workspace's tags.
 */
export function ruleMatches(rule: Readonly<NotificationRule>, context: Readonly<EventContext>): boolean {
  if (!rule.enabled) return false;
  if (rule.eventType !== context.event) return false;
  if (rule.workspaceTagFilters.length === 0) return true;
  return rule.workspaceTagFilters.every((filter) => {
    const actual = context.workspace.tags[filter.key];
    return actual !== undefined && actual === filter.value;
  });
}

/** Default title/body templates per event type (used when a rule has no template). */
export const DEFAULT_TEMPLATES: Readonly<Record<string, Readonly<{ title: string; body: string }>>> = {
  "workspace.run.started": {
    title: "Run Started",
    body: [
      "Workspace: {{workspace.name}}",
      "Run: {{run.id}}",
      "Triggered by: {{run.createdBy}}",
      "View: {{run.url}}",
    ].join("\n"),
  },
  "workspace.run.canceled": {
    title: "Run Canceled",
    body: [
      "Workspace: {{workspace.name}}",
      "Run: {{run.id}}",
      "View: {{run.url}}",
    ].join("\n"),
  },
  "workspace.plan.completed": {
    title: "Plan Completed",
    body: [
      "Workspace: {{workspace.name}}",
      "Plan completed with status: {{run.status}}",
      "View: {{run.url}}",
    ].join("\n"),
  },
  "workspace.plan.failed": {
    title: "Plan Failed",
    body: [
      "Workspace: {{workspace.name}}",
      "Commit: {{run.commitSha}}",
      "Error: {{run.message}}",
      "View: {{run.url}}",
    ].join("\n"),
  },
  "workspace.apply.completed": {
    title: "Apply Completed",
    body: [
      "Workspace: {{workspace.name}}",
      "Commit: {{run.commitSha}}",
      "View: {{run.url}}",
    ].join("\n"),
  },
  "workspace.apply.failed": {
    title: "Apply Failed",
    body: [
      "Workspace: {{workspace.name}}",
      "Commit: {{run.commitSha}}",
      "Error: {{run.message}}",
      "View: {{run.url}}",
    ].join("\n"),
  },
  "workspace.drift.detected": {
    title: "Drift Detected",
    body: [
      "Workspace: {{workspace.name}}",
      "Resources drifted: {{drift.resourcesDrifted}}",
      "View: {{drift.url}}",
    ].join("\n"),
  },
  "workspace.lock.created": {
    title: "Workspace Locked",
    body: [
      "Workspace: {{workspace.name}}",
      "Locked by: {{lock.createdBy}}",
      "Reason: {{lock.reason}}",
      "View: {{lock.url}}",
    ].join("\n"),
  },
  "workspace.variable.changed": {
    title: "Variable Changed",
    body: [
      "Workspace: {{workspace.name}}",
      "Variable {{variable.key}} {{variable.action}}",
    ].join("\n"),
  },
  "workspace.vcs.run.triggered": {
    title: "VCS Run Triggered",
    body: [
      "Workspace: {{workspace.name}}",
      "Commit: {{run.commitSha}}",
      "Message: {{run.commitMessage}}",
      "View: {{run.url}}",
    ].join("\n"),
  },
};

/**
 * Resolve the templates for a rule: explicit template if set, otherwise the
 * default for the event type.
 */
export async function resolveTemplate(
  rule: Readonly<NotificationRule>,
): Promise<Readonly<{ title: string; body: string }>> {
  if (rule.templateId !== null) {
    const tpl = await db.query.notificationTemplates.findFirst({
      where: eq(notificationTemplates.id, rule.templateId),
    });
    if (tpl !== undefined) {
      return { title: tpl.titleTemplate, body: tpl.bodyTemplate };
    }
  }
  return DEFAULT_TEMPLATES[rule.eventType] ?? { title: rule.eventType, body: rule.eventType };
}

/**
 * Emit a notification event: find matching rules for the workspace's org,
 * render each rule's template against the context, deliver via Apprise, and
 * log a notification_deliveries row per attempt. Fire-and-forget — callers
 * should not await this.
 */
export async function emitNotificationEvent(
  context: EventContext,
): Promise<readonly DeliveryResult[]> {
  if (!isNotificationEventType(context.event)) {
    console.error(`[terrence] Ignoring unknown notification event: ${context.event}`);
    return [];
  }

  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, context.workspace.id) });
  if (ws === undefined) return [];

  const rules = await db.query.notificationRules.findMany({
    where: and(
      eq(notificationRules.orgId, ws.orgId),
      eq(notificationRules.enabled, true),
      eq(notificationRules.eventType, context.event),
    ),
  });

  const matching = rules.filter((rule: Readonly<NotificationRule>): boolean => ruleMatches(rule, context));
  if (matching.length === 0) return [];

  const results: DeliveryResult[] = [];
  for (const rule of matching) {
    const destination = await db.query.notificationDestinations.findFirst({
      where: eq(notificationDestinations.id, rule.destinationId),
    });
    if (destination === undefined || destination.enabled !== true) continue;
    const typedDestination: NotificationDestination = {
      id: destination.id,
      orgId: destination.orgId,
      name: destination.name,
      type: destination.type as NotificationDestination["type"],
      config: destination.config,
      enabled: destination.enabled === true,
    };

    const tpl = await resolveTemplate(rule);
    const title = renderTemplate(tpl.title, context);
    const body = renderTemplate(tpl.body, context);
    const delivery = await invokeApprise(typedDestination, title, body, notificationTypeFor(context.event));

    await db.insert(notificationDeliveries).values({
      id: `nd-${crypto.randomUUID()}`,
      orgId: ws.orgId,
      ruleId: rule.id,
      destinationId: destination.id,
      workspaceId: ws.id,
      eventType: context.event,
      title,
      body,
      successful: delivery.ok,
      error: delivery.error,
      attempts: delivery.attempts,
      createdAt: Date.now(),
    });

    results.push(delivery);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Event context builders (worker + routes call these to emit)
// ---------------------------------------------------------------------------

/** Load workspace tags into a Record<key, value>. */
async function workspaceTagsFor(workspaceId: string): Promise<Record<string, string>> {
  const tags = await db.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId) });
  const result: Record<string, string> = {};
  for (const tag of tags) {
    if (tag.key !== "" && tag.value !== null) result[tag.key] = tag.value;
  }
  return result;
}

/**
 * Build the EventContext for a run event: loads the run, its workspace, the
 * org name, the creator, and workspace tags. Returns null if the run or its
 * workspace no longer exist.
 */
export async function buildRunContext(runId: string): Promise<EventContext | null> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (run === undefined) return null;
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
  if (workspace === undefined) return null;
  const organization = await db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) });
  const tags = await workspaceTagsFor(workspace.id);
  // Commit metadata lives on the run's configuration version ingress attributes.
  const configuration = run.configurationVersionId === null
    ? undefined
    : await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, run.configurationVersionId),
      });
  const ingress = configuration?.ingressAttributes ?? {};
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  const runUrl = new URL(
    `/app/${encodeURIComponent(organization?.name ?? workspace.orgId)}/${encodeURIComponent(workspace.name)}/runs/${encodeURIComponent(run.id)}`,
    baseUrl,
  ).toString();
  return {
    event: "workspace.run.started", // replaced by caller
    workspace: {
      id: workspace.id,
      name: workspace.name,
      organizationName: organization?.name ?? workspace.orgId,
      tags,
    },
    run: {
      id: run.id,
      message: run.message,
      status: run.status,
      createdAt: run.createdAt,
      createdBy: run.createdBy,
      commitSha: ingress.commitSha ?? null,
      commitUrl: ingress.commitUrl ?? null,
      commitMessage: ingress.commitMessage ?? null,
      branch: ingress.branch ?? null,
      url: runUrl,
    },
  };
}

/**
 * Build the EventContext for a drift event from an assessment result.
 */
export async function buildDriftContext(assessmentResultId: string): Promise<EventContext | null> {
  const result = await db.query.assessmentResults.findFirst({
    where: eq(assessmentResults.id, assessmentResultId),
  });
  if (result === undefined) return null;
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, result.workspaceId) });
  if (workspace === undefined) return null;
  const organization = await db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) });
  const tags = await workspaceTagsFor(workspace.id);
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  return {
    event: "workspace.drift.detected",
    workspace: {
      id: workspace.id,
      name: workspace.name,
      organizationName: organization?.name ?? workspace.orgId,
      tags,
    },
    drift: {
      assessmentResultId: result.id,
      resourcesDrifted: result.resourcesDrifted ?? 0,
      resourcesUndrifted: result.resourcesUndrifted ?? 0,
      checksPassed: result.checksPassed ?? 0,
      checksFailed: result.checksFailed ?? 0,
      checksErrored: result.checksErrored ?? 0,
      checksUnknown: result.checksUnknown ?? 0,
      url: new URL(`/api/v2/assessment-results/${encodeURIComponent(result.id)}`, baseUrl).toString(),
    },
  };
}

/**
 * Build the EventContext for a workspace lock event.
 */
export async function buildLockContext(
  workspaceId: string,
  lock: Readonly<{ id: string; createdBy: string | null; reason: string | null }>,
): Promise<EventContext | null> {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (workspace === undefined) return null;
  const organization = await db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) });
  const tags = await workspaceTagsFor(workspace.id);
  const baseUrl = process.env.PUBLIC_URL ?? "http://localhost";
  return {
    event: "workspace.lock.created",
    workspace: {
      id: workspace.id,
      name: workspace.name,
      organizationName: organization?.name ?? workspace.orgId,
      tags,
    },
    lock: {
      id: lock.id,
      createdBy: lock.createdBy,
      reason: lock.reason,
      url: new URL(
        `/app/${encodeURIComponent(organization?.name ?? workspace.orgId)}/${encodeURIComponent(workspace.name)}`,
        baseUrl,
      ).toString(),
    },
  };
}

/**
 * Build the EventContext for a variable change event.
 */
export async function buildVariableContext(
  workspaceId: string,
  variable: Readonly<{ id: string; key: string; category: string; sensitive: boolean; action: "created" | "updated" | "deleted" }>,
): Promise<EventContext | null> {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (workspace === undefined) return null;
  const organization = await db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) });
  const tags = await workspaceTagsFor(workspace.id);
  return {
    event: "workspace.variable.changed",
    workspace: {
      id: workspace.id,
      name: workspace.name,
      organizationName: organization?.name ?? workspace.orgId,
      tags,
    },
    variable,
  };
}

/**
 * Fire-and-forget emit: set the event type on the built context and dispatch.
 * Logs delivery failures; never throws to the caller.
 */
export function emitContext(context: EventContext, eventType: EventContext["event"]): void {
  void emitNotificationEvent({ ...context, event: eventType }).catch((error: unknown): void => {
    console.error(`[terrence] Failed to emit notification event ${eventType}:`, error);
  });
}

/** Fire-and-forget emit for a run-scoped event. */
export function emitRunEvent(
  runId: string,
  eventType: "workspace.run.started"
    | "workspace.run.canceled"
    | "workspace.plan.completed"
    | "workspace.plan.failed"
    | "workspace.apply.completed"
    | "workspace.apply.failed"
    | "workspace.vcs.run.triggered",
): void {
  void buildRunContext(runId).then((context): void => {
    if (context !== null) emitContext(context, eventType);
  }).catch((error: unknown): void => {
    console.error(`[terrence] Failed to build context for ${eventType} (run ${runId}):`, error);
  });
}

/** Fire-and-forget emit for a drift event from an assessment result. */
export function emitDriftEvent(assessmentResultId: string): void {
  void buildDriftContext(assessmentResultId).then((context): void => {
    if (context !== null) emitContext(context, "workspace.drift.detected");
  }).catch((error: unknown): void => {
    console.error(`[terrence] Failed to build drift context for ${assessmentResultId}:`, error);
  });
}

/** Fire-and-forget emit for a workspace lock event. */
export function emitLockCreated(
  workspaceId: string,
  lock: Readonly<{ id: string; createdBy: string | null; reason: string | null }>,
): void {
  void buildLockContext(workspaceId, lock).then((context): void => {
    if (context !== null) emitContext(context, "workspace.lock.created");
  }).catch((error: unknown): void => {
    console.error(`[terrence] Failed to build lock context for ${workspaceId}:`, error);
  });
}

/** Fire-and-forget emit for a workspace variable change event. */
export function emitVariableChanged(
  workspaceId: string,
  variable: Readonly<{ id: string; key: string; category: string; sensitive: boolean; action: "created" | "updated" | "deleted" }>,
): void {
  void buildVariableContext(workspaceId, variable).then((context): void => {
    if (context !== null) emitContext(context, "workspace.variable.changed");
  }).catch((error: unknown): void => {
    console.error(`[terrence] Failed to build variable context for ${workspaceId}:`, error);
  });
}
