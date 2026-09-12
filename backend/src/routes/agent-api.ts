import { integrationSetting } from "../lib/runtime-config";
import { CLIENT_ENCRYPTED_STATE_ERROR, isClientEncryptedState } from "../lib/validation";
import { newResourceId } from "../lib/resource-id";
import { Elysia } from "elysia";
import { tokenHashCandidates } from "../lib/token-service";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { agentForwardedRequests, agentPoolTokens, agents, agentJobs, logs, organizations, runTokens, runs, workspaces, stackAgentJobs } from "../db/schema";
import { authPlugin } from "../auth";
import {
  isAgentResultValid,
  MAX_AGENT_RESULT_BYTES,
} from "../lib/agent-jobs";
import {
  appendAgentJobLog,
  authenticateAgent,
  claimAgentJob,
  completeAgentJob,
  findClaimedAgentJob,
  parseAgentFencingToken,
  type Agent,
  type AgentJobCompletion,
  type ClaimedAgentJob,
} from "../lib/agent-jobs";
import { claimStackAgentJob, completeStackAgentJob, findClaimedStackAgentJob, heartbeatStackAgentJob, type ClaimedStackAgentJob } from "../lib/stack-agent-jobs";
import { isStackStoragePath } from "../lib/stack-worker";
import { writePlanJsonArtifact } from "../lib/plan-json";
import {
  agentApiBaseUrl,
  agentEnvironment,
  agentFilesystemPath,
  agentRunToken,
  buildAgentJobPayload,
  terraformReleaseInfo,
  type AgentJobDetails,
} from "../lib/agent-api";
import { persistUploadBody } from "../lib/upload-body";
import { log } from "../lib/log";
import { validSignedApiURL } from "../lib/utils";
import { assertSafeTarArchive } from "../lib/archive";
import { resolveExternalUrl } from "../lib/url-safety";
import { isAgentPoolTokenActive } from "../lib/agent-token";
import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolNegotiationError,
  agentProtocolDescription,
  negotiateAgentProtocol,
  parseAgentProtocolOffer,
  serializeAgentCapabilities,
} from "../lib/agent-protocol";

const MAX_AGENT_BODY_BYTES = 16 * 1024 * 1024;
// The public listener's native request cap is 100 MiB. Keep the endpoint's
// advertised and enforced limit aligned so a body cannot claim a larger
// contract and then be rejected before the route sees it.
const MAX_AGENT_FILESYSTEM_BYTES = 100 * 1024 * 1024;
const MAX_FORWARDED_RESPONSE_BASE64_BYTES = Math.ceil(10 * 1024 * 1024 * 4 / 3) + 8;
const DEFAULT_AGENT_ACCEPT = "plan,apply,policy,assessment,stack_prepare,stack_plan,stack_apply,source_bundle,stack_aggregate_outputs,test";
const AGENT_WORKLOAD_TYPES = `${DEFAULT_AGENT_ACCEPT},ingress`.split(",");
const AGENT_ARCHITECTURES = new Set(["amd64", "aarch64", "arm64", "386", "arm"]);

async function releaseAgentClaim(claimed: ClaimedAgentJob): Promise<void> {
  const { job, run } = claimed;
  const queuedStatus = job.phase === "plan" ? "plan_queued" : "apply_queued";
  const owner = job.agentId === null ? isNull(agentJobs.agentId) : eq(agentJobs.agentId, job.agentId);
  await db.transaction(async (transaction: unknown): Promise<void> => {
    const t = transaction as typeof db;
    const released = await t.update(agentJobs).set({
      status: "queued",
      agentId: null,
      claimedAt: null,
      completedAt: null,
      errorMessage: null,
      fencingToken: sql`${agentJobs.fencingToken} + 1`,
    }).where(and(
      eq(agentJobs.id, job.id),
      owner,
      eq(agentJobs.fencingToken, job.fencingToken),
      eq(agentJobs.status, "claimed"),
    )).returning({ id: agentJobs.id });
    if (released.length === 0) return;

    await t.update(runTokens).set({ revokedAt: Date.now() }).where(eq(runTokens.runId, run.id));
    const current = await t.query.runs.findFirst({
      where: eq(runs.id, run.id),
      columns: { status: true, statusTimestamps: true },
    });
    if (current?.status !== (job.phase === "plan" ? "planning" : "applying")) return;
    const timestamps: Record<string, string> = current.statusTimestamps !== null && typeof current.statusTimestamps === "object"
      ? { ...(current.statusTimestamps), [`${queuedStatus.replace(/_/g, "-")}-at`]: new Date().toISOString() }
      : { [`${queuedStatus.replace(/_/g, "-")}-at`]: new Date().toISOString() };
    const updatedRuns = await t.update(runs).set({
      agentId: null,
      status: queuedStatus,
      statusTimestamps: timestamps,
    }).where(and(
      eq(runs.id, run.id),
      eq(runs.status, current.status),
    )).returning({ id: runs.id });
    if (updatedRuns.length === 0) return;
    if (job.phase === "apply") {
      await t.update(workspaces).set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null }).where(and(
        eq(workspaces.locked, true),
        eq(workspaces.lockOwnerType, "agent-run"),
        eq(workspaces.lockOwnerId, run.id),
      ));
    }
  });
}

type AgentCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  request: Request;
  set: { status?: number | string; headers?: Record<string, string | number> };
}>;

function protocolHeaders(
  set: { headers?: Record<string, string | number> },
  capabilities: readonly string[],
): void {
  set.headers ??= {};
  set.headers["tfc-agent-protocol-version"] = AGENT_PROTOCOL_VERSION;
  set.headers["tfc-agent-capabilities"] = serializeAgentCapabilities(capabilities);
}

function protocolNegotiationError(
  set: { status?: number },
  error: AgentProtocolNegotiationError,
): Record<string, unknown> {
  set.status = error.status;
  return {
    errors: [{
      status: String(error.status),
      title: "Agent protocol negotiation failed",
      code: error.code,
      detail: error.message,
      supported_versions: error.versions.length === 0 ? undefined : error.versions,
      unsupported_capabilities: error.capabilities.length === 0 ? undefined : error.capabilities,
    }],
  };
}

async function rawBody(ctx: AgentCtx): Promise<Buffer> {
  const body = ctx.body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  // No content-type requests are not parsed by Elysia; read the stream raw.
  if (body === undefined) {
    try {
      return Buffer.from(await ctx.request.arrayBuffer());
    } catch {
      return Buffer.alloc(0);
    }
  }
  return Buffer.from(JSON.stringify(body) ?? "");
}

