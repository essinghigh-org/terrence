/**
 * Canonical unions for stable domain values. These are the single source
 * of truth for execution/provider/notification modes so the same literals
 * never drift across route validation, worker logic, and schemas (24.8).
 * All additions are additive: new members are fine, removing a member is
 * a breaking change.
 */

export const EXECUTION_MODES = ["remote", "local", "agent"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const PROVIDER_MODES = ["tofu", "terraform"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const NOTIFICATION_DESTINATIONS = ["generic", "slack", "microsoft-teams"] as const;
export type NotificationDestination = (typeof NOTIFICATION_DESTINATIONS)[number];

export const RUN_NOTIFICATION_TRIGGERS = [
  "run:created",
  "run:planning",
  "run:needs_attention",
  "run:applying",
  "run:completed",
  "run:errored",
] as const;
export type RunNotificationTrigger = (typeof RUN_NOTIFICATION_TRIGGERS)[number];

export const ASSESSMENT_NOTIFICATION_TRIGGERS = [
  "assessment:drifted",
  "assessment:check_failure",
  "assessment:failed",
] as const;
export type AssessmentNotificationTrigger = (typeof ASSESSMENT_NOTIFICATION_TRIGGERS)[number];

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);
}

export function isProviderMode(value: unknown): value is ProviderMode {
  return typeof value === "string" && (PROVIDER_MODES as readonly string[]).includes(value);
}

export function isNotificationDestination(value: unknown): value is NotificationDestination {
  return typeof value === "string" && (NOTIFICATION_DESTINATIONS as readonly string[]).includes(value);
}
