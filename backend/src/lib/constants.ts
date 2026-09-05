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

// Token description limits (todo 61/62): bounded at every mint path so
// arbitrary upstream strings cannot bloat api_tokens rows.
export const TOKEN_DESCRIPTION_MAX_LENGTH = 255;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

/** One deliberate compatibility target for every reference-format discovery header.
 * Kept dotted on purpose: the hashicorp/tfe provider treats Terrence as TFE
 * (no TFP-AppName) and gates versioned features on a dotted X-TFE-Version —
 * release-style values fail those gates (provider E2E proves it). */
export const COMPATIBILITY_VERSION =
  process.env["TERRENCE_COMPATIBILITY_VERSION"]?.trim() ||
  process.env["TERRENCE_TFE_COMPATIBILITY_VERSION"]?.trim() ||
  "2.5.0";

// The TFP-API-Version response header carries the Terraform provider API
// version that clients compare as a dotted numeric (e.g. "2.0"), whereas
// TFE-Version / X-TFE-Version carry a product release string (e.g. "v202401-1").
// The compatibility version above often holds a release-style value via env,
// which would make TFP-API-Version unparseable and break version negotiation.
// Keep the API version in its own constant, overridable independently.
export const TFP_API_VERSION = process.env["TERRENCE_TFP_API_VERSION"]?.trim() || "2.6";
/** One-line compatibility promise repeated in unsupported-endpoint errors
 * (issue #643) so provider users hitting an unknown path learn the scope
 * instead of guessing. Mirrors the README and compatibility doc wording. */
export const COMPATIBILITY_PROMISE =
  "Terrence supports the hashicorp/tfe provider surface, Terraform/OpenTofu remote workflows, and the product API; general TFE or HCP parity is not a goal.";

export const NOTIFICATION_DESTINATIONS = ["generic", "slack", "discord", "microsoft-teams", "email"] as const;
export type NotificationDestination = (typeof NOTIFICATION_DESTINATIONS)[number];

export const RUN_NOTIFICATION_TRIGGERS = [
  "run:created",
  "run:planning",
  "run:needs_attention",
  "run:applying",
  "run:completed",
  "run:errored",
  "run:confirmed",
] as const;
// Re-exported for API consumers via route schemas; knip cannot see that use.
/** @public */
export type RunNotificationTrigger = (typeof RUN_NOTIFICATION_TRIGGERS)[number];

export const ASSESSMENT_NOTIFICATION_TRIGGERS = [
  "assessment:drifted",
  "assessment:check_failure",
  "assessment:failed",
] as const;
// Re-exported for API consumers via route schemas; knip cannot see that use.
/** @public */
export type AssessmentNotificationTrigger = (typeof ASSESSMENT_NOTIFICATION_TRIGGERS)[number];

export const CHANGE_REQUEST_NOTIFICATION_TRIGGERS = [
  "change_request:created",
  "change_request:rejected",
  "change_request:applied",
  "change_request:canceled",
  "team:change_request",
] as const;
// Re-exported for API consumers via route schemas; knip cannot see that use.
/** @public */
export type ChangeRequestNotificationTrigger = (typeof CHANGE_REQUEST_NOTIFICATION_TRIGGERS)[number];

export const NOTIFICATION_TRIGGERS = [
  ...RUN_NOTIFICATION_TRIGGERS,
  ...ASSESSMENT_NOTIFICATION_TRIGGERS,
  ...CHANGE_REQUEST_NOTIFICATION_TRIGGERS,
] as const;

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);
}

/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function isProviderMode(value: unknown): value is ProviderMode {
  return typeof value === "string" && (PROVIDER_MODES as readonly string[]).includes(value);
}

export function isNotificationDestination(value: unknown): value is NotificationDestination {
  return typeof value === "string" && (NOTIFICATION_DESTINATIONS as readonly string[]).includes(value);
}

export function isNotificationTrigger(value: unknown): value is (typeof NOTIFICATION_TRIGGERS)[number] {
  return typeof value === "string" && (NOTIFICATION_TRIGGERS as readonly string[]).includes(value);
}
