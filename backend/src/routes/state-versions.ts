import { discardStateReservation, fenceStateWorkspace, pruneStateReservations, stateReservationObsolete, stateUploadLock, STATE_UPLOAD_TTL_MS } from "../lib/state-reservations";
import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { db } from "../db";
import { agentJobs, auditLogs, logs, stateOutputIndex, stateVersions, workspaces, runs, organizationMemberships, teams, type users } from "../db/schema";
import { eq, and, desc, count, inArray, ne, or, isNull, sql } from "drizzle-orm";
import { stateVersionResource, stateOutputResources, stateVersionSummaryResource } from "../lib/response";
import { encryptStatePayload, isClientEncryptedState, parseTerraformStatePayload, statePayloadError, statePayloadWithSerial } from "../lib/validation";
import { checkWorkspacePermission, checkRunStateAccess, workspaceIdsForPermission } from "../lib/authorization";
import { findAuthorizedWorkspace, findRemoteStateReadableWorkspace } from "../lib/authorized-resources";
import { decodeStatePayload, parseStatePayload, auditLog, lockPrincipal, ownsWorkspaceLock } from "../lib/utils";
import { validSignedApiURL } from "../lib/capabilities";
import { isUniqueConstraintError } from "../lib/validation";
import { authPlugin } from "../auth";
import { scheduleExplorerInventory } from "../lib/explorer-inventory";
import { insertStateOutputIndex, replaceStateOutputIndex } from "../lib/state-output-index";
import { persistUploadBody } from "../lib/upload-body";
import { storageDir } from "../db/driver";
import { auditLogValues } from "../lib/audit-trail";
import { authorizedStateAccess } from "../lib/authorized-resources";
import { pageRequest, pagination } from "../lib/pagination";
import { commitStateVersion } from "../lib/commands/state-version";
import {
  acquireRecoveryPromotionLock,
  inspectRecoveryCopy,
  markRecoveryPromoted,
  releaseRecoveryPromotionLock,
  type RecoveryCopyInspection,
} from "../lib/recovery-files";
import { commitStateVersionAtSerialTx, nextStateSerialTx } from "../lib/state-commit";
import { abandonIdempotency, beginIdempotency, completeIdempotency, idempotencyContext, idempotencyError, idempotencyPrincipal } from "../lib/idempotency";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  run: { runId: string; workspaceId: string; organizationId: string } | null;
  request: Request;
  set: SetObj;
}>;

/**
 * State-write callers may be write-only team principals. Keep the serializer
 * honest by carrying both capabilities only when the read decision was also
 * made for this exact workspace.
 */
async function stateResponseAccess(
  workspace: Readonly<typeof workspaces.$inferSelect>,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
): Promise<ReturnType<typeof authorizedStateAccess>> {
  const capabilities: ("state-read" | "state-write")[] = ["state-write"];
  if (await checkWorkspacePermission(workspace, userId, orgId, teamId, "state-read")) capabilities.push("state-read");
  return authorizedStateAccess(workspace.id, capabilities);
}

const MAX_IMPORTED_STATE_BYTES = 100 * 1024 * 1024;
export const MAX_LEGACY_STATE_OUTPUT_CANDIDATES = 100;

// Issue #578: serialize deferred uploads per state version. The conditional
// finalize inside each endpoint is the cross-process correctness backstop
// (exactly one concurrent PUT can win); the mutex gives the loser a fast 409
// without both sides transferring bodies. Entries are request-scoped and
// always released, so unlike a DB claim they can never stick after a crash.
const stateUploadLocks = new Set<string>();

function tryAcquireStateUpload(stateVersionId: string): boolean {
  if (stateUploadLocks.has(stateVersionId)) return false;
  stateUploadLocks.add(stateVersionId);
  return true;
}

function releaseStateUpload(stateVersionId: string): void {
  stateUploadLocks.delete(stateVersionId);
}

async function withStateSerialRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error) || attempt === 2) throw error;
    }
  }
  throw new Error("State serial allocation failed");
}

class StateSerialConflictError extends Error {
  constructor() {
    super("State serial must advance the current workspace state");
    this.name = "StateSerialConflictError";
  }
}

type BodyTextResult = Readonly<{ ok: true; text: string } | { ok: false; reason: "too-large" | "empty" }>;

async function requestBodyText(
  body: unknown,
  request: Request,
): Promise<BodyTextResult> {
  const uploadDir = join(storageDir, "state-uploads");
  const path = join(uploadDir, `state-${crypto.randomUUID()}.json`);
  await mkdir(uploadDir, { recursive: true });
  try {
    try {
      await persistUploadBody(body, request, path, MAX_IMPORTED_STATE_BYTES);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "too-large") return { ok: false, reason: "too-large" };
      if (error instanceof Error && error.message === "empty") return { ok: false, reason: "empty" };
      throw error;
    }
    // The upload is already bounded on disk; JSON parsing needs the complete
    // document, so this single read cannot exceed MAX_IMPORTED_STATE_BYTES.
    return { ok: true, text: await readFile(path, "utf8") };
  } finally {
    await rm(path, { force: true });
  }
}

async function replayStateVersion(
  resourceId: string | null,
  workspaceId: string,
  request: Readonly<{ url: string }>,
  fallback: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (resourceId === null) return fallback;
  const state = await db.query.stateVersions.findFirst({
    where: and(eq(stateVersions.id, resourceId), eq(stateVersions.workspaceId, workspaceId)),
  });
  return state === undefined ? fallback : { data: stateVersionResource(state, request) };
}

function stateLineageError(
  previousState: Readonly<{ statePayload: string | null }> | undefined,
  incomingState: Readonly<Record<string, unknown>>,
): string | null {
  if (previousState === undefined) return null;
  if (typeof previousState.statePayload !== "string" || previousState.statePayload === "") {
    return "State lineage cannot be validated because the workspace history has no state payload";
  }
  let previous: Record<string, unknown> | null;
  try {
    previous = parseTerraformStatePayload(decodeStatePayload(previousState.statePayload));
  } catch {
    previous = null;
  }
  if (previous === null) {
    return "State lineage cannot be validated because the workspace history contains an invalid state payload";
  }
  return incomingState["lineage"] === previous["lineage"]
    ? null
    : "State lineage does not match the workspace history";
}

type RecoveryReviewCheck = Readonly<{
  id: string;
  status: "pass" | "fail" | "blocked" | "unknown";
  detail: string;
}>;

type RecoveryStateMetadata = Readonly<{
  id: string;
  serial: number | null;
  lineage: string | null;
  digest: string | null;
  size: number | null;
  terraformVersion: string | null;
  representation: "terraform-v4" | "opentofu-encrypted" | "invalid" | "unavailable";
}>;

const RECOVERY_ACTIVE_RUN_STATUSES = new Set([
  "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
  "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
  "policy_checking", "policy_override", "policy_checked", "post_plan_running",
  "post_plan_completed", "confirmed", "apply_queued", "applying",
]);

function stateMetadata(state: Readonly<{ id: string; statePayload: string | null; serial: number; terraformVersion: string | null }>): RecoveryStateMetadata {
  if (typeof state.statePayload !== "string" || state.statePayload === "") {
    return { id: state.id, serial: state.serial, lineage: null, digest: null, size: null, terraformVersion: state.terraformVersion, representation: "unavailable" };
  }
  try {
    const payload = decodeStatePayload(state.statePayload);
    const parsed = parseTerraformStatePayload(payload);
    return {
      id: state.id,
      serial: parsed?.["serial"] !== undefined && Number.isSafeInteger(parsed["serial"]) ? parsed["serial"] as number : state.serial,
      lineage: typeof parsed?.["lineage"] === "string" && parsed["lineage"] !== "" && parsed["lineage"].length <= 256 ? parsed["lineage"] : null,
      digest: createHash("sha256").update(payload).digest("hex"),
      size: Buffer.byteLength(payload),
      terraformVersion: typeof parsed?.["terraform_version"] === "string" && parsed["terraform_version"].length <= 256 ? parsed["terraform_version"] : state.terraformVersion,
      representation: parsed === null
        ? isClientEncryptedState(payload) ? "opentofu-encrypted" : "invalid"
        : "terraform-v4",
    };
  } catch {
    return { id: state.id, serial: state.serial, lineage: null, digest: null, size: null, terraformVersion: state.terraformVersion, representation: "invalid" };
  }
}