/** Parse a JSON request body, preferring Elysia's parsed ctx.body. */
async function jsonBodyValue(ctx: AgentCtx): Promise<Record<string, unknown> | undefined> {
  const body = ctx.body;
  if (typeof body === "object" && body !== null && !Array.isArray(body) && !(body instanceof ArrayBuffer)) {
    return body as Record<string, unknown>;
  }
  try {
    const raw = (await rawBody(ctx)).toString("utf8");
    if (raw.length > MAX_AGENT_BODY_BYTES) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function bearerToken(authorization: string | null): string | undefined {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined;
  return authorization.slice(7);
}

/** Resolve the agent pool that owns an agent token (or undefined). */
async function poolForToken(token: string): Promise<{ poolId: string; tokenId: string } | undefined> {
  const [tokenHash, legacyTokenHash] = tokenHashCandidates(token);
  const rows = await db.query.agentPoolTokens.findMany({ where: inArray(agentPoolTokens.token, [tokenHash, legacyTokenHash]), limit: 2 });
  const row = rows.find((candidate) => candidate.token === tokenHash) ?? rows[0];
  if (row === undefined) return undefined;
  const now = Date.now();
  if (!isAgentPoolTokenActive(row, now)) return undefined;
  if (row.token === legacyTokenHash) {
    await db.update(agentPoolTokens).set({ token: tokenHash }).where(eq(agentPoolTokens.id, row.id));
  }
  return { poolId: row.agentPoolId, tokenId: row.id };
}

async function agentFromRequest(ctx: AgentCtx): Promise<Agent | undefined> {
  const agentId = ctx.request.headers.get("tfc-agent-id");
  if (agentId === null || agentId === "") return undefined;
  return authenticateAgent(agentId, ctx.request.headers.get("authorization"));
}

async function rejectUnsafeForwardedRequest(requestId: string, reason: string): Promise<void> {
  await db.update(agentForwardedRequests).set({
    status: "errored",
    agentId: null,
    claimedAt: null,
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
    errorMessage: `Forwarded request rejected: ${reason}`,
    completedAt: Date.now(),
    // Never retain credentials or a request body for a request rejected at the
    // agent handoff boundary.
    headers: {},
    body: null,
  }).where(and(
    eq(agentForwardedRequests.id, requestId),
    eq(agentForwardedRequests.status, "queued"),
  ));
}

function requestedFencingToken(ctx: AgentCtx): number | undefined {
  const header = ctx.request.headers.get("tfc-agent-fencing-token");
  const query = new URL(ctx.request.url).searchParams.get("fencing_token");
  return parseAgentFencingToken(header ?? query);
}

function fencingConflict(set: { status?: number }): Record<string, unknown> {
  set.status = 409;
  return {
    errors: [{
      status: "409",
      title: "Conflict",
      code: "stale-agent-lease",
      detail: "Completion rejected because the agent lease is stale, already finalized, or belongs to another run generation; newer artifacts are retained.",
    }],
  };
}

async function activeStackJobForStatus(agentId: string, phase?: string): Promise<typeof stackAgentJobs.$inferSelect | undefined> {
  return db.query.stackAgentJobs.findFirst({
    where: and(
      eq(stackAgentJobs.agentId, agentId),
      eq(stackAgentJobs.status, "claimed"),
      ...(phase === undefined ? [] : [eq(stackAgentJobs.phase, phase)]),
    ),
    orderBy: [asc(stackAgentJobs.claimedAt)],
  });
}

async function stackAgentPayload(details: ClaimedStackAgentJob, baseUrl: string): Promise<Record<string, unknown>> {
  const { job, stack, deploymentRun, step, configuration } = details;
  const path = `/api/agent/stack-jobs/${job.id}`;
  const configurationUrl = `${baseUrl}${path}/configuration?fencing_token=${String(job.fencingToken)}`;
  const organization = await db.query.organizations.findFirst({ where: eq(organizations.id, stack.orgId) });
  const data = {
    organization_name: organization?.name ?? stack.orgId,
    stack_id: stack.id,
    deployment_run_id: deploymentRun.id,
    deployment_step_id: step.id,
    stack_job_id: job.id,
    fencing_token: job.fencingToken,
    run_id: deploymentRun.id,
    operation: job.phase,
    iac_binary: job.iacBinary,
    configuration_version_url: configurationUrl,
  };
  const container = {
    current_operation: job.phase,
    source_bundle_download_url: configurationUrl,
    stack_id: stack.id,
    deployment_run_id: deploymentRun.id,
    deployment_step_id: step.id,
    fencing_token: job.fencingToken,
  };
  return { type: job.phase, job_id: job.id, data, [job.phase]: container, configuration: { id: configuration.id } };
}

/**
 * Authenticate an artifact request against the currently claimed job.
 *
 * The agent protocol normally sends its pool token. Embedded URLs are also
 * signed so bearerless fetches remain safe when the agent follows a URL
 * directly. An absent or malformed credential is never treated as anonymous
 * access.
 */
async function claimedPoolJob(
  pool: Readonly<{ poolId: string }>,
  jobId: string,
  fencingToken: number,
): Promise<ClaimedAgentJob | undefined> {
  const job = await db.query.agentJobs.findFirst({
    where: and(eq(agentJobs.id, jobId), eq(agentJobs.status, "claimed")),
  });
  if (job?.agentId === null || job?.agentId === undefined) return undefined;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, job.agentId) });
  if (agent === undefined || agent.agentPoolId !== pool.poolId) return undefined;
  return findClaimedAgentJob(agent.id, jobId, fencingToken);
}

async function claimedSignedJob(
  ctx: AgentCtx,
  jobId: string,
  fencingToken: number,
): Promise<ClaimedAgentJob | undefined> {
  const path = new URL(ctx.request.url).pathname;
  const signed = validSignedApiURL(ctx.request, path, ctx.request.method)
    || validSignedApiURL(ctx.request, path, "*");
  if (!signed) return undefined;
  const job = await db.query.agentJobs.findFirst({
    where: and(eq(agentJobs.id, jobId), eq(agentJobs.status, "claimed")),
  });
  if (job?.agentId === null || job?.agentId === undefined) return undefined;
  return findClaimedAgentJob(job.agentId, jobId, fencingToken);
}

