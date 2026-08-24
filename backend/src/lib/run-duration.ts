/**
 * Return the time spent executing a run's plan and apply phases.
 *
 * Values such as input-state-serial live alongside timestamps in the same
 * JSON object, so callers must select timestamp keys explicitly. A paused
 * planned run is intentionally not counted between planned-at and applying-at.
 */
export function runExecutionDurationMilliseconds(
  timestamps: Readonly<Record<string, unknown>> | null | undefined,
  planOnly = false,
): number | null {
  const values = timestamps ?? {};
  const parse = (key: string): number | undefined => {
    if (!key.endsWith("-at")) return undefined;
    const value = values[key];
    if (typeof value !== "string") return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  };
  const first = (keys: readonly string[]): number | undefined => {
    for (const key of keys) {
      const value = parse(key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const planStart = parse("planning-at") ?? parse("pending-at") ?? parse("planned-at");
  const planEnd = first([
    "planned-at",
    "planned-and-finished-at",
    "planned-and-saved-at",
    "errored-at",
    "unreachable-at",
    "canceled-at",
    "force-canceled-at",
  ]);
  if (planStart === undefined || planEnd === undefined) return null;

  // Older rows did not record applying-at. Preserve a useful duration for
  // those rows while all newly recorded runs use the phase-specific path.
  if (!planOnly && parse("applying-at") === undefined && parse("applied-at") !== undefined) {
    const legacyEnd = first(["applied-at", "errored-at", "unreachable-at", "canceled-at", "force-canceled-at"]);
    return legacyEnd === undefined ? null : Math.max(0, legacyEnd - planStart);
  }

  const planDuration = Math.max(0, planEnd - planStart);
  if (planOnly) return planDuration;

  const applyStart = parse("applying-at");
  if (applyStart === undefined) return planDuration;
  const applyEnd = first(["applied-at", "errored-at", "unreachable-at", "canceled-at", "force-canceled-at"]);
  if (applyEnd === undefined) return null;
  return planDuration + Math.max(0, applyEnd - applyStart);
}