function redactRecoveryLog(text: string): string {
  const bounded = text.length > 4096 ? text.slice(-4096) : text;
  return bounded.replace(/(authorization|bearer|token|password|secret|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function recoveryCandidateMetadata(capture: RecoveryCopyInspection): RecoveryStateMetadata | null {
  if (capture.status === "missing" || capture.status === "incomplete") return null;
  return {
    id: capture.evidence?.promotedStateVersionId ?? "recovery-candidate",
    serial: capture.serial,
    lineage: capture.lineage,
    digest: capture.digest,
    size: capture.size,
    terraformVersion: capture.terraformVersion,
    representation: capture.status === "opaque" ? "opentofu-encrypted" : capture.status === "candidate" || capture.status === "promoted" ? "terraform-v4" : "invalid",
  };
}

async function activeRecoveryOwner(runId: string, runStatus: string): Promise<Readonly<{
  runActive: boolean;
  localProcessActive: boolean;
  agentJobs: readonly Readonly<{ id: string; phase: string; status: string; agentId: string | null; claimedAt: number | null }>[];
}>> {
  const jobs = await db.query.agentJobs.findMany({
    where: and(eq(agentJobs.runId, runId), inArray(agentJobs.status, ["queued", "claimed"])),
    columns: { id: true, phase: true, status: true, agentId: true, claimedAt: true },
  });
  let localProcessActive = false;
  try {
    const worker = await import("../worker");
    localProcessActive = worker.hasActiveRunExecution(runId);
  } catch {
    // The worker may be intentionally absent in a read-only API process. The
    // durable run status and agent-job rows remain authoritative then.
  }
  return {
    runActive: RECOVERY_ACTIVE_RUN_STATUSES.has(runStatus),
    localProcessActive,
    agentJobs: jobs,
  };
}

type RecoveryReviewData = Awaited<ReturnType<typeof fetchRecoveryReviewData>>;
type RecoveryCapture = RecoveryReviewData["capture"];
type RecoveryOwner = RecoveryReviewData["owner"];
type RecoveryCandidate = ReturnType<typeof recoveryCandidateMetadata>;
type CommittedRecoveryState = ReturnType<typeof stateMetadata> | null;

async function fetchRecoveryReviewData(
  run: Readonly<typeof runs.$inferSelect>,
  workspace: Readonly<typeof workspaces.$inferSelect>,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
) {
  const canWritePromise = orgId === null
    ? checkWorkspacePermission(workspace, userId, orgId, teamId, "state-write")
    : Promise.resolve(false);
  const [capture, latest, owner, recentLogs, canWrite] = await Promise.all([
    inspectRecoveryCopy(storageDir, run.id),
    db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized"), eq(stateVersions.intermediate, false)),
      orderBy: [desc(stateVersions.serial)],
      columns: { id: true, statePayload: true, serial: true, terraformVersion: true },
    }),
    activeRecoveryOwner(run.id, run.status),
    db.query.logs.findMany({
      where: eq(logs.runId, run.id),
      orderBy: [desc(logs.createdAt), desc(logs.id)],
      limit: 12,
      columns: { id: true, phase: true, outputText: true, createdAt: true },
    }),
    canWritePromise,
  ]);
  return { capture, latest, owner, recentLogs, canWrite };
}

function isRecoveryOwnerClear(owner: RecoveryOwner): boolean {
  return !owner.runActive && !owner.localProcessActive && owner.agentJobs.length === 0;
}

function isRecoveryCandidate(capture: RecoveryCapture): boolean {
  return capture.status === "candidate" || capture.status === "promoted";
}

function captureCompleteCheck(capture: RecoveryCapture): RecoveryReviewCheck {
  const pass = capture.status !== "missing" && capture.status !== "incomplete" && capture.marker !== null;
  return { id: "capture-complete", status: pass ? "pass" : "fail", detail: pass ? "The durable capture marker is present." : "The capture marker is missing or invalid; this copy is not a verified candidate." };
}

function candidateParseCheck(capture: RecoveryCapture): RecoveryReviewCheck {
  const pass = capture.status === "candidate" || capture.status === "promoted";
  return { id: "candidate-parse", status: pass ? "pass" : capture.status === "opaque" ? "blocked" : "fail", detail: pass ? "The captured state is a supported Terraform state document." : capture.status === "opaque" ? "The captured state is client-encrypted and needs its original client keys." : "The captured state cannot be parsed as a supported Terraform state document." };
}

function digestCheck(capture: RecoveryCapture, candidate: RecoveryCandidate): RecoveryReviewCheck {
  const pass = candidate?.digest !== null && candidate?.digest !== undefined && (capture.evidence === null || (capture.evidence.digest === candidate.digest && capture.evidence.size === candidate.size));
  return { id: "digest", status: pass ? "pass" : "fail", detail: pass ? "The captured bytes match their recorded SHA-256 digest." : "The captured bytes do not match the recorded SHA-256 digest." };
}

function lineageCheck(candidate: RecoveryCandidate, committed: CommittedRecoveryState): RecoveryReviewCheck {
  const pass = candidate?.lineage !== null && (committed === null || committed.lineage === null || candidate?.lineage === committed.lineage);
  return { id: "lineage", status: candidate?.lineage === null ? "unknown" : pass ? "pass" : "fail", detail: candidate?.lineage === null ? "The candidate has no lineage value to compare." : pass ? "The candidate lineage matches the latest committed state." : "The candidate lineage differs from the latest committed state." };
}

function recoveryDigestsMatch(candidate: RecoveryCandidate, committed: CommittedRecoveryState): boolean {
  return candidate?.digest !== null && candidate?.digest !== undefined && candidate.digest === committed?.digest;
}

function recoveryCandidateStale(candidate: RecoveryCandidate, committed: CommittedRecoveryState, sameDigest: boolean): boolean {
  const candidateSerial = candidate?.serial;
  const committedSerial = committed?.serial;
  return committedSerial !== null && committedSerial !== undefined && candidateSerial !== null && candidateSerial !== undefined
    && candidateSerial < committedSerial && !sameDigest;
}

function recoverySerialConflict(candidate: RecoveryCandidate, committed: CommittedRecoveryState, sameDigest: boolean): boolean {
  const candidateSerial = candidate?.serial;
  const committedSerial = committed?.serial;
  return committedSerial !== null && committedSerial !== undefined && candidateSerial !== null && candidateSerial !== undefined
    && candidateSerial === committedSerial && !sameDigest;
}

function serialCheck(candidate: RecoveryCandidate, committed: CommittedRecoveryState): RecoveryReviewCheck {
  const sameDigest = recoveryDigestsMatch(candidate, committed);
  const stale = recoveryCandidateStale(candidate, committed, sameDigest);
  const conflict = recoverySerialConflict(candidate, committed, sameDigest);
  const known = candidate?.serial !== null && candidate?.serial !== undefined;
  return { id: "serial", status: !known ? "unknown" : stale || conflict ? "fail" : "pass", detail: stale ? "The candidate serial is behind a different committed state and is stale." : conflict ? "The candidate shares a serial with a different committed digest." : "The candidate serial is compatible with the current history." };
}

function ownerTerminatedCheck(owner: RecoveryOwner): RecoveryReviewCheck {
  const clear = isRecoveryOwnerClear(owner);
  return { id: "owner-terminated", status: clear ? "pass" : "blocked", detail: clear ? "The run and its local/agent execution owners are stopped." : "Execution is still owned by the run or an agent; stop it or reconcile ownership before promotion." };
}

function workspaceLockCheck(
  workspace: Readonly<typeof workspaces.$inferSelect>,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
): RecoveryReviewCheck {
  const owned = ownsWorkspaceLock(workspace, lockPrincipal(userId, orgId, teamId));
  return { id: "workspace-lock", status: owned ? "pass" : "blocked", detail: owned ? "The workspace lock is held by this caller." : "The workspace must be locked by this caller before promotion." };
}

function stateWriteCheck(canWrite: boolean): RecoveryReviewCheck {
  return { id: "state-write", status: canWrite ? "pass" : "blocked", detail: canWrite ? "The caller has state-write permission." : "The caller does not have state-write permission for this workspace." };
}

function buildRecoveryReviewChecks(args: {
  capture: RecoveryCapture;
  candidate: RecoveryCandidate;
  committed: CommittedRecoveryState;
  owner: RecoveryOwner;
  workspace: Readonly<typeof workspaces.$inferSelect>;
  userId: string | undefined;
  orgId: string | null;
  teamId: string | null;
  canWrite: boolean;
}): { checks: RecoveryReviewCheck[]; ownerClear: boolean; alreadyPromoted: boolean; promotionAllowed: boolean; blockers: string[] } {
  const checks: RecoveryReviewCheck[] = [
    captureCompleteCheck(args.capture),
    candidateParseCheck(args.capture),
    digestCheck(args.capture, args.candidate),
    lineageCheck(args.candidate, args.committed),
    serialCheck(args.candidate, args.committed),
    ownerTerminatedCheck(args.owner),
    workspaceLockCheck(args.workspace, args.userId, args.orgId, args.teamId),
    stateWriteCheck(args.canWrite),
  ];
  const blockers = checks.filter((check): boolean => check.status === "fail" || check.status === "blocked").map((check): string => check.detail);
  const alreadyPromoted = args.capture.status === "promoted" && args.capture.evidence?.promotedStateVersionId !== undefined;
  return {
    checks,
    ownerClear: isRecoveryOwnerClear(args.owner),
    alreadyPromoted,
    promotionAllowed: alreadyPromoted || (blockers.length === 0 && isRecoveryCandidate(args.capture)),
    blockers,
  };
}

function assembleRecoveryReview(args: {
  run: Readonly<typeof runs.$inferSelect>;
  capture: RecoveryCapture;
  candidate: RecoveryCandidate;
  committed: CommittedRecoveryState;
  owner: RecoveryOwner;
  recentLogs: RecoveryReviewData["recentLogs"];
  checks: RecoveryReviewCheck[];
  ownerClear: boolean;
  alreadyPromoted: boolean;
  promotionAllowed: boolean;
  blockers: string[];
}): Record<string, unknown> {
  const timestamps = args.run.statusTimestamps ?? {};
  return {
    "run": {
      id: args.run.id,
      status: args.run.status,
      operation: args.run.operation,
      "applying-at": timestamps["applying-at"] ?? null,
      "terminal-at": timestamps[`${args.run.status.replace(/_/g, "-")}-at`] ?? null,
      "agent-id": args.run.agentId,
      "agent-pool-id": args.run.agentPoolId,
    },
    "capture": {
      status: args.capture.status,
      "marker-present": args.capture.marker !== null,
      "captured-at": args.capture.capturedAt,
      "manifest-present": args.capture.evidence !== null,
      "promoted-state-version-id": args.capture.evidence?.promotedStateVersionId ?? null,
    },
    "candidate-state": args.candidate,
    "last-committed-state": args.committed,
    "checks": args.checks,
    "execution-owner": {
      "run-active": args.owner.runActive,
      "local-process-active": args.owner.localProcessActive,
      "agent-jobs": args.owner.agentJobs,
      "terminated": args.ownerClear,
    },
    "relevant-logs": [...args.recentLogs].reverse().map((entry): Record<string, unknown> => ({
      id: entry.id,
      phase: entry.phase,
      "created-at": new Date(entry.createdAt).toISOString(),
      excerpt: redactRecoveryLog(entry.outputText),
      truncated: entry.outputText.length > 4096,
    })),
    promotion: {
      allowed: args.promotionAllowed,
      "already-promoted": args.alreadyPromoted,
      blockers: args.blockers,
      "evidence-retention": "The captured bytes and promotion manifest are retained until the configured recovery retention sweep removes promoted evidence.",
    },
    "secret-warning": "State downloads and log excerpts may contain sensitive values. Back up them only in an approved secure location.",
  };
}

async function recoveryReviewFor(
  run: Readonly<typeof runs.$inferSelect>,
  workspace: Readonly<typeof workspaces.$inferSelect>,
  user: Readonly<typeof users.$inferSelect> | null | undefined,
  orgId: string | null,
  teamId: string | null,
): Promise<Record<string, unknown>> {
  const data = await fetchRecoveryReviewData(run, workspace, user?.id, orgId, teamId);
  const committed = data.latest === undefined ? null : stateMetadata(data.latest);
  const candidate = recoveryCandidateMetadata(data.capture);
  const summary = buildRecoveryReviewChecks({
    capture: data.capture,
    candidate,
    committed,
    owner: data.owner,
    workspace,
    userId: user?.id,
    orgId,
    teamId,
    canWrite: data.canWrite,
  });
  return assembleRecoveryReview({
    run,
    capture: data.capture,
    candidate,
    committed,
    owner: data.owner,
    recentLogs: data.recentLogs,
    checks: summary.checks,
    ownerClear: summary.ownerClear,
    alreadyPromoted: summary.alreadyPromoted,
    promotionAllowed: summary.promotionAllowed,
    blockers: summary.blockers,
  });
}

class StateVersionRejected extends Error {
  constructor(public status: number, public body: unknown) {
    super("state version rejected");
  }
}

type ParsedStateVersionRequest = {
  payload: Record<string, unknown>;
  data: Record<string, unknown> | undefined;
  attributes: Record<string, unknown>;
  expectedMd5: unknown;
  expectedLineage: unknown;
  inlineState: string | undefined;
  inlineJsonState: string | undefined;
  inlineJsonStateOutputs: string | undefined;
  requestedRunId: string | null;
  intermediate: boolean;
  serial: number | undefined;
};

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function parseStateVersionPayload(body: unknown): ParsedStateVersionRequest {
  const payload = objectField(body);
  const data = payload["data"] as Record<string, unknown> | undefined;
  const attributes = objectField(data?.["attributes"]);
  const rels = objectField(data?.["relationships"]);
  const runRel = objectField(rels["run"]);
  const runData = objectField(runRel["data"]);
  const inlineState = typeof attributes["state"] === "string" ? attributes["state"] : undefined;
  const inlineJsonState = typeof attributes["json-state"] === "string" ? attributes["json-state"] : undefined;
  const inlineJsonStateOutputs = typeof attributes["json-state-outputs"] === "string" ? attributes["json-state-outputs"] : undefined;
  const serial = typeof attributes["serial"] === "number" ? attributes["serial"] : undefined;
  return {
    payload,
    data,
    attributes,
    expectedMd5: attributes["md5"],
    expectedLineage: attributes["lineage"],
    inlineState,
    inlineJsonState,
    inlineJsonStateOutputs,
    requestedRunId: typeof runData["id"] === "string" ? runData["id"] : null,
    intermediate: attributes["intermediate"] === true,
    serial,
  };
}

function stateChecksumShapeError(expectedMd5: unknown, expectedLineage: unknown): string | null {
  if ((expectedMd5 !== undefined && (typeof expectedMd5 !== "string" || !/^(?:[a-fA-F0-9]{32}|[A-Za-z0-9+/]{22}==)$/.test(expectedMd5)))
    || (expectedLineage !== undefined && (typeof expectedLineage !== "string" || expectedLineage === ""))) {
    return "Invalid state checksum or lineage";
  }
  return null;
}

function decodeStateVersionBodies(
  inlineState: string | undefined,
  inlineJsonState: string | undefined,
  inlineJsonStateOutputs: string | undefined,
): { statePayload: string | null; jsonState: string | null; jsonStateOutputs: string | null } {
  const statePayload = inlineState !== undefined && inlineState !== "" ? decodeStatePayload(inlineState) : null;
  const jsonState = inlineJsonState !== undefined && inlineJsonState !== "" ? decodeStatePayload(inlineJsonState) : null;
  const jsonStateOutputs = inlineJsonStateOutputs !== undefined && inlineJsonStateOutputs !== ""
    ? decodeStatePayload(inlineJsonStateOutputs)
    : null;
  return { statePayload, jsonState, jsonStateOutputs };
}

async function resolveStateVersionWorkspace(
  workspaceId: string,
  run: ParamCtx["run"],
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
): Promise<typeof workspaces.$inferSelect> {
  const ws = run !== null && run.workspaceId === workspaceId
    ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
    : await findAuthorizedWorkspace(workspaceId, userId, orgId, teamId, "state-write");
  if (ws === undefined) {
    throw new StateVersionRejected(404, { errors: [{ status: "404", title: "Not Found" }] });
  }
  return ws;
}

function resolveStateVersionIdempotency(
  request: ParamCtx["request"],
  workspaceId: string,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
  payload: Record<string, unknown>,
  set: ParamCtx["set"],
): Exclude<ReturnType<typeof idempotencyContext>, "invalid"> {
  const idempotency = idempotencyContext(
    request,
    `state-versions:${workspaceId}`,
    idempotencyPrincipal({ userId, orgId, teamId }),
    payload,
    set,
  );
  if (idempotency === "invalid") {
    throw new StateVersionRejected(400, { errors: [{ status: "400", title: "Bad Request", detail: "Idempotency-Key must be between 1 and 255 characters" }] });
  }
  return idempotency;
}

function assertStateVersionCreatable(
  parsed: ParsedStateVersionRequest,
  run: ParamCtx["run"],
  orgId: string | null,
): void {
  if (parsed.data?.["type"] !== "state-versions") {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be state-versions" }] });
  }
  if (orgId !== null && orgId !== undefined) {
    throw new StateVersionRejected(403, { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot create state versions" }] });
  }
  const checksumError = stateChecksumShapeError(parsed.expectedMd5, parsed.expectedLineage);
  if (checksumError !== null) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: checksumError }] });
  }
  if (run !== null && parsed.requestedRunId !== null && parsed.requestedRunId !== run.runId) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "run must match the run-scoped credential" }] });
  }
}