async function claimedJobForArtifact(
  ctx: AgentCtx,
  jobId: string,
): Promise<ClaimedAgentJob | undefined> {
  if (jobId === "") return undefined;
  const fencingToken = requestedFencingToken(ctx);
  if (fencingToken === undefined) return undefined;
  const auth = ctx.request.headers.get("authorization");
  const token = bearerToken(auth ?? "");
  if (token !== undefined) {
    const pool = await poolForToken(token);
    if (pool !== undefined) {
      return claimedPoolJob(pool, jobId, fencingToken);
    }
  }

  return claimedSignedJob(ctx, jobId, fencingToken);
}

async function acknowledgeArtifact(ctx: AgentCtx): Promise<unknown> {
  const set = ctx.set as { status?: number };
  if (await claimedJobForArtifact(ctx, ctx.params["job_id"] ?? "") === undefined) {
    set.status = 401;
    return { errors: [{ status: "401", title: "Unauthorized" }] };
  }
  return {};
}

function storageRoot(): string {
  return process.env["STORAGE_DIR"] ?? new URL("../../storage", import.meta.url).pathname;
}

function sideArtifactPath(runId: string, kind: string, ext: string): string {
  return resolve(storageRoot(), "plan-json", `${runId}.${kind}.${ext}`);
}

async function configurationArchivePath(cvId: string): Promise<string> {
  // VCS-ingested archives live under configuration_versions/<cvId>.tar.gz;
  // API-uploaded archives under cv/config-<id>.tar.gz. Check both.
  const root = storageRoot();
  const candidates = [
    // VCS-ingested archives: configuration_versions/<cvId>.tar.gz (the id
    // already carries the cv- prefix).
    join(root, "configuration_versions", `${cvId}.tar.gz`),
    // API-uploaded archives: cv/config-<cvId>.tar.gz.
    join(root, "cv", `config-${cvId}.tar.gz`),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return candidates[0] ?? join(root, "cv", `config-${cvId}.tar.gz`);
}

async function tarOutput(args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const process = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function tarRun(args: readonly string[]): Promise<void> {
  const result = await tarOutput(args);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "tar command failed");
}

async function flattenedConfigurationArchive(cvId: string, sourcePath?: string): Promise<string> {
  const cacheDir = join(storageRoot(), "agent-cv");
  const cached = join(cacheDir, `${cvId}.tar.gz`);
  try {
    if (!(await Bun.file(cached).exists())) throw new Error("cache miss");
    await assertSafeTarArchive(cached);
    return cached;
  } catch {
    await rm(cached, { force: true });
  }
  const source = sourcePath ?? await configurationArchivePath(cvId);
  await assertSafeTarArchive(source);
  const tmp = await mkdtemp(join(storageRoot(), ".agent-cv-"));
  try {
    await tarRun(["-x", "-o", "-z", "-f", source, "-C", tmp]);
    const entries = await readdir(tmp, { withFileTypes: true });
    const hasTfInRoot = entries.some(
      (e): boolean => e.isFile() && (e.name.endsWith(".tf") || e.name.endsWith(".tf.json")),
    );
    const singleDir = entries.length === 1 && entries[0] !== undefined && entries[0].isDirectory() ? entries[0] : null;
    if (!hasTfInRoot && singleDir !== null) {
      // Move the single top-level directory's contents up (git archive layout).
      const inner = join(tmp, singleDir.name);
      for (const entry of await readdir(inner)) {
        await rename(join(inner, entry), join(tmp, entry));
      }
      await rm(inner, { recursive: true, force: true });
    }
    await mkdir(cacheDir, { recursive: true });
    await tarRun(["-c", "-z", "-f", cached, "-C", tmp, "."]);
    return cached;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parse a JSON state string carried by a modern agent completion. */
function jsonStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_AGENT_BODY_BYTES) return undefined;
  try {
    JSON.parse(value);
    return value;
  } catch {
    return undefined;
  }
}

async function jsonBody(ctx: AgentCtx): Promise<Record<string, unknown> | undefined> {
  return jsonBodyValue(ctx);
}

type RegistrationFields = {
  name: string;
  arch: string | null;
  version: string | null;
  accept: string;
  requestForwarding: boolean;
  hyok: boolean;
  iacBinaries: string[];
};

function negotiateRegistrationProtocol(
  ctx: AgentCtx,
  body: Record<string, unknown>,
  set: { status?: number; headers?: Record<string, string | number> },
): ReturnType<typeof negotiateAgentProtocol> | { error: unknown } {
  try {
    const negotiation = negotiateAgentProtocol(parseAgentProtocolOffer(body, ctx.request.headers));
    protocolHeaders(set, negotiation.capabilities);
    return negotiation;
  } catch (error: unknown) {
    if (error instanceof AgentProtocolNegotiationError) return { error: protocolNegotiationError(set, error) };
    throw error;
  }
}

// tfc-agent never sends iac-binaries; terrence-agent declares it so the
// claim path only hands it matching jobs. Absent means terraform-only,
// preserving the pre-capability contract.
function parseRegistrationIacBinaries(
  body: Record<string, unknown>,
  set: { status?: number },
): { iacBinaries: string[] } | { error: unknown } {
  if (body["iac_binaries"] === undefined) return { iacBinaries: ["terraform"] };
  if (
    !Array.isArray(body["iac_binaries"])
    || body["iac_binaries"].length === 0
    || body["iac_binaries"].some((binary: unknown): boolean =>
      typeof binary !== "string" || (binary !== "tofu" && binary !== "terraform"))
  ) {
    set.status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binaries must be a non-empty array of 'tofu' or 'terraform'" }] } };
  }
  return { iacBinaries: [...new Set(body["iac_binaries"] as string[])] };
}

function parseRegistrationFields(
  body: Record<string, unknown>,
  version: string | null,
  set: { status?: number },
): RegistrationFields | { error: unknown } {
  const name = typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : "agent";
  const arch = typeof body["arch"] === "string" ? body["arch"] : null;
  if (arch !== null && !AGENT_ARCHITECTURES.has(arch)) {
    set.status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "arch must be amd64, aarch64, arm64, 386, or arm" }] } };
  }
  const accept = typeof body["accept"] === "string" && body["accept"] !== "" ? body["accept"] : DEFAULT_AGENT_ACCEPT;
  if (accept !== "none" && (!/^[a-z_]+(?:,[a-z_]+)*$/.test(accept) || accept.split(",").some((value): boolean => !AGENT_WORKLOAD_TYPES.includes(value)))) {
    set.status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "accept contains an unsupported workload type" }] } };
  }
  const binaries = parseRegistrationIacBinaries(body, set);
  if ("error" in binaries) return binaries;
  return {
    name,
    arch,
    version,
    accept,
    requestForwarding: body["request_forwarding"] === true,
    hyok: body["hyok"] === true,
    iacBinaries: binaries.iacBinaries,
  };
}

