/**
 * Notification event types and their context payloads.
 *
 * Events are emitted by the worker and API routes; rules match on
 * eventType + workspace tags, templates render from the context.
 */
export const NOTIFICATION_EVENTS = [
  "workspace.run.started",
  "workspace.run.canceled",
  "workspace.plan.completed",
  "workspace.plan.failed",
  "workspace.apply.completed",
  "workspace.apply.failed",
  "workspace.drift.detected",
  "workspace.lock.created",
  "workspace.variable.changed",
  "workspace.vcs.run.triggered",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** Workspace context available to every event. */
export type EventWorkspace = Readonly<{
  id: string;
  name: string;
  organizationName: string;
  tags: Readonly<Record<string, string>>;
}>;

/** Run context for run/plan/apply events. */
export type EventRun = Readonly<{
  id: string;
  message: string | null;
  status: string;
  createdAt: number;
  createdBy: string | null;
  commitSha: string | null;
  commitUrl: string | null;
  commitMessage: string | null;
  branch: string | null;
  url: string;
}>;

/** Variable context for workspace.variable.changed. */
export type EventVariable = Readonly<{
  id: string;
  key: string;
  category: string;
  sensitive: boolean;
  action: "created" | "updated" | "deleted";
}>;

/** Lock context for workspace.lock.created. */
export type EventLock = Readonly<{
  id: string;
  createdBy: string | null;
  reason: string | null;
  url: string;
}>;

/** Drift context for workspace.drift.detected. */
export type EventDrift = Readonly<{
  assessmentResultId: string;
  resourcesDrifted: number;
  resourcesUndrifted: number;
  checksPassed: number;
  checksFailed: number;
  checksErrored: number;
  checksUnknown: number;
  url: string;
}>;

/** The full context object templates render against. */
export type EventContext = Readonly<{
  event: NotificationEventType;
  workspace: EventWorkspace;
  run?: EventRun;
  variable?: EventVariable;
  lock?: EventLock;
  drift?: EventDrift;
}>;