function assertStateVersionSerial(serial: number | undefined): number {
  if (serial === undefined) {
    throw new StateVersionRejected(400, { errors: [{ status: "400", title: "Bad Request", detail: "param is missing or the value is empty: serial" }] });
  }
  if (!Number.isSafeInteger(serial) || serial < 0) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "serial must be a non-negative safe integer" }] });
  }
  return serial;
}

async function resolveStateVersionRun(runId: string | null, workspaceId: string): Promise<string | null> {
  if (runId === null) return null;
  const relatedRun = await db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { workspaceId: true, createdBy: true } });
  if (relatedRun?.workspaceId !== workspaceId) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "run must belong to this workspace" }] });
  }
  return relatedRun.createdBy;
}

function assertStateVersionWritable(
  run: ParamCtx["run"],
  ws: typeof workspaces.$inferSelect,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
  intermediate: boolean,
): void {
  if (run === null && (!ownsWorkspaceLock(ws, lockPrincipal(userId, orgId, teamId)))) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before writing state" }] });
  }
  // No locked-workspace rejection here: the reference format allows state uploads on locked
  // workspaces. The CLI holds the workspace lock for the whole
  // import/apply operation and uploads the state while still locked;
  // rejecting it breaks `terraform import`. Concurrent-writer protection
  // comes from the run-level lock and state serial numbers, not from
  // blocking the lock holder.
  if (intermediate && ws.locked !== true) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Intermediate state requires a locked workspace" }] });
  }
}

function assertStatePayloadMd5(statePayload: string | null, md5Attribute: unknown): void {
  if (statePayload === null) return;
  if (typeof md5Attribute !== "string") {
    throw new StateVersionRejected(400, { errors: [{ status: "400", title: "Bad Request", detail: "md5 is required when state is supplied" }] });
  }
  const expected = createHash("md5").update(statePayload).digest("base64");
  if (md5Attribute !== expected && md5Attribute.toLowerCase() !== createHash("md5").update(statePayload).digest("hex")) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "md5 does not match the state payload" }] });
  }
}

function parseAndAssertStatePayload(
  statePayload: string | null,
  expectedLineage: unknown,
  serial: number,
  md5Attribute: unknown,
): Record<string, unknown> | null {
  const parsedTerraformState = statePayload === null ? null : parseTerraformStatePayload(statePayload);
  if (statePayload !== null && parsedTerraformState === null) {
    throw new StateVersionRejected(400, { errors: [{ status: "400", title: "Bad Request", detail: statePayloadError(statePayload) }] });
  }
  if (parsedTerraformState !== null && expectedLineage !== undefined && parsedTerraformState["lineage"] !== expectedLineage) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "lineage does not match the state payload" }] });
  }
  if (parsedTerraformState !== null && parsedTerraformState["serial"] !== serial) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "serial does not match the Terraform state payload" }] });
  }
  assertStatePayloadMd5(statePayload, md5Attribute);
  return parsedTerraformState;
}

async function assertStateVersionAdvances(
  workspaceId: string,
  serial: number,
  parsedTerraformState: Record<string, unknown> | null,
  jsonState: string | null,
): Promise<void> {
  const latestState = await db.query.stateVersions.findFirst({
    where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
    orderBy: [desc(stateVersions.serial)],
    columns: { serial: true, statePayload: true },
  });
  if (latestState !== undefined && serial <= latestState.serial) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "State serial must advance the current workspace state" }] });
  }
  if (parsedTerraformState !== null) {
    const lineageError = stateLineageError(latestState, parsedTerraformState);
    if (lineageError !== null) {
      throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: lineageError }] });
    }
  }
  if (jsonState !== null && parseStatePayload(jsonState) === null) {
    throw new StateVersionRejected(400, { errors: [{ status: "400", title: "Bad Request", detail: "JSON state content must be valid JSON" }] });
  }
}

type InsertStateVersionArgs = {
  id: string;
  workspaceId: string;
  serial: number;
  expectedMd5: string | null;
  expectedLineage: string | null;
  statePayload: string | null;
  runId: string | null;
  jsonState: string | null;
  jsonStateOutputs: string | null;
  relatedRunCreatedBy: string | null;
  createdBy: string | null;
  intermediate: boolean;
  ws: typeof workspaces.$inferSelect;
};

async function insertStateVersionRecord(args: InsertStateVersionArgs): Promise<void> {
  const { id, workspaceId, serial, expectedMd5, expectedLineage, statePayload, runId, jsonState, jsonStateOutputs, relatedRunCreatedBy, createdBy, intermediate, ws } = args;
  try {
    await withStateSerialRetry(async () => db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      if (!(await fenceStateWorkspace(t, ws))) throw new StateSerialConflictError();
      await pruneStateReservations(t, ws);
      // Re-check inside the same transaction as the insert. This closes the
      // race between two writers that both observed the same latest serial,
      // and includes pending/intermediate rows hidden by the finalized-only
      // validation query above.
      const latestAny = await t.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, workspaceId),
        orderBy: [desc(stateVersions.serial)],
        columns: { serial: true },
      });
      if (latestAny !== undefined && serial <= latestAny.serial) throw new StateSerialConflictError();
      await t.insert(stateVersions).values({
        id,
        workspaceId,
        serial,
        expectedMd5,
        expectedLineage,
        uploadExpiresAt: statePayload === null ? Date.now() + STATE_UPLOAD_TTL_MS : null,
        uploadLock: statePayload === null ? stateUploadLock(ws) : null,
        uploadSha256: statePayload === null ? null : createHash("sha256").update(statePayload).digest("hex"),
        runId,
        statePayload: await encryptStatePayload(statePayload),
        jsonState: await encryptStatePayload(jsonState ?? statePayload),
        jsonStateOutputs: await encryptStatePayload(jsonStateOutputs),
        createdBy: relatedRunCreatedBy ?? createdBy,
        intermediate,
        status: statePayload === null ? "pending" : "finalized",
        createdAt: Date.now(),
      });
      await insertStateOutputIndex(t, id, workspaceId, jsonState, statePayload);
      await t.insert(auditLogs).values(auditLogValues({
        action: "create",
        resourceType: "state-version",
        resourceId: id,
        orgId: ws.orgId,
        userId: createdBy,
        details: {
          workspaceId,
          runId,
          serial,
          status: statePayload === null ? "pending" : "finalized",
          intermediate,
          stateBytes: statePayload === null ? 0 : Buffer.byteLength(statePayload, "utf8"),
        },
      }) as typeof auditLogs.$inferInsert);
    }));
  } catch (error: unknown) {
    if (error instanceof StateSerialConflictError || isUniqueConstraintError(error)) {
      throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "State serial must advance the current workspace state" }] });
    }
    throw error;
  }
}

async function completeStateVersionCreation(
  id: string,
  workspaceId: string,
  request: ParamCtx["request"],
  ws: typeof workspaces.$inferSelect,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
  set: ParamCtx["set"],
  idempotencyBegin: Awaited<ReturnType<typeof beginIdempotency>>,
): Promise<unknown> {
  scheduleExplorerInventory(workspaceId);
  const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) });
  if (sv === undefined) {
    throw new StateVersionRejected(404, { errors: [{ status: "404", title: "Not Found" }] });
  }
  (set as { status: number }).status = 201;
   const responseBody = { data: stateVersionResource(sv, request, false, undefined, await stateResponseAccess(ws, userId, orgId, teamId)) };
   if (idempotencyBegin.kind === "reserved") await completeIdempotency(idempotencyBegin.id, 201, responseBody, id);
   return responseBody;
}

type RecoveryCaptureFull = Awaited<ReturnType<typeof inspectRecoveryCopy>>;
type RecoverStateContext = Awaited<ReturnType<typeof requireRecoverStateContext>>;