async function upsertRegistrationAgent(
  pool: Readonly<{ poolId: string }>,
  fields: RegistrationFields,
  negotiation: ReturnType<typeof negotiateAgentProtocol>,
  now: number,
): Promise<string> {
  const existing = await db.query.agents.findFirst({
    where: and(eq(agents.agentPoolId, pool.poolId), eq(agents.name, fields.name)),
  });
  if (existing !== undefined) {
    await db.update(agents).set({
      architecture: fields.arch,
      version: fields.version ?? existing.version,
      protocolVersion: negotiation.version,
      capabilities: [...negotiation.capabilities],
      artifactFormats: [...negotiation.artifactFormats],
      iacBinaries: fields.iacBinaries,
      accept: fields.accept,
      requestForwarding: fields.requestForwarding,
      hyok: fields.hyok,
      status: "idle",
      lastPingAt: now,
    }).where(eq(agents.id, existing.id));
    return existing.id;
  }
  const agentId = newResourceId("agent");
  await db.insert(agents).values({
    id: agentId,
    agentPoolId: pool.poolId,
    name: fields.name,
    architecture: fields.arch,
    version: fields.version,
    protocolVersion: negotiation.version,
    capabilities: [...negotiation.capabilities],
    artifactFormats: [...negotiation.artifactFormats],
    iacBinaries: fields.iacBinaries,
    accept: fields.accept,
    requestForwarding: fields.requestForwarding,
    hyok: fields.hyok,
    status: "idle",
    lastPingAt: now,
  });
  return agentId;
}

type StatusJobPayload = {
  jobStatus: unknown;
  jobPayload: Record<string, unknown> | null;
  jobData: Record<string, unknown> | null;
  runId: string | null;
  operation: string | null;
};

function parseStatusJobPayload(body: Record<string, unknown>): StatusJobPayload {
  const jobPayload = typeof body["job"] === "object" && body["job"] !== null ? body["job"] as Record<string, unknown> : null;
  const jobData = jobPayload !== null && typeof jobPayload["data"] === "object" && jobPayload["data"] !== null
    ? jobPayload["data"] as Record<string, unknown>
    : null;
  return {
    jobStatus: jobPayload === null ? null : jobPayload["status"],
    jobPayload,
    jobData,
    runId: jobData !== null && typeof jobData["run_id"] === "string" ? jobData["run_id"] : null,
    operation: jobData !== null && typeof jobData["operation"] === "string" ? jobData["operation"] : null,
  };
}

function statusResultFields(jobData: Record<string, unknown> | null, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (jobData !== null) {
    for (const key of keys) {
      if (jobData[key] !== undefined) result[key] = jobData[key];
    }
  }
  return result;
}

async function findStatusAgentJob(
  agentId: string,
  runId: string,
  phase: string,
  fencingToken: number | undefined,
): Promise<typeof agentJobs.$inferSelect | undefined> {
  if (fencingToken === undefined) return undefined;
  return db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.runId, runId),
      eq(agentJobs.phase, phase),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.fencingToken, fencingToken),
      inArray(agentJobs.status, ["claimed", "canceled"]),
    ),
  });
}

async function completeStatusAgentJob(
  agent: Readonly<{ id: string }>,
  job: typeof agentJobs.$inferSelect,
  jobPayload: Record<string, unknown>,
  jobData: Record<string, unknown> | null,
  jobStatus: unknown,
  fencingToken: number,
  set: { status?: number },
): Promise<unknown | undefined> {
  const errorMessage = typeof jobPayload["error"] === "string" ? jobPayload["error"] : null;
  const result = statusResultFields(jobData, ["has_changes", "generated_configuration", "resource_additions",
    "resource_changes", "resource_destructions", "resource_imports", "action_failures",
    "action_invocations"]);
  const statePayload = jsonStringOrNull(jobData?.["state"]);
  const jsonState = jsonStringOrNull(jobData?.["json_state"]);
  const jsonStateOutputs = jsonStringOrNull(jobData?.["json_state_outputs"]);
  if (statePayload === undefined || jsonState === undefined || jsonStateOutputs === undefined) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Agent state payload must be valid JSON strings" }] };
  }
  if (isClientEncryptedState(statePayload)) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unsupported state representation", detail: CLIENT_ENCRYPTED_STATE_ERROR }] };
  }
  if (!isAgentResultValid(result)) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `result exceeds ${MAX_AGENT_RESULT_BYTES} bytes or structural limits` }] };
  }
  const completion: AgentJobCompletion = {
    status: jobStatus === "finished" ? "completed" : "errored",
    errorMessage,
    result,
    planJson: null,
    statePayload,
    jsonState,
    jsonStateOutputs,
    resourceAdditions: numberOrNull(result["resource_additions"]),
    resourceChanges: numberOrNull(result["resource_changes"]),
    resourceDestructions: numberOrNull(result["resource_destructions"]),
    resourceImports: numberOrNull(result["resource_imports"]),
  };
  const completed = await completeAgentJob(agent.id, job.id, fencingToken, completion);
  if (completed === undefined) return fencingConflict(set);
  return undefined;
}

async function findStatusStackJob(
  agentId: string,
  phase: string,
  runId: string,
  explicitStackJobId: string | null,
  fencingToken: number | undefined,
): Promise<typeof stackAgentJobs.$inferSelect | undefined> {
  const fencing = fencingToken === undefined ? [] : [eq(stackAgentJobs.fencingToken, fencingToken)];
  if (explicitStackJobId !== null) {
    return db.query.stackAgentJobs.findFirst({
      where: and(
        eq(stackAgentJobs.id, explicitStackJobId),
        eq(stackAgentJobs.phase, phase),
        eq(stackAgentJobs.agentId, agentId),
        eq(stackAgentJobs.status, "claimed"),
        ...fencing,
      ),
    });
  }
  return db.query.stackAgentJobs.findFirst({
    where: and(
      eq(stackAgentJobs.deploymentRunId, runId),
      eq(stackAgentJobs.phase, phase),
      eq(stackAgentJobs.agentId, agentId),
      eq(stackAgentJobs.status, "claimed"),
      ...fencing,
    ),
  });
}

