/**
 * Shared capacity policy for work which can compete for the control plane.
 *
 * The database is the durable queue; this module deliberately contains only
 * deterministic policy. That keeps admission and claim decisions testable and
 * lets every worker apply the same limits without keeping an in-memory queue
 * that would disappear on restart.
 */

export const RESOURCE_BUDGET_ENV = "TERRENCE_RESOURCE_BUDGETS_JSON" as const;
export const RESOURCE_BUDGET_CONFIG_MAX_BYTES = 64 * 1024;
export const RESOURCE_BUDGET_RETRY_AFTER_MS = 1_000;

export const RESOURCE_JOB_CLASSES = [
  "critical",
  "cancellation",
  "health",
  "state-critical",
  "run",
  "plan",
  "explanation",
  "export",
  "background",
] as const;

export type ResourceJobClass = typeof RESOURCE_JOB_CLASSES[number];

export type OrganizationBudget = Readonly<{
  concurrency: number;
  queue: number;
  artifactBytes: number;
}>;

export type ResourceBudgetConfig = Readonly<{
  global: Readonly<{
    concurrency: number;
    queue: number;
    artifactBytes: number;
    reservedCriticalSlots: number;
  }>;
  organization: OrganizationBudget;
  classes: Readonly<Record<ResourceJobClass, Readonly<{ concurrency: number; queue: number }>>>;
  organizationOverrides: Readonly<Record<string, Partial<OrganizationBudget>>>;
}>;

export type ResourceBudgetJob = Readonly<{
  id: string;
  organizationId: string | null;
  jobClass: ResourceJobClass;
  estimatedBytes: number;
  runAfter: number;
  createdAt: number;
}>;

export type ResourceBudgetState = Readonly<{
  queued: readonly ResourceBudgetJob[];
  running: readonly ResourceBudgetJob[];
}>;

export type ResourceBudgetRejectionReason =
  | "global-queue-limit"
  | "organization-queue-limit"
  | "class-queue-limit"
  | "artifact-bytes-limit";

export type ResourceBudgetAdmission = Readonly<{
  accepted: boolean;
  reason: ResourceBudgetRejectionReason | null;
  retryAfterMs: number | null;
  /** Aggregate queue position. It is intentionally not per-organization. */
  queuePosition: number | null;
}>;

export type ResourceBudgetSnapshot = Readonly<{
  limits: Readonly<{
    globalConcurrency: number;
    globalQueue: number;
    organizationConcurrency: number;
    organizationQueue: number;
    artifactBytes: number;
    reservedCriticalSlots: number;
  }>;
  queued: number;
  running: number;
  queuedBytes: number;
  runningBytes: number;
  queuedByClass: Readonly<Record<ResourceJobClass, number>>;
  runningByClass: Readonly<Record<ResourceJobClass, number>>;
}>;

export type ResourceBudgetInspection = Readonly<{
  eligible: boolean;
  reasonCode:
    | "ready"
    | "scheduled"
    | "global-concurrency"
    | "organization-concurrency"
    | "class-concurrency"
    | "global-artifact-bytes"
    | "organization-artifact-bytes"
    | "reserved-capacity"
    | "fairness"
    | "no-eligible-candidate";
  reason: string;
  queuePosition: number | null;
  positionQualified: boolean;
  competingJobClass: ResourceJobClass | null;
}>;

type BudgetInput = Readonly<{
  concurrency?: unknown;
  queue?: unknown;
  artifactBytes?: unknown;
  reservedCriticalSlots?: unknown;
}>;

type ConfigInput = Readonly<{
  global?: BudgetInput;
  organization?: BudgetInput;
  classes?: Readonly<Record<string, BudgetInput>>;
  organizations?: Readonly<Record<string, BudgetInput>>;
}>;

const DEFAULT_GLOBAL = Object.freeze({
  concurrency: 5,
  queue: 1_000,
  artifactBytes: 256 * 1024 * 1024,
  reservedCriticalSlots: 1,
});

const DEFAULT_ORGANIZATION = Object.freeze({
  concurrency: 5,
  queue: 500,
  artifactBytes: 128 * 1024 * 1024,
});