async function requireRecoverStateContext(
  runId: string,
  user: ParamCtx["user"],
  orgId: string | null,
  teamId: string | null,
) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  const workspace = run === undefined ? undefined : await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId, teamId, "state-write");
  if (run === undefined || workspace === undefined) {
    throw new StateVersionRejected(404, { errors: [{ status: "404", title: "Not Found" }] });
  }
  if (orgId !== null && orgId !== undefined) {
    throw new StateVersionRejected(403, { errors: [{ status: "403", title: "Forbidden" }] });
  }
  return { run, workspace };
}

async function resolveRecoverCandidate(runId: string, workspace: RecoverStateContext["workspace"], request: Request) {
  const initialCapture = await inspectRecoveryCopy(storageDir, runId, true);
  if (initialCapture.status === "promoted" && initialCapture.evidence?.promotedStateVersionId !== undefined) {
    const existing = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.id, initialCapture.evidence.promotedStateVersionId), eq(stateVersions.workspaceId, workspace.id)),
    });
    if (existing !== undefined) {
      return { kind: "promoted" as const, status: 200, response: { data: stateVersionResource(existing, request), meta: { idempotent: true, evidenceRetained: true } } };
    }
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Recovery evidence says it was promoted, but the committed state version is unavailable" }] });
  }
  if (initialCapture.status === "incomplete" || initialCapture.status === "missing") {
    throw new StateVersionRejected(404, { errors: [{ status: "404", title: "Not Found" }] });
  }
  if (initialCapture.status === "opaque") {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unsupported state representation", detail: statePayloadError(initialCapture.payload ?? null) }] });
  }
  if (initialCapture.status !== "candidate" || initialCapture.payload === undefined) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: statePayloadError(initialCapture.payload ?? null) }] });
  }
  const parsed = parseTerraformStatePayload(initialCapture.payload);
  if (parsed === null) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: statePayloadError(initialCapture.payload) }] });
  }
  return { kind: "candidate" as const, capture: initialCapture, parsed };
}

async function requireRecoveryQuiesced(
  run: RecoverStateContext["run"],
  workspace: RecoverStateContext["workspace"],
  user: ParamCtx["user"],
  orgId: string | null,
  teamId: string | null,
): Promise<void> {
  const review = await recoveryReviewFor(run, workspace, user, orgId, teamId);
  const owner = review["execution-owner"] as Readonly<{ terminated?: unknown }> | undefined;
  if (owner?.terminated !== true) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "The run or its execution owner is still active; stop it or reconcile ownership before recovering state" }] });
  }
  const reviewChecks = Array.isArray(review["checks"]) ? review["checks"] as RecoveryReviewCheck[] : [];
  const failedReview = reviewChecks.find((check): boolean => check.status === "fail");
  if (failedReview !== undefined) {
    const status = failedReview.id === "lineage" || failedReview.id === "candidate-parse" || failedReview.id === "digest" ? 422 : 409;
    throw new StateVersionRejected(status, { errors: [{ status: String(status), title: "Recovery precondition failed", detail: failedReview.detail }] });
  }
  if (!ownsWorkspaceLock(workspace, lockPrincipal(user?.id, orgId, teamId))) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before recovering state" }] });
  }
}

async function resolvePromotedRecovery(
  capture: RecoveryCaptureFull,
  workspace: RecoverStateContext["workspace"],
): Promise<{ stateVersionId: string; committedSerial: number } | null> {
  if (capture.status !== "promoted" || capture.evidence?.promotedStateVersionId === undefined) return null;
  const existing = await db.query.stateVersions.findFirst({
    where: and(eq(stateVersions.id, capture.evidence.promotedStateVersionId), eq(stateVersions.workspaceId, workspace.id)),
  });
  if (existing === undefined) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Recovery evidence says it was promoted, but the committed state version is unavailable" }] });
  }
  return { stateVersionId: existing.id, committedSerial: existing.serial };
}

async function promoteRecoveryCapture(
  runId: string,
  run: RecoverStateContext["run"],
  workspace: RecoverStateContext["workspace"],
  userId: string | undefined,
): Promise<{ stateVersionId: string | null; committedSerial: number | null; idempotent: boolean }> {
  if (!(await acquireRecoveryPromotionLock(storageDir, runId))) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Another recovery promotion is already in progress" }] });
  }
  let stateVersionId: string | null = null;
  let committedSerial: number | null = null;
  let idempotent = false;
  try {
    const latestCapture = await inspectRecoveryCopy(storageDir, runId, true);
    const promoted = await resolvePromotedRecovery(latestCapture, workspace);
    if (promoted !== null) {
      stateVersionId = promoted.stateVersionId;
      committedSerial = promoted.committedSerial;
      idempotent = true;
    } else if (latestCapture.status !== "candidate" || latestCapture.payload === undefined) {
      throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "The recovery copy changed while it was being reviewed" }] });
    } else {
      const rawState = latestCapture.payload;
      const latestParsed = parseTerraformStatePayload(rawState);
      if (latestParsed === null) {
        throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: statePayloadError(rawState) }] });
      }
      stateVersionId = await withStateSerialRetry(async () => db.transaction(async (tx: unknown): Promise<string> => {
        const t = tx as typeof db;
        if (!(await fenceStateWorkspace(t, workspace))) throw new StateSerialConflictError();
        await pruneStateReservations(t, workspace);
        const current = await t.query.stateVersions.findFirst({
          where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized"), eq(stateVersions.intermediate, false)),
          orderBy: [desc(stateVersions.serial)],
        });
        const currentLineageError = stateLineageError(current, latestParsed);
        if (currentLineageError !== null) throw new StateSerialConflictError();
        const candidateSerial = latestParsed["serial"];
        const candidateDigest = createHash("sha256").update(rawState).digest("hex");
        let currentDigest: string | null = null;
        if (current?.statePayload !== null && current?.statePayload !== undefined && current.statePayload !== "") {
          try {
            currentDigest = createHash("sha256").update(decodeStatePayload(current.statePayload)).digest("hex");
          } catch {
            throw new StateSerialConflictError();
          }
        }
        if (typeof candidateSerial !== "number" || !Number.isSafeInteger(candidateSerial)
          || (current !== undefined && (candidateSerial < current.serial
            || (candidateSerial === current.serial && currentDigest !== candidateDigest)))) {
          throw new StateSerialConflictError();
        }
        const serial = await nextStateSerialTx(t, workspace.id);
        const promoted = statePayloadWithSerial(rawState, serial);
        const id = crypto.randomUUID();
        await commitStateVersionAtSerialTx(t, {
          id,
          workspaceId: workspace.id,
          serial,
          runId,
          uploadSha256: createHash("sha256").update(promoted).digest("hex"),
          statePayload: await encryptStatePayload(promoted),
          jsonState: await encryptStatePayload(promoted),
          jsonStateOutputs: await encryptStatePayload(latestParsed["outputs"] === undefined ? null : JSON.stringify(latestParsed["outputs"])),
          createdBy: run.createdBy,
          status: "finalized",
          terraformVersion: typeof latestParsed["terraform_version"] === "string" ? latestParsed["terraform_version"] : null,
          intermediate: false,
          createdAt: Date.now(),
        }, promoted, promoted);
        await t.insert(auditLogs).values(auditLogValues({
          action: "recover-state",
          resourceType: "state-version",
          resourceId: id,
          orgId: workspace.orgId,
          userId: userId ?? null,
          details: {
            runId,
            workspaceId: workspace.id,
            serial,
            previousSerial: current?.serial ?? null,
            before: { recoveryCapture: true },
            after: { status: "finalized", intermediate: false, serial },
          },
          immutable: true,
        }) as typeof auditLogs.$inferInsert);
        committedSerial = serial;
        return id;
      }));
    }
    if (stateVersionId !== null && committedSerial !== null) {
      // Keep the filesystem lock until the manifest is durable. This
      // closes the commit-to-marker window where a concurrent retry could
      // create a second state version from the same capture.
      await markRecoveryPromoted(storageDir, runId, stateVersionId, committedSerial);
    }
  } catch (error) {
    if (error instanceof StateVersionRejected) throw error;
    if (!(error instanceof StateSerialConflictError) && !isUniqueConstraintError(error)) throw error;
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Workspace lock or state changed before promotion" }] });
  } finally {
    await releaseRecoveryPromotionLock(storageDir, runId);
  }
  return { stateVersionId, committedSerial, idempotent };
}

type UploadWorkspace = Awaited<ReturnType<typeof resolveUploadWorkspace>>;

async function resolveUploadWorkspace(
  workspaceId: string,
  run: ParamCtx["run"],
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
) {
  const ws = run !== null && run.workspaceId === workspaceId
    ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
    : await findAuthorizedWorkspace(workspaceId, userId, orgId, teamId, "state-write");
  if (ws === undefined) {
    throw new StateVersionRejected(404, { errors: [{ status: "404", title: "Not Found" }] });
  }
  if (orgId !== null && orgId !== undefined) {
    throw new StateVersionRejected(403, { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot upload state" }] });
  }
  if (run === null && !ownsWorkspaceLock(ws, lockPrincipal(userId, orgId, teamId))) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before writing state" }] });
  }
  return ws;
}

async function readUploadState(body: unknown, request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORTED_STATE_BYTES) {
    throw new StateVersionRejected(413, { errors: [{ status: "413", title: "Payload Too Large", detail: "Terraform state exceeds the 100 MiB maximum" }] });
  }
  const rawStateResult = await requestBodyText(body, request);
  if (!rawStateResult.ok) {
    throw new StateVersionRejected(
      rawStateResult.reason === "too-large" ? 413 : 400,
      { errors: [{ status: String(rawStateResult.reason === "too-large" ? 413 : 400), title: rawStateResult.reason === "too-large" ? "Payload Too Large" : "Bad Request" }] },
    );
  }
  const rawState = rawStateResult.text;
  if (Buffer.byteLength(rawState, "utf8") > MAX_IMPORTED_STATE_BYTES) {
    throw new StateVersionRejected(413, { errors: [{ status: "413", title: "Payload Too Large", detail: "Terraform state exceeds the 100 MiB maximum" }] });
  }
  return rawState;
}

function parseUploadState(rawState: string): { parsed: NonNullable<ReturnType<typeof parseTerraformStatePayload>>; incomingSerial: number } {
  const parsed = parseTerraformStatePayload(rawState);
  if (parsed === null) {
    throw new StateVersionRejected(400, { errors: [{ status: "400", title: "Bad Request", detail: statePayloadError(rawState) }] });
  }
  // Migrating an existing state file into an empty workspace must accept
  // its serial as-is (issue #569): real-world files carry serials like 12
  // or 45, not 1. The record stores the payload serial so later uploads
  // and CLI round-trips increment naturally from it.
  const incomingSerial = parsed["serial"];
  if (typeof incomingSerial !== "number" || !Number.isInteger(incomingSerial) || incomingSerial <= 0) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "State serial must be a positive integer" }] });
  }
  return { parsed, incomingSerial };
}

function assertUploadMd5(request: Request, rawState: string): void {
  const contentMd5 = request.headers.get("content-md5");
  if (contentMd5 !== null && contentMd5 !== createHash("md5").update(rawState).digest("base64")) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Content-MD5 does not match the state payload" }] });
  }
}