async function completeStatusStackJob(
  agent: Readonly<{ id: string }>,
  jobPayload: Record<string, unknown>,
  jobData: Record<string, unknown> | null,
  jobStatus: unknown,
  phase: string,
  runId: string,
  fencingToken: number | undefined,
  set: { status?: number },
): Promise<unknown | undefined> {
  const explicitStackJobId = jobData !== null && typeof jobData["stack_job_id"] === "string" ? jobData["stack_job_id"] : null;
  const stackJob = await findStatusStackJob(agent.id, phase, runId, explicitStackJobId, fencingToken);
  if (stackJob === undefined) return fencingConflict(set);
  const result = statusResultFields(jobData, ["has_changes", "has-changes", "deferred_changes", "deferred-changes", "resource_additions", "resource_changes", "resource_destructions", "resource_imports"]);
  for (const key of ["state", "json_state"]) {
    if (jobData?.[key] === undefined) continue;
    const value = jsonStringOrNull(jobData?.[key]);
    if (value === undefined) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Agent ${key} payload must be a valid JSON string` }] };
    }
    result[key] = value;
  }
  const completed = await completeStackAgentJob(agent.id, stackJob.id, { status: jobStatus === "finished" ? "completed" : "errored", errorMessage: typeof jobPayload["error"] === "string" ? jobPayload["error"] : null, result }, fencingToken);
  if (completed === undefined) return fencingConflict(set);
  return undefined;
}

async function heartbeatStatusStackJob(
  agent: Readonly<{ id: string }>,
  jobData: Record<string, unknown> | null,
  operation: string | null,
  fencingToken: number | undefined,
): Promise<void> {
  const explicitStackJobId = jobData !== null && typeof jobData["stack_job_id"] === "string" ? jobData["stack_job_id"] : null;
  const stackPhase = operation === "apply" || operation === "plan" ? operation : undefined;
  const stackJob = explicitStackJobId === null
    ? await activeStackJobForStatus(agent.id, stackPhase)
    : await db.query.stackAgentJobs.findFirst({
        where: and(
          eq(stackAgentJobs.id, explicitStackJobId),
          eq(stackAgentJobs.agentId, agent.id),
          eq(stackAgentJobs.status, "claimed"),
          ...(fencingToken === undefined ? [] : [eq(stackAgentJobs.fencingToken, fencingToken)]),
        ),
      });
  if (stackJob !== undefined) await heartbeatStackAgentJob(agent.id, stackJob.id, fencingToken);
}

async function handleStatusCompletion(
  agent: Readonly<{ id: string }>,
  jobPayload: Record<string, unknown>,
  jobData: Record<string, unknown> | null,
  jobStatus: unknown,
  phase: string,
  runId: string,
  fencingToken: number | undefined,
  set: { status?: number },
): Promise<unknown | undefined> {
  const job = await findStatusAgentJob(agent.id, runId, phase, fencingToken);
  if (job !== undefined && fencingToken !== undefined) {
    return completeStatusAgentJob(agent, job, jobPayload, jobData, jobStatus, fencingToken, set);
  }
  return completeStatusStackJob(agent, jobPayload, jobData, jobStatus, phase, runId, fencingToken, set);
}

function statusResponseHeaders(ctx: AgentCtx, set: { headers?: Record<string, string | number> }): Record<string, never> {
  const messageIndex = ctx.request.headers.get("tfc-agent-message-index");
  if (set.headers === undefined) set.headers = {};
  if (messageIndex !== null) set.headers["tfc-agent-message-index"] = messageIndex;
  set.headers["content-type"] = "application/json";
  return {};
}

function parseForwardedStatus(body: Record<string, unknown> | undefined): number | null {
  const status = body?.["status"];
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function parseForwardedBody(
  body: Record<string, unknown> | undefined,
  set: { status?: number },
): { responseBody: string | null } | { error: unknown } {
  // A forwarded response without a body is valid (204 No Content, 304 Not
  // Modified, HEAD responses). Only require responseStatus; default an
  // omitted body to "" so these responses are not rejected as 422 while a
  // non-string body (a malformed payload) still fails loudly.
  const rawResponseBody = body?.["body"];
  if (typeof rawResponseBody === "string" && rawResponseBody.length > MAX_FORWARDED_RESPONSE_BASE64_BYTES) {
    set.status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Forwarded response body exceeds the size limit" }] } };
  }
  return { responseBody: typeof rawResponseBody === "string" ? rawResponseBody : rawResponseBody === undefined ? "" : null };
}

function parseForwardedHeaders(
  body: Record<string, unknown> | undefined,
  set: { status?: number },
): { responseHeaders: Record<string, string[]> } | { error: unknown } {
  const rawHeaders = body?.["headers"];
  const responseHeaders: Record<string, string[]> = {};
  if (rawHeaders !== null && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [name, values] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !Array.isArray(values) || !values.every((value): value is string => typeof value === "string" && !/[\r\n]/.test(value))) {
        set.status = 422;
        return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid forwarded response headers" }] } };
      }
      responseHeaders[name] = values;
    }
  }
  return { responseHeaders };
}

async function completeForwardedRequest(
  agentId: string,
  requestId: string,
  fields: { responseStatus: number | null; responseHeaders: Record<string, string[]>; responseBody: string | null; errorMessage: string | null },
  set: { status?: number },
): Promise<unknown> {
  const updated = await db.update(agentForwardedRequests).set({
    status: fields.errorMessage === null ? "completed" : "errored",
    responseStatus: fields.responseStatus,
    responseHeaders: fields.responseHeaders,
    responseBody: fields.responseBody,
    errorMessage: fields.errorMessage,
    completedAt: Date.now(),
    // The request is done; the agent no longer needs the original request
    // headers/body to replay it. Drop them so credentials that may have
    // been forwarded (Authorization, cookies) are not persisted with the
    // completed row in the database or a support bundle.
    headers: {},
    body: null,
  }).where(and(
    eq(agentForwardedRequests.id, requestId),
    eq(agentForwardedRequests.agentId, agentId),
    eq(agentForwardedRequests.status, "claimed"),
  )).returning({ id: agentForwardedRequests.id });
  if (updated.length === 0) {
    set.status = 404;
    return { errors: [{ status: "404", title: "Not Found" }] };
  }
  return {};
}

function acceptedWorkloadPhases(agent: Readonly<{ accept: string | null | undefined }>, headerValue: string | null): ReadonlySet<string> {
  // The registered accept list is authoritative: the agent declared its
  // workload set when it registered (validated against AGENT_WORKLOAD_TYPES
  // then persisted). The tfc-agent-accept header may only narrow that set
  // per request — never widen it — so a registration of "none" cannot be
  // bypassed by polling with a header, and an agent cannot silently upgrade
  // its own privileges.
  const registered = agent.accept ?? DEFAULT_AGENT_ACCEPT;
  const registeredSet = new Set(registered === "none" ? [] : registered.split(","));
  if (headerValue === null) return registeredSet;
  return new Set(headerValue.split(",").filter((value): boolean => registeredSet.has(value)));
}

async function claimAvailableJob(
  agent: Parameters<typeof claimAgentJob>[0],
  accepted: ReadonlySet<string>,
  request: AgentCtx["request"],
  set: { status?: number },
): Promise<{ claimed: NonNullable<Awaited<ReturnType<typeof claimAgentJob>>> } | { response: unknown } | { empty: true }> {
  const claimed = await claimAgentJob(agent, ["plan", "apply"].filter((phase): boolean => accepted.has(phase)));
  if (claimed !== undefined) return { claimed };
  const stackClaimed = await claimStackAgentJob(agent, ["plan", "apply"].filter((phase): boolean => accepted.has(`stack_${phase}`)));
  if (stackClaimed === undefined) {
    set.status = 204;
    return { empty: true as const };
  }
  return { response: await stackAgentPayload(stackClaimed, agentApiBaseUrl(request)) };
}

async function buildClaimedJobPayload(
  claimed: NonNullable<Awaited<ReturnType<typeof claimAgentJob>>>,
  agent: Readonly<{ id: string; architecture: string | null }>,
  request: AgentCtx["request"],
  set: { status?: number },
): Promise<unknown> {
  const { job, run, workspace, configuration } = claimed;
  try {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) });
    if (org === undefined) throw new Error("organization not found");
    const baseUrl = agentApiBaseUrl(request);
    const version = run.terraformVersion ?? workspace.terraformVersion ?? org.defaultTerraformVersion ?? "latest";
    const terraformInfo = await terraformReleaseInfo(version, agent.architecture ?? "amd64");
    if (terraformInfo === null) throw new Error("Unable to resolve Terraform release");
    const environment = await agentEnvironment(workspace.id, workspace.orgId, workspace.projectId ?? null, run.variables);
    const runVars: Record<string, string> = {};
    // Mint the run token only after all fallible lookups/resolution work has
    // succeeded, so a failed payload build cannot accumulate valid tokens.
    const runToken = await agentRunToken(run.id, workspace.id, workspace.orgId);
    const details: AgentJobDetails = { job, run, workspace, organizationName: org.name, configuration };
    const payload = await buildAgentJobPayload(details, baseUrl, runToken, terraformInfo, runVars, environment);
    return payload;
  } catch (error: unknown) {
    try {
      await releaseAgentClaim(claimed);
    } catch (releaseError: unknown) {
      log.error("Failed to release an agent claim after payload construction failed", {
        jobId: claimed.job.id,
        runId: claimed.run.id,
        error: releaseError,
      });
    }
    log.error("Failed to construct an agent job payload", { jobId: claimed.job.id, runId: claimed.run.id, error });
    set.status = 503;
    return { errors: [{ status: "503", title: "Service Unavailable", detail: error instanceof Error ? error.message : "Unable to construct agent job" }] };
  }
}

export const agentApiRoutes = new Elysia({ name: "agent-api" })
  .use(authPlugin)

  // This is the stable product contract. It is intentionally independent of
  // the installed agent binary version and safe to inspect before registering.
  .get("/api/agent/protocol", (ctx: AgentCtx): unknown => {
    const set = ctx.set as { headers?: Record<string, string | number> };
    const description = agentProtocolDescription();
    const capabilities = Array.isArray(description["capabilities"]) ? description["capabilities"] as string[] : [];
    protocolHeaders(set, capabilities);
    return description;
  })

  // --- Registration ---------------------------------------------------------
  .post("/api/agent/register", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const token = bearerToken(ctx.request.headers.get("authorization"));
    if (token === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const pool = await poolForToken(token);
    if (pool === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const body = await jsonBodyValue(ctx);
    if (body === undefined) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const negotiation = negotiateRegistrationProtocol(ctx, body, set);
    if ("error" in negotiation) return negotiation.error;
    const fields = parseRegistrationFields(body, ctx.request.headers.get("tfc-agent-version"), set);
    if ("error" in fields) return fields.error;

    const now = Date.now();
    const agentId = await upsertRegistrationAgent(pool, fields, negotiation, now);
    await db.update(agentPoolTokens).set({ lastUsedAt: now }).where(eq(agentPoolTokens.id, pool.tokenId));
    return {
      id: agentId,
      agent_pool_id: pool.poolId,
      protocol_version: negotiation.version,
      capabilities: negotiation.capabilities,
      unsupported_capabilities: negotiation.unsupportedCapabilities,
      artifact_formats: negotiation.artifactFormats,
      unsupported_artifact_formats: negotiation.unsupportedArtifactFormats,
      legacy: negotiation.legacy,
    };
  })

  // --- Status + completion --------------------------------------------------
  .put("/api/agent/status", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    protocolHeaders(set, agent.capabilities);
    const body = await jsonBodyValue(ctx);
    if (body === undefined) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const status = typeof body["status"] === "string" ? body["status"] : "idle";
    const now = Date.now();

    const payload = parseStatusJobPayload(body);
    const fencingToken = parseAgentFencingToken(
      payload.jobData?.["fencing_token"] ?? ctx.request.headers.get("tfc-agent-fencing-token"),
    );

    if ((payload.jobStatus === "finished" || payload.jobStatus === "errored") && payload.jobPayload !== null && payload.runId !== null) {
      // Completion signal: the agent finished (or failed) its claimed job.
      const phase = payload.operation === "apply" ? "apply" : "plan";
      const done = await handleStatusCompletion(agent, payload.jobPayload, payload.jobData, payload.jobStatus, phase, payload.runId, fencingToken, set);
      if (done !== undefined) return done;
      await db.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agent.id));
    } else {
      const agentStatus = status === "busy" ? "busy" : status === "exited" ? "exited" : "idle";
      await db.update(agents).set({ status: agentStatus, lastPingAt: now }).where(eq(agents.id, agent.id));
      await heartbeatStatusStackJob(agent, payload.jobData, payload.operation, fencingToken);
    }

    return statusResponseHeaders(ctx, set);
  })

  .get("/api/agent/update", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const version = integrationSetting("TERRENCE_AGENT_UPDATE_VERSION");
    const url = integrationSetting("TERRENCE_AGENT_UPDATE_URL");
    const sha256 = integrationSetting("TERRENCE_AGENT_UPDATE_SHA256");
    if (version === null || url === null || sha256 === null) {
      set.status = 204;
      return undefined;
    }
    return { version, url, sha256 };
  })

  .get("/api/agent/forwarded-requests", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    if (agent.requestForwarding !== true && agent.hyok !== true) {
      set.status = 204;
      return undefined;
    }
    // Scope the stale-claim sweep to this agent's own pool. Without the pool
    // predicate, an agent polling here would requeue stale claims that belong
    // to another pool's agents.
    await db.update(agentForwardedRequests).set({
      status: "queued",
      agentId: null,
      claimedAt: null,
      errorMessage: null,
    }).where(and(
      eq(agentForwardedRequests.agentPoolId, agent.agentPoolId),
      eq(agentForwardedRequests.status, "claimed"),
      lt(agentForwardedRequests.claimedAt, Date.now() - 90_000),
    ));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = await db.query.agentForwardedRequests.findFirst({
        where: and(eq(agentForwardedRequests.agentPoolId, agent.agentPoolId), eq(agentForwardedRequests.status, "queued")),
        orderBy: [asc(agentForwardedRequests.createdAt)],
      });
      if (candidate === undefined) {
        set.status = 204;
        return undefined;
      }
      // Revalidate immediately before handing the URL to the agent. The row
      // may have been inserted by an older producer or changed between the
      // enqueue-time check and this dequeue, and the agent executes this URL
      // from its own network namespace. Fail closed and keep scanning so one
      // unsafe row cannot block later valid requests.
      let destination: Awaited<ReturnType<typeof resolveExternalUrl>>;
      try {
        destination = await resolveExternalUrl(candidate.url, false);
      } catch {
        destination = { error: "URL could not be resolved safely" };
      }
      if ("error" in destination) {
        await rejectUnsafeForwardedRequest(candidate.id, destination.error);
        continue;
      }
      const claimed = await db.update(agentForwardedRequests).set({
        status: "claimed",
        agentId: agent.id,
        claimedAt: Date.now(),
      }).where(and(
        eq(agentForwardedRequests.id, candidate.id),
        eq(agentForwardedRequests.url, candidate.url),
        eq(agentForwardedRequests.status, "queued"),
      )).returning();
      const request = claimed[0];
      if (request === undefined) continue;
      await db.update(agents).set({ lastPingAt: Date.now() }).where(eq(agents.id, agent.id));
      return {
        id: request.id,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
      };
    }
    set.status = 204;
    return undefined;
  })

  .put("/api/agent/forwarded-requests/:request_id", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const body = await jsonBodyValue(ctx);
    const responseStatus = parseForwardedStatus(body);
    const parsedBody = parseForwardedBody(body, set);
    if ("error" in parsedBody) return parsedBody.error;
    const errorMessage = typeof body?.["error"] === "string" ? body["error"].slice(0, 2_000) : null;
    const parsedHeaders = parseForwardedHeaders(body, set);
    if ("error" in parsedHeaders) return parsedHeaders.error;
    if ((responseStatus === null || parsedBody.responseBody === null) && errorMessage === null) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A forwarded response or error is required" }] };
    }
    return completeForwardedRequest(agent.id, ctx.params["request_id"] ?? "", {
      responseStatus,
      responseHeaders: parsedHeaders.responseHeaders,
      responseBody: parsedBody.responseBody,
      errorMessage,
    }, set);
  })

  // --- Job claim ------------------------------------------------------------
  .get("/api/agent/jobs", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    protocolHeaders(set, agent.capabilities);
    const accepted = acceptedWorkloadPhases(agent, ctx.request.headers.get("tfc-agent-accept"));
    const claim = await claimAvailableJob(agent, accepted, ctx.request, set);
    if ("response" in claim) return claim.response;
    if ("empty" in claim) return undefined;
    return buildClaimedJobPayload(claim.claimed, agent, ctx.request, set);
  })

  .get("/api/agent/jobs/:job_id/status", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const job = await db.query.agentJobs.findFirst({
      where: and(eq(agentJobs.id, ctx.params["job_id"] ?? ""), eq(agentJobs.agentId, agent.id)),
    });
    if (job === undefined) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, job.runId) });
    const canceled = job.status === "canceled" || run?.status === "canceled" || run?.status === "force_canceled";
    return { status: job.status, canceled };
  })

  .get("/api/agent/stack-jobs/:job_id/configuration", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const agent = await agentFromRequest(ctx);
    const fencingToken = requestedFencingToken(ctx);
    const claimed = agent === undefined ? undefined : await findClaimedStackAgentJob(agent.id, ctx.params["job_id"] ?? "", fencingToken);
    const runArchivePath = typeof (claimed?.deploymentRun.payload ?? {})["archivePath"] === "string" ? (claimed?.deploymentRun.payload ?? {})["archivePath"] as string : null;
    const configurationArchivePath = typeof (claimed?.configuration.payload ?? {})["archivePath"] === "string" ? (claimed?.configuration.payload ?? {})["archivePath"] as string : null;
    const archivePath = runArchivePath ?? configurationArchivePath;
    if (claimed === undefined || archivePath === null || !isStackStoragePath(archivePath) || !(await Bun.file(archivePath).exists())) {
      set.status = agent === undefined ? 401 : 404;
      return { errors: [{ status: String(set.status), title: set.status === 401 ? "Unauthorized" : "Not Found" }] };
    }
    set.headers = { "content-type": "application/gzip" };
    return Bun.file(archivePath);
  })

  // --- Artifact endpoints (agent-token + claimed-job scoped) ----------------
  .get("/api/agent/jobs/:job_id/configuration-version", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const details = await claimedJobForArtifact(ctx, ctx.params["job_id"] ?? "");
    if (details === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, details.job.runId) });
    const cvId = run?.configurationVersionId;
    if (cvId === null || cvId === undefined) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const configuration = details.configuration;
    if (configuration === null || configuration.id !== cvId || configuration.status !== "uploaded" || configuration.archivePath === null || !(await Bun.file(configuration.archivePath).exists())) {
      await rm(join(storageRoot(), "agent-cv", `${cvId}.tar.gz`), { force: true });
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    try {
      const data = await readFile(await flattenedConfigurationArchive(cvId, configuration.archivePath));
      set.headers = { "content-type": "application/gzip", "content-length": String(data.byteLength) };
      return new Response(data);
    } catch {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
  })

  .get("/api/agent/jobs/:job_id/filesystem", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const details = await claimedJobForArtifact(ctx, ctx.params["job_id"] ?? "");
    if (details === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    try {
      const data = await readFile(agentFilesystemPath(details.job.runId));
      set.headers = { "content-type": "application/gzip", "content-length": String(data.byteLength) };
      return new Response(data);
    } catch {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
  })

  .put("/api/agent/jobs/:job_id/filesystem", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const details = await claimedJobForArtifact(ctx, ctx.params["job_id"] ?? "");
    if (details === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const path = agentFilesystemPath(details.job.runId);
    try {
      await mkdir(dirname(path), { recursive: true });
      await persistUploadBody(
        ctx.body,
        ctx.request,
        path,
        MAX_AGENT_FILESYSTEM_BYTES,
        async (): Promise<boolean> => await findClaimedAgentJob(details.job.agentId ?? "", details.job.id, details.job.fencingToken) !== undefined,
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "stale-agent-lease") return fencingConflict(set);
      const tooLarge = error instanceof Error && error.message === "too-large";
      set.status = tooLarge ? 422 : 400;
      return { errors: [{ status: String(set.status), title: tooLarge ? "Unprocessable Entity" : "Bad Request" }] };
    }
    return {};
  })

  .put("/api/agent/jobs/:job_id/log", async (ctx: AgentCtx): Promise<unknown> => {
    return appendLog(ctx);
  })
  .patch("/api/agent/jobs/:job_id/log", async (ctx: AgentCtx): Promise<unknown> => {
    return appendLog(ctx);
  })

  .put("/api/agent/jobs/:job_id/plan-json", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const details = await claimedJobForArtifact(ctx, ctx.params["job_id"] ?? "");
    if (details === undefined || details.job.phase !== "plan") {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const planJson = await jsonBody(ctx);
    if (planJson === undefined) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    try {
      await writePlanJsonArtifact(
        details.job.runId,
        planJson,
        async (): Promise<boolean> => await findClaimedAgentJob(details.job.agentId ?? "", details.job.id, details.job.fencingToken) !== undefined,
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "stale-agent-lease") return fencingConflict(set);
      throw error;
    }
    return {};
  })

  .put("/api/agent/jobs/:job_id/plan-json-redacted", async (ctx: AgentCtx): Promise<unknown> => {
    return storeSideArtifact(ctx, "redacted", "json");
  })
  .put("/api/agent/jobs/:job_id/plan-json-sanitized", async (ctx: AgentCtx): Promise<unknown> => {
    return storeSideArtifact(ctx, "sanitized", "json");
  })
  .put("/api/agent/jobs/:job_id/provider-schemas", async (ctx: AgentCtx): Promise<unknown> => {
    return storeSideArtifact(ctx, "provider-schemas", "json");
  })
  .put("/api/agent/jobs/:job_id/plan-description", async (ctx: AgentCtx): Promise<unknown> => {
    return storeSideArtifact(ctx, "description", "txt");
  })

  // Accepted for protocol completeness; Terrence does not consume these.
  .put("/api/agent/jobs/:job_id/raw-plan", async (ctx: AgentCtx): Promise<unknown> => {
    return acknowledgeArtifact(ctx);
  })
  .put("/api/agent/jobs/:job_id/upload", async (ctx: AgentCtx): Promise<unknown> => {
    return acknowledgeArtifact(ctx);
  })
  .post("/api/agent/jobs/:job_id/outcomes/:kind", async (ctx: AgentCtx): Promise<unknown> => {
    return acknowledgeArtifact(ctx);
  })
  .put("/api/agent/jobs/:job_id/apply-description", async (ctx: AgentCtx): Promise<unknown> => {
    return acknowledgeArtifact(ctx);
  })
  .put("/api/agent/jobs/:job_id/state-description", async (ctx: AgentCtx): Promise<unknown> => {
    return acknowledgeArtifact(ctx);
  });

async function appendLog(ctx: AgentCtx): Promise<unknown> {
  const set = ctx.set as { status?: number };
  const details = await claimedJobForArtifact(ctx, ctx.params["job_id"] ?? "");
  if (details === undefined) {
    set.status = 401;
    return { errors: [{ status: "401", title: "Unauthorized" }] };
  }
  const raw = (await rawBody(ctx)).toString("utf8");
  // The agent streams log chunks; \x02 flushes the buffer and \x03 ends it.
  const text = raw.replace(/\u0002/g, "").replace(/\u0003/g, "");
  if (text.trim() !== "") {
    // The final PUT repeats the last PATCHed chunk; skip exact duplicates so
    // the run log does not double up every line. Only dedupe immediate
    // duplicates (within 2s) so legitimate repeated ticks like
    // "Still creating..." are not dropped.
    const last = await db.query.logs.findFirst({
      where: and(eq(logs.runId, details.job.runId), eq(logs.phase, details.job.phase)),
      orderBy: [desc(logs.createdAt), desc(logs.id)],
    });
    const isImmediateDuplicate = last !== undefined && last.outputText === text && Date.now() - last.createdAt < 2000;
    if (!isImmediateDuplicate) {
      await appendAgentJobLog(details.job.agentId ?? "", details.job.id, details.job.fencingToken, text.slice(0, 1024 * 1024));
    }
  }
  return {};
}

async function storeSideArtifact(ctx: AgentCtx, kind: string, ext: string): Promise<unknown> {
  const set = ctx.set as { status?: number };
  const details = await claimedJobForArtifact(ctx, ctx.params["job_id"] ?? "");
  if (details === undefined) {
    set.status = 401;
    return { errors: [{ status: "401", title: "Unauthorized" }] };
  }
  const raw = (await rawBody(ctx)).toString("utf8");
  if (raw.length > MAX_AGENT_BODY_BYTES) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
  }
  if (ext === "json") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
    } catch {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Artifact must be a JSON object" }] };
    }
  }
  const path = sideArtifactPath(details.job.runId, kind, ext);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
    const stillClaimed = await findClaimedAgentJob(details.job.agentId ?? "", details.job.id, details.job.fencingToken);
    if (stillClaimed === undefined) return fencingConflict(set);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return {};
}