const DEFAULT_CLASS_LIMITS: Readonly<Record<ResourceJobClass, Readonly<{ concurrency: number; queue: number }>>> = Object.freeze({
  critical: Object.freeze({ concurrency: 5, queue: 100 }),
  cancellation: Object.freeze({ concurrency: 5, queue: 100 }),
  health: Object.freeze({ concurrency: 2, queue: 100 }),
  "state-critical": Object.freeze({ concurrency: 3, queue: 100 }),
  run: Object.freeze({ concurrency: 4, queue: 500 }),
  plan: Object.freeze({ concurrency: 3, queue: 500 }),
  explanation: Object.freeze({ concurrency: 2, queue: 200 }),
  export: Object.freeze({ concurrency: 2, queue: 200 }),
  background: Object.freeze({ concurrency: 2, queue: 500 }),
});

const EMPTY_COUNTS = (): Record<ResourceJobClass, number> => Object.fromEntries(
  RESOURCE_JOB_CLASSES.map((jobClass): [ResourceJobClass, number] => [jobClass, 0]),
) as Record<ResourceJobClass, number>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid resource budget value for ${name}`);
  }
  return value;
}

function readBudgetInput(value: unknown, name: string, allowed: readonly string[]): BudgetInput {
  if (!isRecord(value)) throw new Error(`Invalid resource budget object for ${name}`);
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key): boolean => !allowedKeys.has(key))) {
    throw new Error(`Unsupported resource budget key for ${name}`);
  }
  return value as BudgetInput;
}

function boundedOrganization(value: BudgetInput | undefined, fallback: OrganizationBudget, name: string): OrganizationBudget {
  if (value === undefined) return fallback;
  return Object.freeze({
    concurrency: readInteger(value.concurrency, `${name}.concurrency`, 1, 1024) ?? fallback.concurrency,
    queue: readInteger(value.queue, `${name}.queue`, 1, 1_000_000) ?? fallback.queue,
    artifactBytes: readInteger(value.artifactBytes, `${name}.artifactBytes`, 1, 10 * 1024 * 1024 * 1024) ?? fallback.artifactBytes,
  });
}

/** Parse the JSON operator contract. An absent variable gets safe defaults. */
export function parseResourceBudgetConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResourceBudgetConfig {
  const raw = environment[RESOURCE_BUDGET_ENV];
  if (raw === undefined || raw.trim() === "") return defaultResourceBudgetConfig();
  if (Buffer.byteLength(raw, "utf8") > RESOURCE_BUDGET_CONFIG_MAX_BYTES) {
    throw new Error(`${RESOURCE_BUDGET_ENV} exceeds its size limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${RESOURCE_BUDGET_ENV} must contain valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${RESOURCE_BUDGET_ENV} must contain a JSON object`);
  if (Object.keys(parsed).some((key): boolean => !["global", "organization", "classes", "organizations"].includes(key))) {
    throw new Error(`Unsupported resource budget key`);
  }
  const input = parsed as ConfigInput;
  const globalInput = input.global === undefined ? undefined : readBudgetInput(input.global, "global", ["concurrency", "queue", "artifactBytes", "reservedCriticalSlots"]);
  const global = Object.freeze({
    concurrency: readInteger(globalInput?.concurrency, "global.concurrency", 1, 1024) ?? DEFAULT_GLOBAL.concurrency,
    queue: readInteger(globalInput?.queue, "global.queue", 1, 1_000_000) ?? DEFAULT_GLOBAL.queue,
    artifactBytes: readInteger(globalInput?.artifactBytes, "global.artifactBytes", 1, 10 * 1024 * 1024 * 1024) ?? DEFAULT_GLOBAL.artifactBytes,
    reservedCriticalSlots: readInteger(globalInput?.reservedCriticalSlots, "global.reservedCriticalSlots", 0, 1024) ?? DEFAULT_GLOBAL.reservedCriticalSlots,
  });
  if (global.reservedCriticalSlots > global.concurrency) {
    throw new Error("global.reservedCriticalSlots cannot exceed global.concurrency");
  }
  const organizationInput = input.organization === undefined ? undefined : readBudgetInput(input.organization, "organization", ["concurrency", "queue", "artifactBytes"]);
  const organization = boundedOrganization(organizationInput, DEFAULT_ORGANIZATION, "organization");
  if (input.classes !== undefined && !isRecord(input.classes)) throw new Error("classes must be an object");
  const classes = {} as Record<ResourceJobClass, Readonly<{ concurrency: number; queue: number }>>;
  for (const jobClass of RESOURCE_JOB_CLASSES) {
    const classValue = input.classes?.[jobClass];
    const classInput = classValue === undefined ? undefined : readBudgetInput(classValue, `classes.${jobClass}`, ["concurrency", "queue"]);
    const fallback = DEFAULT_CLASS_LIMITS[jobClass];
    classes[jobClass] = Object.freeze({
      concurrency: readInteger(classInput?.concurrency, `classes.${jobClass}.concurrency`, 1, 1024) ?? fallback.concurrency,
      queue: readInteger(classInput?.queue, `classes.${jobClass}.queue`, 1, 1_000_000) ?? fallback.queue,
    });
  }
  if (input.classes !== undefined && Object.keys(input.classes).some((key): boolean => !RESOURCE_JOB_CLASSES.includes(key as ResourceJobClass))) {
    throw new Error("Unsupported resource job class");
  }
  const overrides: Record<string, Partial<OrganizationBudget>> = {};
  if (input.organizations !== undefined && !isRecord(input.organizations)) throw new Error("organizations must be an object");
  for (const [organizationId, value] of Object.entries(input.organizations ?? {})) {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(organizationId)) throw new Error("Invalid organization budget key");
    const override = readBudgetInput(value, `organizations.${organizationId}`, ["concurrency", "queue", "artifactBytes"]);
    const organizationOverride: { concurrency?: number; queue?: number; artifactBytes?: number } = {};
    const concurrency = readInteger(override.concurrency, `organizations.${organizationId}.concurrency`, 1, 1024);
    const queue = readInteger(override.queue, `organizations.${organizationId}.queue`, 1, 1_000_000);
    const artifactBytes = readInteger(override.artifactBytes, `organizations.${organizationId}.artifactBytes`, 1, 10 * 1024 * 1024 * 1024);
    if (concurrency !== undefined) organizationOverride.concurrency = concurrency;
    if (queue !== undefined) organizationOverride.queue = queue;
    if (artifactBytes !== undefined) organizationOverride.artifactBytes = artifactBytes;
    overrides[organizationId] = Object.freeze(organizationOverride);
  }
  return Object.freeze({ global, organization, classes: Object.freeze(classes), organizationOverrides: Object.freeze(overrides) });
}

export function defaultResourceBudgetConfig(): ResourceBudgetConfig {
  return Object.freeze({
    global: DEFAULT_GLOBAL,
    organization: DEFAULT_ORGANIZATION,
    classes: DEFAULT_CLASS_LIMITS,
    organizationOverrides: Object.freeze({}),
  });
}

export function organizationBudget(config: ResourceBudgetConfig, organizationId: string | null): OrganizationBudget {
  const override = organizationId === null ? undefined : config.organizationOverrides[organizationId];
  return Object.freeze({
    concurrency: override?.concurrency ?? config.organization.concurrency,
    queue: override?.queue ?? config.organization.queue,
    artifactBytes: override?.artifactBytes ?? config.organization.artifactBytes,
  });
}

export function resourceJobClassForDurableKind(kind: string): ResourceJobClass {
  switch (kind) {
    case "plan-explanation": return "explanation";
    case "stack-deployment": return "run";
    case "stack-configuration":
    case "module-test": return "plan";
    case "vcs-webhook": return "critical";
    case "outbox-delivery": return "critical";
    case "explorer-inventory":
    case "explorer-catalog": return "background";
    default: return "background";
  }
}

function classFromPayload(kind: string, payload: Readonly<Record<string, unknown>>): ResourceJobClass {
  const value = payload["jobClass"];
  return typeof value === "string" && RESOURCE_JOB_CLASSES.includes(value as ResourceJobClass)
    ? value as ResourceJobClass
    : resourceJobClassForDurableKind(kind);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function nonNegativeBytes(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Convert a durable row's untrusted JSON payload into bounded policy data. */
export function resourceBudgetJobFromDurable(
  row: Readonly<{ id: string; kind: string; payload: Readonly<Record<string, unknown>>; runAfter: number; createdAt: number }>,
): ResourceBudgetJob {
  const payload = row.payload;
  return {
    id: row.id,
    organizationId: stringOrNull(payload["organizationId"] ?? payload["orgId"]),
    jobClass: classFromPayload(row.kind, payload),
    estimatedBytes: nonNegativeBytes(payload["estimatedBytes"]),
    runAfter: row.runAfter,
    createdAt: row.createdAt,
  };
}

function isProtected(jobClass: ResourceJobClass): boolean {
  return jobClass === "critical" || jobClass === "cancellation" || jobClass === "health" || jobClass === "state-critical";
}

function classRank(jobClass: ResourceJobClass): number {
  // Recovery work always gets first consideration. All other classes share
  // the ordinary lane and are compared by current utilization below, so a
  // run flood cannot permanently hold the lane ahead of plans, explanations,
  // exports, or background work.
  return isProtected(jobClass) ? 0 : 1;
}

function utilization(active: number, limit: number): number {
  return active / Math.max(1, limit);
}

function compareJobs(left: ResourceBudgetJob, right: ResourceBudgetJob): number {
  if (left.runAfter !== right.runAfter) return left.runAfter - right.runAfter;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id.localeCompare(right.id);
}

/**
 * Decide whether a new request may enter the durable queue. Concurrency is a
 * claim-time concern; a request which cannot start now is accepted with a
 * retry hint until one of its queue limits is reached.
 */
export function assessResourceBudget(
  config: ResourceBudgetConfig,
  state: ResourceBudgetState,
  request: ResourceBudgetJob,
): ResourceBudgetAdmission {
  const organization = organizationBudget(config, request.organizationId);
  const queuedForOrganization = state.queued.filter((job): boolean => job.organizationId === request.organizationId).length;
  const queuedForClass = state.queued.filter((job): boolean => job.jobClass === request.jobClass).length;
  const queuedBytes = state.queued.reduce((total, job): number => total + job.estimatedBytes, 0);
  const queuedBytesForOrganization = state.queued
    .filter((job): boolean => job.organizationId === request.organizationId)
    .reduce((total, job): number => total + job.estimatedBytes, 0);
  const runningBytesForOrganization = state.running
    .filter((job): boolean => job.organizationId === request.organizationId)
    .reduce((total, job): number => total + job.estimatedBytes, 0);
  if (request.estimatedBytes > Math.min(config.global.artifactBytes, organization.artifactBytes)) {
    return { accepted: false, reason: "artifact-bytes-limit", retryAfterMs: null, queuePosition: null };
  }
  if (state.queued.length >= config.global.queue) {
    return { accepted: false, reason: "global-queue-limit", retryAfterMs: RESOURCE_BUDGET_RETRY_AFTER_MS, queuePosition: null };
  }
  if (queuedForOrganization >= organization.queue) {
    return { accepted: false, reason: "organization-queue-limit", retryAfterMs: RESOURCE_BUDGET_RETRY_AFTER_MS, queuePosition: null };
  }
  if (queuedForClass >= config.classes[request.jobClass].queue) {
    return { accepted: false, reason: "class-queue-limit", retryAfterMs: RESOURCE_BUDGET_RETRY_AFTER_MS, queuePosition: null };
  }
  const estimatedPosition = state.queued.filter((job): boolean => job.runAfter <= request.runAfter).length + 1;
  const runningBytes = state.running.reduce((total, job): number => total + job.estimatedBytes, 0);
  const runningForOrganization = state.running.filter((job): boolean => job.organizationId === request.organizationId).length;
  const runningForClass = state.running.filter((job): boolean => job.jobClass === request.jobClass).length;
  const capacityWait = state.running.length >= config.global.concurrency
    || runningForOrganization >= organization.concurrency
    || runningForClass >= config.classes[request.jobClass].concurrency;
  const byteWait = runningBytes + queuedBytes + request.estimatedBytes > config.global.artifactBytes
    || runningBytesForOrganization + queuedBytesForOrganization + request.estimatedBytes > organization.artifactBytes;
  return {
    accepted: true,
    reason: null,
    retryAfterMs: capacityWait || byteWait ? RESOURCE_BUDGET_RETRY_AFTER_MS : null,
    queuePosition: estimatedPosition,
  };
}

/**
 * Select one eligible durable job. Protected classes always retain the
 * reserved slots. Among ordinary classes and organizations, the least-used
 * lane wins before age/id tie-breakers, providing deterministic fair sharing
 * without exposing per-organization usage in diagnostics.
 */
export function selectResourceBudgetJob(
  config: ResourceBudgetConfig,
  state: ResourceBudgetState,
  now = Date.now(),
): ResourceBudgetJob | undefined {
  const runningByClass = EMPTY_COUNTS();
  const runningByOrganization = new Map<string | null, number>();
  const runningBytesByOrganization = new Map<string | null, number>();
  let runningBytes = 0;
  for (const job of state.running) {
    runningByClass[job.jobClass] += 1;
    runningByOrganization.set(job.organizationId, (runningByOrganization.get(job.organizationId) ?? 0) + 1);
    runningBytesByOrganization.set(job.organizationId, (runningBytesByOrganization.get(job.organizationId) ?? 0) + job.estimatedBytes);
    runningBytes += job.estimatedBytes;
  }
  const regularConcurrency = Math.max(0, config.global.concurrency - config.global.reservedCriticalSlots);
  const ordinaryRunning = state.running.filter((job): boolean => !isProtected(job.jobClass)).length;
  const candidates = state.queued.filter((job): boolean => {
    if (job.runAfter > now) return false;
    // A reserved slot is a lower bound for protected work, not extra global
    // capacity. Never start another job once the aggregate limit is full.
    if (state.running.length >= config.global.concurrency) return false;
    const classLimit = config.classes[job.jobClass].concurrency;
    if (runningByClass[job.jobClass] >= classLimit) return false;
    const organization = organizationBudget(config, job.organizationId);
    if ((runningByOrganization.get(job.organizationId) ?? 0) >= organization.concurrency) return false;
    if (runningBytes + job.estimatedBytes > config.global.artifactBytes) return false;
    if ((runningBytesByOrganization.get(job.organizationId) ?? 0) + job.estimatedBytes > organization.artifactBytes) return false;
    if (!isProtected(job.jobClass) && ordinaryRunning >= regularConcurrency) return false;
    return true;
  });
  if (candidates.length === 0) return undefined;
  const activeByRank = new Map<number, number>();
  for (const job of state.running) activeByRank.set(classRank(job.jobClass), (activeByRank.get(classRank(job.jobClass)) ?? 0) + 1);
  candidates.sort((left, right): number => {
    const leftRank = classRank(left.jobClass);
    const rightRank = classRank(right.jobClass);
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftClass = config.classes[left.jobClass];
    const rightClass = config.classes[right.jobClass];
    const leftPressure = utilization(runningByClass[left.jobClass], leftClass.concurrency) + (activeByRank.get(leftRank) ?? 0) / config.global.concurrency;
    const rightPressure = utilization(runningByClass[right.jobClass], rightClass.concurrency) + (activeByRank.get(rightRank) ?? 0) / config.global.concurrency;
    if (leftPressure !== rightPressure) return leftPressure - rightPressure;
    const leftOrg = organizationBudget(config, left.organizationId);
    const rightOrg = organizationBudget(config, right.organizationId);
    const leftOrgPressure = utilization(runningByOrganization.get(left.organizationId) ?? 0, leftOrg.concurrency);
    const rightOrgPressure = utilization(runningByOrganization.get(right.organizationId) ?? 0, rightOrg.concurrency);
    if (leftOrgPressure !== rightOrgPressure) return leftOrgPressure - rightOrgPressure;
    return compareJobs(left, right);
  });
  return candidates[0];
}

/** Explain the same claim decision returned by selectResourceBudgetJob. */
export function explainResourceBudgetJob(
  config: ResourceBudgetConfig,
  state: ResourceBudgetState,
  request: ResourceBudgetJob,
  now = Date.now(),
): ResourceBudgetInspection {
  const ordered = [...state.queued].sort(compareJobs);
  const index = ordered.findIndex((job): boolean => job.id === request.id);
  const queuePosition = index >= 0
    ? index + 1
    : ordered.filter((job): boolean => compareJobs(job, request) <= 0).length + 1;
  const position = Number.isSafeInteger(queuePosition) ? queuePosition : null;
  const runningByClass = EMPTY_COUNTS();
  const runningByOrganization = new Map<string | null, number>();
  const runningBytesByOrganization = new Map<string | null, number>();
  let runningBytes = 0;
  for (const job of state.running) {
    runningByClass[job.jobClass] += 1;
    runningByOrganization.set(job.organizationId, (runningByOrganization.get(job.organizationId) ?? 0) + 1);
    runningBytesByOrganization.set(job.organizationId, (runningBytesByOrganization.get(job.organizationId) ?? 0) + job.estimatedBytes);
    runningBytes += job.estimatedBytes;
  }
  const organization = organizationBudget(config, request.organizationId);
  const regularConcurrency = Math.max(0, config.global.concurrency - config.global.reservedCriticalSlots);
  const ordinaryRunning = state.running.filter((job): boolean => !isProtected(job.jobClass)).length;
  const selected = selectResourceBudgetJob(config, state, now);
  const blocked = (
    reasonCode: ResourceBudgetInspection["reasonCode"],
    reason: string,
    competingJobClass: ResourceJobClass | null = null,
  ): ResourceBudgetInspection => ({
    eligible: false,
    reasonCode,
    reason,
    queuePosition: position,
    positionQualified: position !== null,
    competingJobClass,
  });

  if (request.runAfter > now) return blocked("scheduled", "The job is scheduled for a later time.");
  if (state.running.length >= config.global.concurrency) return blocked("global-concurrency", "Global durable-job concurrency is full.");
  if ((runningByOrganization.get(request.organizationId) ?? 0) >= organization.concurrency) return blocked("organization-concurrency", "The organization durable-job concurrency limit is full.");
  if (runningByClass[request.jobClass] >= config.classes[request.jobClass].concurrency) return blocked("class-concurrency", "The durable-job class concurrency limit is full.");
  if (runningBytes + request.estimatedBytes > config.global.artifactBytes) return blocked("global-artifact-bytes", "The global durable-job artifact-byte budget is full.");
  if ((runningBytesByOrganization.get(request.organizationId) ?? 0) + request.estimatedBytes > organization.artifactBytes) return blocked("organization-artifact-bytes", "The organization durable-job artifact-byte budget is full.");
  if (!isProtected(request.jobClass) && ordinaryRunning >= regularConcurrency) return blocked("reserved-capacity", "Reserved capacity is held for protected durable-job classes.");
  if (selected?.id === request.id) {
    return {
      eligible: true,
      reasonCode: "ready",
      reason: "The job is the next candidate under the current capacity and fairness policy.",
      queuePosition: position,
      positionQualified: position !== null,
      competingJobClass: null,
    };
  }
  if (selected !== undefined) return blocked("fairness", "Another eligible job wins the current fairness comparison; the ordering can change as jobs run or finish.", selected.jobClass);
  return blocked("no-eligible-candidate", "No durable job is eligible under the current capacity policy.");
}

export function resourceBudgetSnapshot(config: ResourceBudgetConfig, state: ResourceBudgetState): ResourceBudgetSnapshot {
  const queuedByClass = EMPTY_COUNTS();
  const runningByClass = EMPTY_COUNTS();
  for (const job of state.queued) queuedByClass[job.jobClass] += 1;
  for (const job of state.running) runningByClass[job.jobClass] += 1;
  return {
    limits: {
      globalConcurrency: config.global.concurrency,
      globalQueue: config.global.queue,
      organizationConcurrency: config.organization.concurrency,
      organizationQueue: config.organization.queue,
      artifactBytes: config.global.artifactBytes,
      reservedCriticalSlots: config.global.reservedCriticalSlots,
    },
    queued: state.queued.length,
    running: state.running.length,
    queuedBytes: state.queued.reduce((total, job): number => total + job.estimatedBytes, 0),
    runningBytes: state.running.reduce((total, job): number => total + job.estimatedBytes, 0),
    queuedByClass: Object.freeze(queuedByClass),
    runningByClass: Object.freeze(runningByClass),
  };
}

/** Safe operator-facing shape; organization IDs and usage are intentionally absent. */
export function resourceBudgetConfigurationResource(config: ResourceBudgetConfig): Record<string, unknown> {
  return {
    global: { ...config.global },
    organization: { ...config.organization },
    classes: Object.fromEntries(RESOURCE_JOB_CLASSES.map((jobClass): [string, Readonly<{ concurrency: number; queue: number }>] => [jobClass, config.classes[jobClass]])),
    "organization-override-count": Object.keys(config.organizationOverrides).length,
  };
}