async function assertUploadPreconditions(
  workspaceId: string,
  incomingSerial: number,
  parsed: NonNullable<ReturnType<typeof parseTerraformStatePayload>>,
  idempotencyBegin: Awaited<ReturnType<typeof beginIdempotency>>,
): Promise<void> {
  const latestImportedState = await db.query.stateVersions.findFirst({
    where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
    orderBy: [desc(stateVersions.serial)],
    columns: { serial: true, statePayload: true },
  });
  if (latestImportedState !== undefined && incomingSerial !== latestImportedState.serial + 1) {
    if (idempotencyBegin.kind === "reserved") await abandonIdempotency(idempotencyBegin.id);
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "serial must be the next workspace state serial" }] });
  }
  const lineageError = stateLineageError(latestImportedState, parsed);
  if (lineageError !== null) {
    if (idempotencyBegin.kind === "reserved") await abandonIdempotency(idempotencyBegin.id);
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: lineageError }] });
  }
}

async function commitUploadedState(args: {
  workspaceId: string;
  ws: UploadWorkspace;
  rawState: string;
  parsed: NonNullable<ReturnType<typeof parseTerraformStatePayload>>;
  incomingSerial: number;
  run: ParamCtx["run"];
  runCreatedBy: string | null;
  userId: string | undefined;
  idempotencyBegin: Awaited<ReturnType<typeof beginIdempotency>>;
}): Promise<string> {
  try {
    return await withStateSerialRetry(async () => db.transaction(async (tx: unknown): Promise<string> => {
      const t = tx as typeof db;
      const latest = await t.query.stateVersions.findFirst({
        where: and(eq(stateVersions.workspaceId, args.workspaceId), eq(stateVersions.status, "finalized")),
        orderBy: [desc(stateVersions.serial)],
      });
      // Race-safe serial assignment (issue #569): a concurrent first import
      // may have landed between the pre-check and this transaction. When a
      // latest exists, this payload must be its successor.
      if (latest !== undefined && args.incomingSerial !== latest.serial + 1) throw new StateSerialConflictError();
      const serial = latest === undefined ? args.incomingSerial : latest.serial + 1;
      const id = crypto.randomUUID();
      await t.insert(stateVersions).values({
        id,
        workspaceId: args.workspaceId,
        serial,
        uploadSha256: createHash("sha256").update(args.rawState).digest("hex"),
        statePayload: await encryptStatePayload(args.rawState),
        jsonState: await encryptStatePayload(args.rawState),
        jsonStateOutputs: await encryptStatePayload(args.parsed["outputs"] === undefined ? null : JSON.stringify(args.parsed["outputs"])),
        runId: args.run?.runId ?? null,
        createdBy: args.runCreatedBy ?? args.userId ?? null,
        status: "finalized",
        terraformVersion: typeof args.parsed["terraform_version"] === "string" ? args.parsed["terraform_version"] : null,
        intermediate: false,
        createdAt: Date.now(),
      });
      await insertStateOutputIndex(t, id, args.workspaceId, args.rawState, args.rawState);
      await t.insert(auditLogs).values(auditLogValues({
        action: "promote",
        resourceType: "state-version",
        resourceId: id,
        orgId: args.ws.orgId,
        userId: args.userId ?? null,
        details: {
          workspaceId: args.workspaceId,
          runId: args.run?.runId ?? null,
          serial,
          stateBytes: Buffer.byteLength(args.rawState, "utf8"),
          after: { status: "finalized", intermediate: false, serial },
        },
        immutable: true,
      }) as typeof auditLogs.$inferInsert);
      return id;
    }));
  } catch (error: unknown) {
    if (error instanceof StateSerialConflictError || isUniqueConstraintError(error)) {
      if (args.idempotencyBegin.kind === "reserved") await abandonIdempotency(args.idempotencyBegin.id);
      throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "State serial must advance the current workspace state" }] });
    }
    throw error;
  }
}

function buildStateVersionInsert(args: {
  id: string;
  workspaceId: string;
  serial: number;
  parsed: ReturnType<typeof parseStateVersionPayload>;
  bodies: ReturnType<typeof decodeStateVersionBodies>;
  runId: Parameters<typeof insertStateVersionRecord>[0]["runId"];
  relatedRunCreatedBy: Parameters<typeof insertStateVersionRecord>[0]["relatedRunCreatedBy"];
  userId: string | undefined;
  ws: Parameters<typeof insertStateVersionRecord>[0]["ws"];
}): Parameters<typeof insertStateVersionRecord>[0] {
  return {
    id: args.id,
    workspaceId: args.workspaceId,
    serial: args.serial,
    expectedMd5: typeof args.parsed.expectedMd5 === "string" ? args.parsed.expectedMd5 : null,
    expectedLineage: typeof args.parsed.expectedLineage === "string" ? args.parsed.expectedLineage : null,
    statePayload: args.bodies.statePayload,
    runId: args.runId,
    jsonState: args.bodies.jsonState,
    jsonStateOutputs: args.bodies.jsonStateOutputs,
    relatedRunCreatedBy: args.relatedRunCreatedBy,
    createdBy: args.relatedRunCreatedBy ?? args.userId ?? null,
    intermediate: args.parsed.intermediate,
    ws: args.ws,
  };
}

async function findUploadRunCreatedBy(run: ParamCtx["run"]): Promise<string | null> {
  if (run === null) return null;
  return (await db.query.runs.findFirst({ where: eq(runs.id, run.runId), columns: { createdBy: true } }))?.createdBy ?? null;
}

async function requireUploadedStateVersion(
  stateVersionId: string,
  idempotencyBegin: Awaited<ReturnType<typeof beginIdempotency>>,
) {
  const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
  if (sv === undefined) {
    if (idempotencyBegin.kind === "reserved") await abandonIdempotency(idempotencyBegin.id);
    throw new StateVersionRejected(500, { errors: [{ status: "500", title: "Internal Server Error" }] });
  }
  return sv;
}

type RollbackSource = Awaited<ReturnType<typeof resolveRollbackSource>>;

async function resolveRollbackWorkspace(
  workspaceId: string,
  userId: string | undefined,
  orgId: string | null,
  teamId: string | null,
) {
  const workspace = await findAuthorizedWorkspace(workspaceId, userId, orgId, teamId, "state-write");
  if (workspace === undefined) {
    throw new StateVersionRejected(404, { errors: [{ status: "404", title: "Not Found" }] });
  }
  if (orgId !== null && orgId !== undefined) {
    throw new StateVersionRejected(403, { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot roll back state" }] });
  }
  if (!ownsWorkspaceLock(workspace, lockPrincipal(userId, orgId, teamId))) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before rollback" }] });
  }
  return workspace;
}

function parseRollbackRequest(body: unknown): { payload: Record<string, unknown>; sourceId: string } {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = payload["data"] !== null && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : {};
  const relationships = data["relationships"] !== null && typeof data["relationships"] === "object" ? data["relationships"] as Record<string, unknown> : {};
  const rollback = relationships["rollback-state-version"];
  const rollbackData = rollback !== null && typeof rollback === "object" ? (rollback as Record<string, unknown>)["data"] : null;
  const sourceId = rollbackData !== null && typeof rollbackData === "object" && typeof (rollbackData as Record<string, unknown>)["id"] === "string" ? (rollbackData as Record<string, unknown>)["id"] as string : "";
  if (sourceId === "") {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: "rollback-state-version is required" }] });
  }
  return { payload, sourceId };
}

async function resolveRollbackSource(sourceId: string, workspaceId: string) {
  const source = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, sourceId) });
  if (source === undefined || source.workspaceId !== workspaceId || source.status !== "finalized" || source.statePayload === null) {
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "State version cannot be rolled back" }] });
  }
  const sourcePayload = decodeStatePayload(source.statePayload);
  const parsedSource = parseTerraformStatePayload(sourcePayload);
  if (parsedSource === null) {
    throw new StateVersionRejected(422, { errors: [{ status: "422", title: "Unprocessable Entity", detail: statePayloadError(sourcePayload) }] });
  }
  return { source, sourcePayload, parsedSource };
}

async function commitRollbackVersion(args: {
  workspaceId: string;
  workspace: Awaited<ReturnType<typeof resolveRollbackWorkspace>>;
  source: RollbackSource;
  userId: string | undefined;
  idempotencyBegin: Awaited<ReturnType<typeof beginIdempotency>>;
}): Promise<string> {
  const id = crypto.randomUUID();
  try {
    await withStateSerialRetry(async () => db.transaction(async (tx): Promise<void> => {
      if (!(await fenceStateWorkspace(tx, args.workspace))) throw new StateSerialConflictError();
      await pruneStateReservations(tx, args.workspace);
      const latest = await tx.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, args.workspaceId), orderBy: [desc(stateVersions.serial)] });
      const serial = (latest?.serial ?? 0) + 1;
      if (!Number.isSafeInteger(serial)) throw new StateSerialConflictError();
      const promoted = statePayloadWithSerial(args.source.sourcePayload, serial);
      await tx.insert(stateVersions).values({
        id,
        workspaceId: args.workspaceId,
        serial,
        uploadSha256: createHash("sha256").update(promoted).digest("hex"),
        statePayload: await encryptStatePayload(promoted),
        jsonState: await encryptStatePayload(promoted),
        jsonStateOutputs: await encryptStatePayload(JSON.stringify(args.source.parsedSource["outputs"] ?? {})),
        vcsCommitSha: args.source.source.vcsCommitSha,
        vcsCommitUrl: args.source.source.vcsCommitUrl,
        runId: null,
        createdBy: args.userId ?? null,
        terraformVersion: args.source.source.terraformVersion,
        intermediate: false,
        status: "finalized",
        createdAt: Date.now(),
      });
      await insertStateOutputIndex(tx, id, args.workspaceId,
        promoted, promoted);
    }));
  } catch (error) {
    if (!(error instanceof StateSerialConflictError) && !isUniqueConstraintError(error)) throw error;
    if (args.idempotencyBegin.kind === "reserved") await abandonIdempotency(args.idempotencyBegin.id);
    throw new StateVersionRejected(409, { errors: [{ status: "409", title: "Conflict", detail: "Workspace lock or state changed before promotion" }] });
  }
  return id;
}

