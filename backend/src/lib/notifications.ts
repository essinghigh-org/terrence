import { createHmac } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../db";
import {
  assessmentResults,
  notificationConfigurations,
  organizations,
  runs,
  users,
  workspaces,
} from "../db/schema";

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

export async function postNotification(
  configuration: NotificationConfiguration,
  payload: Readonly<Record<string, unknown>>,
): Promise<NotificationDelivery> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (configuration.destinationType === "generic" && configuration.token !== null) {
    headers["X-TFE-Notification-Signature"] = createHmac("sha512", configuration.token)
      .update(body)
      .digest("hex");
  }

  let lastResponse: Response | undefined;
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lastResponse = await fetch(configuration.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5_000),
      });
      const responseBody = await lastResponse.text();
      if (lastResponse.ok || (lastResponse.status < 500 && lastResponse.status !== 429)) {
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
  const baseUrl = process.env["PUBLIC_URL"] ?? "http://localhost";
  const runUrl = new URL(
    `/app/${encodeURIComponent(organization?.name ?? workspace.orgId)}/${encodeURIComponent(workspace.name)}/runs/${encodeURIComponent(run.id)}`,
    baseUrl,
  ).toString();
  const updatedAt = new Date().toISOString();
  const runStatus = statusOverride ?? run.status;

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

type DeepReadonly<T> = T extends readonly (infer Value)[]
  ? readonly DeepReadonly<Value>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

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
  const baseUrl = process.env["PUBLIC_URL"] ?? "http://localhost";
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