export const stateVersionRoutes = new Elysia({ name: "stateVersions" })
  .use(authPlugin)
  .get("/api/v2/state-versions", async ({ request, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const url = new URL(request.url);
    const workspaceFilter = url.searchParams.get("filter[workspace][id]") || null;
    const runFilter = url.searchParams.get("filter[run][id]") || null;
    if ((user === null || user === undefined) && orgId === null && teamId === null) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    let candidateWorkspaces: { id: string; orgId: string }[];
    if (workspaceFilter !== null) {
      candidateWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.id, workspaceFilter), columns: { id: true, orgId: true } });
    } else {
      const teamOrg = teamId === null ? undefined : await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { orgId: true } });
      const principalOrgId = orgId ?? teamOrg?.orgId ?? null;
      const visibleOrgIds = principalOrgId !== null
        ? [principalOrgId]
        : user?.isSiteAdmin === true
          ? null
          : user === null || user === undefined
            ? []
            : (await db.query.organizationMemberships.findMany({ where: and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")), columns: { orgId: true } })).map((membership) => membership.orgId);
      candidateWorkspaces = visibleOrgIds === null
        ? await db.query.workspaces.findMany({ columns: { id: true, orgId: true } })
        : visibleOrgIds.length === 0
          ? []
          : await db.query.workspaces.findMany({ where: inArray(workspaces.orgId, visibleOrgIds), columns: { id: true, orgId: true } });
    }
    const allowedWorkspaceIds = new Set<string>();
    for (const org of new Set(candidateWorkspaces.map((workspace): string => workspace.orgId))) {
      const authorized = await workspaceIdsForPermission(org, user?.id, orgId, teamId, "state-read");
      if (authorized === null) {
        for (const workspace of candidateWorkspaces) if (workspace.orgId === org) allowedWorkspaceIds.add(workspace.id);
      } else {
        for (const workspaceId of authorized) allowedWorkspaceIds.add(workspaceId);
      }
    }
    if (allowedWorkspaceIds.size === 0) {
      const { number, size } = pageRequest(request);
      return { data: [], ...pagination(request, number, size, 0) };
    }
    // Issue #703: reservations are upload-in-progress handles, not history.
    // They stay reachable through the direct show endpoint the uploader
    // polls, but listings only ever return committed versions. The NULL arm
    // preserves legacy rows that predate the status column default.
    const conditions = [inArray(stateVersions.workspaceId, [...allowedWorkspaceIds]), or(isNull(stateVersions.status), ne(stateVersions.status, "pending"))];
    if (workspaceFilter !== null) conditions.push(eq(stateVersions.workspaceId, workspaceFilter));
    if (runFilter !== null) conditions.push(eq(stateVersions.runId, runFilter));
    const where = and(...conditions);
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.stateVersions.findMany({ where,
        columns: { statePayload: false, jsonState: false, jsonStateOutputs: false },
        extras: {
          hasRawState: sql<boolean>`${stateVersions.statePayload} IS NOT NULL AND ${stateVersions.statePayload} <> ''`.mapWith(Boolean).as("has_raw_state"),
          hasJsonState: sql<boolean>`${stateVersions.jsonState} IS NOT NULL AND ${stateVersions.jsonState} <> ''`.mapWith(Boolean).as("has_json_state"),
        }, orderBy: [desc(stateVersions.serial), desc(stateVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);
    const runIds = [...new Set(versions.map((version): string | null => version.runId).filter((id): id is string => id !== null))];
    const runRows = runIds.length === 0 ? [] : await db.query.runs.findMany({ where: inArray(runs.id, runIds), columns: { id: true, status: true, message: true } });
    const runMap = new Map(runRows.map((run): [string, { status: string; message: string | null }] => [run.id, { status: run.status, message: run.message }]));
    return {
      data: versions.map((version): Record<string, unknown> => stateVersionSummaryResource(version, request, version.runId === null ? null : runMap.get(version.runId) ?? null, authorizedStateAccess(version.workspaceId, "state-read"))),
      ...pagination(request, number, size, countRows[0]?.total ?? 0),
    };
  })
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
    ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
    : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    // Issue #703: see the index endpoint above; listings exclude pending
    // upload reservations (NULL statuses predate the default and stay listed).
    const where = and(eq(stateVersions.workspaceId, workspaceId), or(isNull(stateVersions.status), ne(stateVersions.status, "pending")));
    const [versions, countRows] = await Promise.all([
      db.query.stateVersions.findMany({ where,
        columns: { statePayload: false, jsonState: false, jsonStateOutputs: false },
        extras: {
          hasRawState: sql<boolean>`${stateVersions.statePayload} IS NOT NULL AND ${stateVersions.statePayload} <> ''`.mapWith(Boolean).as("has_raw_state"),
          hasJsonState: sql<boolean>`${stateVersions.jsonState} IS NOT NULL AND ${stateVersions.jsonState} <> ''`.mapWith(Boolean).as("has_json_state"),
        }, orderBy: [desc(stateVersions.serial)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    // Batch-fetch runs for state versions that have runId set
    const runIds = [...new Set(versions.map((sv): string | null => sv.runId).filter((id): id is string => id !== null))];
    const runMap = new Map<string, Readonly<{ status: string; message: string | null }>>();
    if (runIds.length > 0) {
      const runRows = await db.query.runs.findMany({
        where: inArray(runs.id, runIds),
        columns: { id: true, status: true, message: true },
      });
      for (const r of runRows) {
        runMap.set(r.id, { status: r.status, message: r.message });
      }
    }
    return {
      data: versions.map((sv): Record<string, unknown> =>
        stateVersionSummaryResource(sv, request, sv.runId !== null ? (runMap.get(sv.runId) ?? null) : null, authorizedStateAccess(sv.workspaceId, "state-read")),
      ),
      ...pagination(request, number, size, totalCount),
    };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
      : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-read");
    // Remote-state consumer grant: a run in another workspace may read this
    // workspace's current state when a consumer link / project / global grant
    // exists (the reference format remote-state sharing). Denied reads fall through to 404.
    const resolvedWs = ws === undefined && run !== null
      ? await findRemoteStateReadableWorkspace(workspaceId, run.workspaceId)
      : ws;
    if (resolvedWs === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const runData = sv.runId !== null
      ? await db.query.runs.findFirst({ where: eq(runs.id, sv.runId), columns: { status: true, message: true } })
      : null;
    return { data: stateVersionResource(sv, request, true, runData ?? null, authorizedStateAccess(resolvedWs.id, "state-read")) };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version-outputs", async ({ params, user, orgId, teamId, run, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
      : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-outputs");
    // Remote-state consumer grant (see current-state-version above).
    const resolvedWs = ws === undefined && run !== null
      ? await findRemoteStateReadableWorkspace(workspaceId, run.workspaceId)
      : ws;
    if (resolvedWs === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (isClientEncryptedState(sv.statePayload)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unsupported state representation", detail: statePayloadError(sv.statePayload) }] };
    }
    return { data: stateOutputResources(sv) };
  })
  .patch("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    try {
      const workspace = await resolveRollbackWorkspace(workspaceId, user?.id, orgId, teamId);
      const { payload, sourceId } = parseRollbackRequest(body);
      const idempotency = idempotencyContext(
        request,
        `state-rollback:${workspaceId}`,
        idempotencyPrincipal({ userId: user?.id, orgId, teamId }),
        payload,
        set,
      );
      if (idempotency === "invalid") {
        return { errors: [{ status: "400", title: "Bad Request", detail: "Idempotency-Key must be between 1 and 255 characters" }] };
      }
      const source = await resolveRollbackSource(sourceId, workspaceId);
      const idempotencyBegin = await beginIdempotency(
        idempotency,
        "state-rollback",
        set,
      );
      if (idempotencyBegin.kind === "replay") return await replayStateVersion(idempotencyBegin.resourceId, workspaceId, request, idempotencyBegin.body);
      if (idempotencyBegin.kind === "error") return idempotencyError(idempotencyBegin);
      const id = await commitRollbackVersion({
        workspaceId,
        workspace,
        source,
        userId: user?.id,
        idempotencyBegin,
      });
      scheduleExplorerInventory(workspaceId);
      const created = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) });
      if (created === undefined) {
        if (idempotencyBegin.kind === "reserved") await abandonIdempotency(idempotencyBegin.id);
        (set as { status: number }).status = 500;
        return { errors: [{ status: "500", title: "Internal Server Error" }] };
      }
      (set as { status: number }).status = 201;
      const responseBody = { data: stateVersionResource(created, request, false, undefined, await stateResponseAccess(workspace, user?.id, orgId, teamId)) };
      if (idempotencyBegin.kind === "reserved") await completeIdempotency(idempotencyBegin.id, 201, responseBody, id);
      return responseBody;
    } catch (error: unknown) {
      if (error instanceof StateVersionRejected) {
        (set as { status: number }).status = error.status;
        return error.body;
      }
      throw error;
    }
  })
  .get("/api/v2/state-versions/:state_version_id", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const runScoped = run !== undefined && run !== null && ws !== undefined && checkRunStateAccess(run, ws.id);
    if (ws === undefined || (!runScoped && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const runData = sv.runId !== null
      ? await db.query.runs.findFirst({ where: eq(runs.id, sv.runId), columns: { status: true, message: true } })
      : null;
    return { data: stateVersionResource(sv, request, true, runData ?? null, authorizedStateAccess(ws?.id ?? sv.workspaceId, "state-read")) };
  })
  .get("/api/v2/state-versions/:state_version_id/state-version-outputs", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null && run === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || (!(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs")) && !checkRunStateAccess(run, ws.id))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (isClientEncryptedState(sv.statePayload)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unsupported state representation", detail: statePayloadError(sv.statePayload) }] };
    }
    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(sv);
    const sliced = outputs.slice((number - 1) * size, number * size);
    return { data: sliced, ...pagination(request, number, size, outputs.length) };
  })
  .get("/api/v2/state-versions/:state_version_id/outputs", async ({ params, user, orgId, teamId, run, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null && run === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || (!(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs")) && !checkRunStateAccess(run, ws.id))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (isClientEncryptedState(sv.statePayload)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unsupported state representation", detail: statePayloadError(sv.statePayload) }] };
    }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-version-outputs/:state_version_output_id", async ({ params, user, orgId, teamId, run, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null && run === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionOutputId = params["state_version_output_id"] ?? "";
    if (!/^wsout-[a-f0-9]{64}$/.test(stateVersionOutputId)) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const indexed = await db.query.stateOutputIndex.findFirst({ where: eq(stateOutputIndex.outputId, stateVersionOutputId) });
    if (indexed !== undefined) {
      const [stateVersion, ws] = await Promise.all([
        db.query.stateVersions.findFirst({ where: eq(stateVersions.id, indexed.stateVersionId) }),
        db.query.workspaces.findFirst({ where: eq(workspaces.id, indexed.workspaceId) }),
      ]);
      if (stateVersion !== undefined && ws !== undefined && !["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(stateVersion.status ?? "")
        && (await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs") || checkRunStateAccess(run, ws.id))) {
        const output = stateOutputResources(stateVersion).find(({ id }): boolean => id === stateVersionOutputId);
        if (output !== undefined) return { data: output };
      }
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // The index is authoritative for new rows. Keep pre-index state reachable
    // through a bounded compatibility probe, but never load or parse an
    // unbounded portion of the instance's state history for a miss.
    const legacyCandidates = await db.query.stateVersions.findMany({
      columns: { id: true, workspaceId: true, status: true },
      orderBy: [desc(stateVersions.createdAt), desc(stateVersions.serial)],
      limit: MAX_LEGACY_STATE_OUTPUT_CANDIDATES,
    });
    if (legacyCandidates.length === 0) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const legacyWorkspaceIds = [...new Set(legacyCandidates.map((candidate): string => candidate.workspaceId))];
    const legacyWorkspaces = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, legacyWorkspaceIds),
    });
    const authorizedWorkspaceIds = new Set<string>();
    for (const ws of legacyWorkspaces) {
      if (await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs") || checkRunStateAccess(run, ws.id)) {
        authorizedWorkspaceIds.add(ws.id);
      }
    }
    for (const candidate of legacyCandidates) {
      if (!authorizedWorkspaceIds.has(candidate.workspaceId)
        || ["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(candidate.status ?? "")) continue;
      // Fetch one authorized payload at a time so a bounded candidate set
      // cannot retain many potentially large state documents simultaneously.
      const stateVersion = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, candidate.id) });
      if (stateVersion === undefined
        || ["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(stateVersion.status ?? "")) continue;
      const output = stateOutputResources(stateVersion).find(({ id }): boolean => id === stateVersionOutputId);
      if (output !== undefined) return { data: output };
    }
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found" }] };
  })
  .get("/api/v2/state-versions/:state_version_id/json-download", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/json-download`;
    if (ws === undefined || (!validSignedApiURL(request, path) && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")) && !checkRunStateAccess(run, ws.id))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (
      typeof sv.jsonState !== "string"
      || sv.jsonState === ""
      || ["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")
    ) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (isClientEncryptedState(sv.statePayload)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unsupported state representation", detail: statePayloadError(sv.statePayload) }] };
    }
    (set.headers as Record<string, string>)["Content-Type"] = "application/json";
    await auditLog("read", "state-version", stateVersionId, user?.id ?? null, ws.orgId, {
      workspaceId: sv.workspaceId,
      endpoint: "json-download",
      stateVersionSerial: sv.serial,
    });
    return decodeStatePayload(sv.jsonState);
  })
  .delete("/api/v2/state-versions/:state_version_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (sv.status === "pending" && sv.statePayload === null) {
      const discarded = await db.transaction(async (tx) => discardStateReservation(tx as typeof db, sv, ws, "discarded"));
      if (!discarded) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "State upload completed while discarding its reservation" }] };
      }
    } else {
      await db.update(stateVersions).set({ status: "discarded", softDeletedAt: null }).where(eq(stateVersions.id, stateVersionId));
    }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/download`;
    if (ws === undefined || (!validSignedApiURL(request, path) && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")) && !checkRunStateAccess(run, ws.id))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (
      typeof sv.statePayload !== "string"
      || sv.statePayload === ""
      || ["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")
    ) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = decodeStatePayload(sv.statePayload);
    (set.headers as Record<string, string>)["Content-Type"] = "application/json";
    await auditLog("read", "state-version", stateVersionId, user?.id ?? null, ws.orgId, {
      workspaceId: sv.workspaceId,
      endpoint: "download",
      stateVersionSerial: sv.serial,
    });
    return payload;
  })
  .put("/api/v2/state-versions/:state_version_id/upload", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/upload`;
    if (ws === undefined || (!validSignedApiURL(request, path, "PUT") && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // Issue #578: claim before the network-bound body transfer so two
    // simultaneous PUTs do not both stream bodies. The domain command below
    // remains the cross-process atomic backstop.
    if (!tryAcquireStateUpload(stateVersionId)) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "An upload for this state version is already in progress" }] };
    }
    try {
      const rawStateResult = await requestBodyText(body, request);
      if (!rawStateResult.ok) {
        const status = rawStateResult.reason === "too-large" ? 413 : 400;
        (set as { status: number }).status = status;
        const title = sv.status === "finalized" && typeof sv.statePayload === "string" && sv.statePayload !== ""
          ? "Invalid state upload body"
          : status === 413 ? "Payload Too Large" : "Bad Request";
        return { errors: [{ status: String(status), title }] };
      }
      const rawState = rawStateResult.text;
      const committed = await commitStateVersion({ stateVersionId, rawState });
      if (committed.kind === "not-found") {
        (set as { status: number }).status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
      }
      if (committed.kind === "invalid") {
        const status = committed.reason === "state-payload" ? 400 : 422;
        (set as { status: number }).status = status;
        return { errors: [{ status: String(status), title: status === 400 ? "Bad Request" : "Unprocessable Entity", detail: committed.detail }] };
      }
      if (committed.kind === "conflict") {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: committed.detail }] };
      }
      if (committed.kind === "committed") scheduleExplorerInventory(sv.workspaceId);
      (set as { status: number }).status = 200;
      return {};
    } finally {
      releaseStateUpload(stateVersionId);
    }
  })
  .put("/api/v2/state-versions/:state_version_id/json-upload", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/json-upload`;
    if (ws === undefined || (!validSignedApiURL(request, path, "PUT") && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (typeof sv.jsonState === "string" && sv.jsonState !== "") {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "JSON state content was already uploaded" }] };
    }
    if (sv.status === "pending" && stateReservationObsolete(sv, ws)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "State upload reservation expired or its workspace lock changed" }] };
    }
    if (!tryAcquireStateUpload(stateVersionId)) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "An upload for this state version is already in progress" }] };
    }
    try {
      const jsonStateResult = await requestBodyText(body, request);
      if (!jsonStateResult.ok) {
        (set as { status: number }).status = jsonStateResult.reason === "too-large" ? 413 : 400;
        return { errors: [{ status: String(jsonStateResult.reason === "too-large" ? 413 : 400), title: jsonStateResult.reason === "too-large" ? "Payload Too Large" : "Bad Request" }] };
      }
      const jsonState = jsonStateResult.text;
      if (jsonState === "" || parseStatePayload(jsonState) === null) {
        (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "JSON state content must be valid JSON" }] };
      }
      const encrypted = await encryptStatePayload(jsonState);
      // Issue #578: atomic conditional write plus index rebuild in one
      // transaction, so concurrent PUTs cannot both win or mix index rows.
      const uploaded = await db.transaction(async (tx): Promise<boolean> => {
        if (sv.status === "pending" && (!(await fenceStateWorkspace(tx, ws)) || stateReservationObsolete(sv, ws))) return false;
        const won = await tx.update(stateVersions).set({ jsonState: encrypted }).where(and(
          eq(stateVersions.id, stateVersionId),
          inArray(stateVersions.status, ["pending", "finalized"]),
          or(isNull(stateVersions.jsonState), eq(stateVersions.jsonState, "")),
        )).returning({ id: stateVersions.id, status: stateVersions.status, statePayload: stateVersions.statePayload });
        const row = won[0];
        if (row === undefined) return false;
        if (row.status === "finalized") {
          await replaceStateOutputIndex(tx, stateVersionId, sv.workspaceId,
            jsonState, row.statePayload === null ? null : decodeStatePayload(row.statePayload));
        }
        return true;
      });
      if (!uploaded) {
        (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "JSON state content was already uploaded" }] };
      }
      scheduleExplorerInventory(sv.workspaceId);
      (set as { status: number }).status = 200;
      return {};
    } finally {
      releaseStateUpload(stateVersionId);
    }
  })
  .put("/api/v2/state-versions/:state_version_id/json-outputs-upload", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/json-outputs-upload`;
    if (ws === undefined || (!validSignedApiURL(request, path, "PUT") && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // Issue #578: outputs are single-shot on a pending version. Rewriting a
    // finalized version would silently mutate immutable history (and the old
    // code appended those rows to the output index). The blob remains
    // readable as an MCP fallback once set.
    if (typeof sv.jsonStateOutputs === "string" && sv.jsonStateOutputs !== "") {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "JSON state outputs were already uploaded" }] };
    }
    if (sv.status === "finalized") {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "State version is finalized; outputs can no longer be uploaded" }] };
    }
    if (sv.status === "pending" && stateReservationObsolete(sv, ws)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "State upload reservation expired or its workspace lock changed" }] };
    }
    if (!tryAcquireStateUpload(stateVersionId)) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "An upload for this state version is already in progress" }] };
    }
    try {
      const jsonStateOutputsResult = await requestBodyText(body, request);
      if (!jsonStateOutputsResult.ok) {
        (set as { status: number }).status = jsonStateOutputsResult.reason === "too-large" ? 413 : 400;
        return { errors: [{ status: String(jsonStateOutputsResult.reason === "too-large" ? 413 : 400), title: jsonStateOutputsResult.reason === "too-large" ? "Payload Too Large" : "Bad Request" }] };
      }
      const jsonStateOutputs = jsonStateOutputsResult.text;
      if (jsonStateOutputs === "" || parseStatePayload(jsonStateOutputs) === null) {
        (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "JSON state outputs must be valid JSON" }] };
      }
      const encrypted = await encryptStatePayload(jsonStateOutputs);
      const uploaded = await db.transaction(async (tx) => {
        if (!(await fenceStateWorkspace(tx, ws)) || stateReservationObsolete(sv, ws)) return [];
        return tx.update(stateVersions).set({ jsonStateOutputs: encrypted }).where(and(
          eq(stateVersions.id, stateVersionId),
          eq(stateVersions.status, "pending"),
          or(isNull(stateVersions.jsonStateOutputs), eq(stateVersions.jsonStateOutputs, "")),
        )).returning({ id: stateVersions.id });
      });
      if (uploaded.length === 0) {
        (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "JSON state outputs were already uploaded" }] };
      }
      scheduleExplorerInventory(sv.workspaceId);
      (set as { status: number }).status = 200;
      return {};
    } finally {
      releaseStateUpload(stateVersionId);
    }
  })
  .post("/api/v2/state-versions/:state_version_id/actions/rollback", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot roll back state" }] }; }
    if (!ownsWorkspaceLock(ws, lockPrincipal(user?.id, orgId, teamId))) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before rollback" }] }; }
    const idempotency = idempotencyContext(
      request,
      `state-action-rollback:${stateVersionId}`,
      idempotencyPrincipal({ userId: user?.id, orgId, teamId }),
      {},
      set as unknown as { status?: number | string; headers: Record<string, string | number> },
    );
    if (idempotency === "invalid") {
      return { errors: [{ status: "400", title: "Bad Request", detail: "Idempotency-Key must be between 1 and 255 characters" }] };
    }
    if (sv.statePayload === null || sv.status !== "finalized") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "State version cannot be rolled back" }] };
    }
    const sourcePayload = decodeStatePayload(sv.statePayload);
    const parsedSource = parseTerraformStatePayload(sourcePayload);
    if (parsedSource === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: statePayloadError(sourcePayload) }] };
    }
    const idempotencyBegin = await beginIdempotency(
      idempotency,
      "state-action-rollback",
      set as unknown as { status?: number | string; headers: Record<string, string | number> },
    );
    if (idempotencyBegin.kind === "replay") return replayStateVersion(idempotencyBegin.resourceId, sv.workspaceId, request, idempotencyBegin.body);
    if (idempotencyBegin.kind === "error") return idempotencyError(idempotencyBegin);
    const newId = crypto.randomUUID();
    try {
      await withStateSerialRetry(async () => db.transaction(async (tx): Promise<void> => {
        if (!(await fenceStateWorkspace(tx, ws))) throw new StateSerialConflictError();
        await pruneStateReservations(tx, ws);
        const latest = await tx.query.stateVersions.findFirst({
          where: eq(stateVersions.workspaceId, sv.workspaceId),
          orderBy: [desc(stateVersions.serial)],
        });
        const serial = (latest?.serial ?? 0) + 1;
        if (!Number.isSafeInteger(serial)) throw new StateSerialConflictError();
        const promoted = statePayloadWithSerial(sourcePayload, serial);
        await tx.insert(stateVersions).values({
          id: newId,
          workspaceId: sv.workspaceId,
          serial,
          runId: null,
          createdBy: user?.id ?? null,
          uploadSha256: createHash("sha256").update(promoted).digest("hex"),
          statePayload: await encryptStatePayload(promoted),
          jsonState: await encryptStatePayload(promoted),
          jsonStateOutputs: await encryptStatePayload(JSON.stringify(parsedSource["outputs"] ?? {})),
          vcsCommitSha: sv.vcsCommitSha,
          vcsCommitUrl: sv.vcsCommitUrl,
          terraformVersion: sv.terraformVersion,
          intermediate: false,
          status: "finalized",
          createdAt: Date.now(),
        });
        await insertStateOutputIndex(tx, newId, sv.workspaceId,
          promoted, promoted);
      }));
    } catch (error) {
      if (!(error instanceof StateSerialConflictError) && !isUniqueConstraintError(error)) throw error;
      if (idempotencyBegin.kind === "reserved") await abandonIdempotency(idempotencyBegin.id);
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace lock or state changed before promotion" }] };
    }
    scheduleExplorerInventory(sv.workspaceId);
    const newSv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, newId) });
    if (newSv === undefined) {
      if (idempotencyBegin.kind === "reserved") await abandonIdempotency(idempotencyBegin.id);
      (set as { status: number }).status = 500;
      return { errors: [{ status: "500", title: "Internal Server Error" }] };
    }
    (set as { status: number }).status = 201;
     const responseBody = { data: stateVersionResource(newSv, request, false, undefined, await stateResponseAccess(ws, user?.id, orgId, teamId)) };
     if (idempotencyBegin.kind === "reserved") await completeIdempotency(idempotencyBegin.id, 201, responseBody, newId);
     return responseBody;
  })
  .post("/api/v2/state-versions/:state_version_id/actions/soft_delete_backing_data", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const current = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, sv.workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
      columns: { id: true },
    });
    if (sv.status !== "finalized" || current?.id === sv.id) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    const softDeletedAt = Date.now();
    await db.update(stateVersions).set({ status: "backing_data_soft_deleted", softDeletedAt }).where(eq(stateVersions.id, sv.id));
    return { data: stateVersionResource({ ...sv, status: "backing_data_soft_deleted", softDeletedAt }, request, false, undefined, authorizedStateAccess(ws.id, "admin")) };
  })
  .post("/api/v2/state-versions/:state_version_id/actions/restore_backing_data", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (sv.status !== "backing_data_soft_deleted") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    await db.update(stateVersions).set({ status: "finalized", softDeletedAt: null }).where(eq(stateVersions.id, sv.id));
    scheduleExplorerInventory(sv.workspaceId);
    return { data: stateVersionResource({ ...sv, status: "finalized", softDeletedAt: null }, request, false, undefined, authorizedStateAccess(ws.id, "admin")) };
  })
  .post("/api/v2/state-versions/:state_version_id/actions/permanently_delete_backing_data", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (sv.status !== "backing_data_soft_deleted") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    const deleted = await db.update(stateVersions).set({
      status: "backing_data_permanently_deleted",
      statePayload: null,
      jsonState: null,
      jsonStateOutputs: null,
    }).where(and(
      eq(stateVersions.id, sv.id),
      eq(stateVersions.status, "backing_data_soft_deleted"),
    )).returning({ id: stateVersions.id });
    if (deleted.length === 0) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
    }
    return {
      data: stateVersionResource({
        ...sv,
        status: "backing_data_permanently_deleted",
        statePayload: null,
        jsonState: null,
        jsonStateOutputs: null,
      }, request, false, undefined, authorizedStateAccess(ws.id, "admin")),
    };
  })
  .get("/api/v2/runs/:run_id/recovery", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    const workspace = run === undefined ? undefined : await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId, teamId, "admin");
    if (run === undefined || workspace === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const review = await recoveryReviewFor(run, workspace, user, orgId, teamId);
    await auditLog("read", "run", runId, user?.id ?? null, workspace.orgId, { endpoint: "recovery-workbench", candidateStatus: review["capture"] && typeof review["capture"] === "object" ? (review["capture"] as Record<string, unknown>)["status"] : null });
    return {
      data: {
        id: runId,
        type: "recovery-reviews",
        attributes: review,
        relationships: {
          run: { data: { id: runId, type: "runs" } },
          candidate: { data: { id: "recovery-candidate", type: "state-versions" } },
        },
        links: { self: `/api/v2/runs/${runId}/recovery` },
      },
    };
  })
  // Alias kept for clients that name the surface after the UI rather than the
  // run resource. Both paths return exactly the same bounded review.
  .get("/api/v2/runs/:run_id/recovery-workbench", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    const workspace = run === undefined ? undefined : await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId, teamId, "admin");
    if (run === undefined || workspace === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const review = await recoveryReviewFor(run, workspace, user, orgId, teamId);
    await auditLog("read", "run", runId, user?.id ?? null, workspace.orgId, { endpoint: "recovery-workbench", candidateStatus: review["capture"] && typeof review["capture"] === "object" ? (review["capture"] as Record<string, unknown>)["status"] : null });
    return {
      data: {
        id: runId,
        type: "recovery-reviews",
        attributes: review,
        relationships: {
          run: { data: { id: runId, type: "runs" } },
          candidate: { data: { id: "recovery-candidate", type: "state-versions" } },
        },
        links: { self: `/api/v2/runs/${runId}/recovery-workbench` },
      },
    };
  })
  .get("/api/v2/runs/:run_id/recovery-state", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    const workspace = run === undefined ? undefined : await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId, teamId, "admin");
    if (run === undefined || workspace === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    let payload: string;
    try {
      const capture = await inspectRecoveryCopy(storageDir, runId, true);
      if (capture.status !== "candidate" && capture.status !== "opaque" && capture.status !== "promoted") throw new Error("recovery capture incomplete");
      if (capture.payload === undefined) throw new Error("recovery payload unavailable");
      payload = capture.payload;
    } catch {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await auditLog("read", "state-version", runId, user?.id ?? null, workspace.orgId, {
      workspaceId: workspace.id,
      endpoint: "recovery-state",
    });
    return new Response(payload, { headers: { "Content-Type": "application/json" } });
  })
  .post("/api/v2/runs/:run_id/actions/recover-state", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    try {
      const { run, workspace } = await requireRecoverStateContext(runId, user, orgId, teamId);
      const candidate = await resolveRecoverCandidate(runId, workspace, request);
      if (candidate.kind === "promoted") {
        (set as { status: number }).status = candidate.status;
        return candidate.response;
      }
      await requireRecoveryQuiesced(run, workspace, user, orgId, teamId);
      const promotion = await promoteRecoveryCapture(runId, run, workspace, user?.id);
      if (promotion.stateVersionId === null || promotion.committedSerial === null) {
        (set as { status: number }).status = 500;
        return { errors: [{ status: "500", title: "Internal Server Error" }] };
      }
      const stateVersion = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, promotion.stateVersionId) });
      if (stateVersion === undefined) {
        (set as { status: number }).status = 500;
        return { errors: [{ status: "500", title: "Internal Server Error" }] };
      }
      scheduleExplorerInventory(workspace.id);
      (set as { status: number }).status = promotion.idempotent ? 200 : 201;
      return {
        data: stateVersionResource(stateVersion, request, false, undefined, authorizedStateAccess(workspace.id, "admin")),
        ...(promotion.idempotent ? { meta: { idempotent: true, evidenceRetained: true } } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof StateVersionRejected) {
        (set as { status: number }).status = error.status;
        return error.body;
      }
      throw error;
    }
  })

  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, body, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    let idempotencyBegin: Awaited<ReturnType<typeof beginIdempotency>> | undefined;
    try {
      const ws = await resolveStateVersionWorkspace(workspaceId, run, user?.id, orgId, teamId);
      const parsed = parseStateVersionPayload(body);
      const idempotency = resolveStateVersionIdempotency(request, workspaceId, user?.id, orgId, teamId, parsed.payload, set);
      assertStateVersionCreatable(parsed, run, orgId);
      const bodies = decodeStateVersionBodies(parsed.inlineState, parsed.inlineJsonState, parsed.inlineJsonStateOutputs);
      const runId = run?.runId ?? parsed.requestedRunId;
      const relatedRunCreatedBy = await resolveStateVersionRun(runId, workspaceId);
      const serial = assertStateVersionSerial(parsed.serial);
      assertStateVersionWritable(run, ws, user?.id, orgId, teamId, parsed.intermediate);
      const parsedTerraformState = parseAndAssertStatePayload(bodies.statePayload, parsed.expectedLineage, serial, parsed.attributes["md5"]);
      idempotencyBegin = await beginIdempotency(
        idempotency,
        "state-versions",
        set,
      );
      if (idempotencyBegin.kind === "replay") return await replayStateVersion(idempotencyBegin.resourceId, workspaceId, request, idempotencyBegin.body);
      if (idempotencyBegin.kind === "error") return idempotencyError(idempotencyBegin);
      await assertStateVersionAdvances(workspaceId, serial, parsedTerraformState, bodies.jsonState);
      const id = crypto.randomUUID();
      await insertStateVersionRecord(buildStateVersionInsert({
        id,
        workspaceId,
        serial,
        parsed,
        bodies,
        runId,
        relatedRunCreatedBy,
        userId: user?.id,
        ws,
      }));
      return await completeStateVersionCreation(id, workspaceId, request, ws, user?.id, orgId, teamId, set, idempotencyBegin);
    } catch (error: unknown) {
      if (error instanceof StateVersionRejected) {
        if (idempotencyBegin?.kind === "reserved") await abandonIdempotency(idempotencyBegin.id);
        (set as { status: number }).status = error.status;
        return error.body;
      }
      throw error;
    }
  })
  .post("/api/v2/workspaces/:workspace_id/state-versions/upload", async ({ params, body, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    try {
      const ws = await resolveUploadWorkspace(workspaceId, run, user?.id, orgId, teamId);
      const rawState = await readUploadState(body, request);
      const { parsed, incomingSerial } = parseUploadState(rawState);
      assertUploadMd5(request, rawState);
      const contentMd5 = request.headers.get("content-md5");
      const idempotency = idempotencyContext(
        request,
        `state-versions-upload:${workspaceId}`,
        idempotencyPrincipal({ userId: user?.id, orgId, teamId, runId: run?.runId }),
        { rawState, contentMd5 },
        set,
      );
      if (idempotency === "invalid") {
        return { errors: [{ status: "400", title: "Bad Request", detail: "Idempotency-Key must be between 1 and 255 characters" }] };
      }
      const idempotencyBegin = await beginIdempotency(
        idempotency,
        "state-versions-upload",
        set,
      );
      if (idempotencyBegin.kind === "replay") return await replayStateVersion(idempotencyBegin.resourceId, workspaceId, request, idempotencyBegin.body);
      if (idempotencyBegin.kind === "error") return idempotencyError(idempotencyBegin);

      await assertUploadPreconditions(workspaceId, incomingSerial, parsed, idempotencyBegin);
      const runCreatedBy = await findUploadRunCreatedBy(run);

      const stateVersionId = await commitUploadedState({
        workspaceId,
        ws,
        rawState,
        parsed,
        incomingSerial,
        run,
        runCreatedBy,
        userId: user?.id,
        idempotencyBegin,
      });
      const sv = await requireUploadedStateVersion(stateVersionId, idempotencyBegin);
      scheduleExplorerInventory(sv.workspaceId);
      (set as { status: number }).status = 201;
      const responseBody = { data: stateVersionResource(sv, request, false, undefined, await stateResponseAccess(ws, user?.id, orgId, teamId)) };
      if (idempotencyBegin.kind === "reserved") await completeIdempotency(idempotencyBegin.id, 201, responseBody, stateVersionId);
      return responseBody;
    } catch (error: unknown) {
      if (error instanceof StateVersionRejected) {
        (set as { status: number }).status = error.status;
        return error.body;
      }
      throw error;
    }
  });
