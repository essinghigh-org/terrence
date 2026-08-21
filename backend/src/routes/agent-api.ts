import { Elysia } from "elysia";
import { hashAuthenticationToken } from "../lib/token-service";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { agentForwardedRequests, agentPoolTokens, agents, agentJobs, logs, organizations, runs, stackAgentJobs } from "../db/schema";
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

const MAX_AGENT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_FILESYSTEM_BYTES = 256 * 1024 * 1024;
const MAX_FORWARDED_RESPONSE_BASE64_BYTES = Math.ceil(10 * 1024 * 1024 * 4 / 3) + 8;
const DEFAULT_AGENT_ACCEPT = "plan,apply,policy,assessment,stack_prepare,stack_plan,stack_apply,source_bundle,stack_aggregate_outputs,test";
const AGENT_WORKLOAD_TYPES = `${DEFAULT_AGENT_ACCEPT},ingress`.split(",");

type AgentCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  request: Request;
  set: { status?: number | string; headers?: Record<string, string | number> };
}>;

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
  return Buffer.from(String(body ?? ""));
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
  const tokenHash = hashAuthenticationToken(token);
  const row = await db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.token, tokenHash) });
  return row === undefined ? undefined : { poolId: row.agentPoolId, tokenId: row.id };
}

async function agentFromRequest(ctx: AgentCtx): Promise<Agent | undefined> {
  const agentId = ctx.request.headers.get("tfc-agent-id");
  if (agentId === null || agentId === "") return undefined;
  return authenticateAgent(agentId, ctx.request.headers.get("authorization"));
}

async function stackAgentPayload(details: ClaimedStackAgentJob, baseUrl: string): Promise<Record<string, unknown>> {
  const { job, stack, deploymentRun, step, configuration } = details;
  const path = `/api/agent/stack-jobs/${job.id}`;
  const organization = await db.query.organizations.findFirst({ where: eq(organizations.id, stack.orgId) });
  const data = {
    organization_name: organization?.name ?? stack.orgId,
    stack_id: stack.id,
    deployment_run_id: deploymentRun.id,
    deployment_step_id: step.id,
    stack_job_id: job.id,
    run_id: deploymentRun.id,
    operation: job.phase,
    iac_binary: job.iacBinary,
    configuration_version_url: `${baseUrl}${path}/configuration`,
  };
  const container = {
    current_operation: job.phase,
    source_bundle_download_url: `${baseUrl}${path}/configuration`,
    stack_id: stack.id,
    deployment_run_id: deploymentRun.id,
    deployment_step_id: step.id,
  };
  return { type: job.phase, job_id: job.id, data, [job.phase]: container, configuration: { id: configuration.id } };
}

/**
 * Artifact auth for the modern protocol. The tfc-agent fetches and uploads
 * job artifacts with NO credentials (verified against 1.30.1); TFC protects
 * them with signed expiring URLs. Terrence mirrors the same trust model:
 * the job id is a random UUID, and artifact endpoints accept either a valid
 * agent token for the job's pool or no credentials at all, scoped strictly
 * to a job that is currently claimed.
 */
async function claimedJobForArtifact(
  ctx: AgentCtx,
  jobId: string,
): Promise<ClaimedAgentJob | undefined> {
  if (jobId === "") return undefined;
  const auth = ctx.request.headers.get("authorization");
  if (typeof auth === "string" && auth.startsWith("Bearer agent-")) {
    const pool = await poolForToken(bearerToken(auth) ?? "");
    if (pool === undefined) return undefined;
    const job = await db.query.agentJobs.findFirst({
      where: and(eq(agentJobs.id, jobId), eq(agentJobs.status, "claimed")),
    });
    if (job?.agentId === null || job?.agentId === undefined) return undefined;
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, job.agentId) });
    if (agent === undefined || agent.agentPoolId !== pool.poolId) return undefined;
    return findClaimedAgentJob(agent.id, jobId);
  }
  const job = await db.query.agentJobs.findFirst({
    where: and(eq(agentJobs.id, jobId), eq(agentJobs.status, "claimed")),
  });
  if (job?.agentId === null || job?.agentId === undefined) return undefined;
  return findClaimedAgentJob(job.agentId, jobId);
}

function storageRoot(): string {
  return process.env.STORAGE_DIR ?? new URL("../../storage", import.meta.url).pathname;
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

/**
 * The tfc-agent expects a flat source bundle (TFC slugs are flat). VCS
 * archives carry a top-level repo directory (git archive layout), so flatten
 * the archive once and cache it under storage/agent-cv/<cvId>.tar.gz.
 */
async function flattenedConfigurationArchive(cvId: string): Promise<string> {
  const cacheDir = join(storageRoot(), "agent-cv");
  const cached = join(cacheDir, `${cvId}.tar.gz`);
  try {
    await readFile(cached);
    return cached;
  } catch {
    // not cached yet
  }
  const source = await configurationArchivePath(cvId);
  const tmp = await mkdtemp(join(storageRoot(), ".agent-cv-"));
  try {
    const extract = Bun.spawnSync(["tar", "-xzf", source, "-C", tmp]);
    if (extract.exitCode !== 0) throw new Error("tar extract failed");
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
    const pack = Bun.spawnSync(["tar", "-czf", cached, "-C", tmp, "."]);
    if (pack.exitCode !== 0) throw new Error("tar pack failed");
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

export const agentApiRoutes = new Elysia({ name: "agent-api" })
  .use(authPlugin)

  // --- Registration ---------------------------------------------------------
  .post("/api/agent/register", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
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
    const name = typeof body.name === "string" && body.name !== "" ? body.name : "agent";
    const arch = typeof body.arch === "string" ? body.arch : null;
    const version = ctx.request.headers.get("tfc-agent-version");
    const accept = typeof body.accept === "string" && body.accept !== "" ? body.accept : DEFAULT_AGENT_ACCEPT;
    if (accept !== "none" && (!/^[a-z_]+(?:,[a-z_]+)*$/.test(accept) || accept.split(",").some((value): boolean => !AGENT_WORKLOAD_TYPES.includes(value)))) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "accept contains an unsupported workload type" }] };
    }
    const requestForwarding = body.request_forwarding === true;
    const hyok = body.hyok === true;
    // tfc-agent never sends iac-binaries; terrence-agent declares it so the
    // claim path only hands it matching jobs. Absent means terraform-only,
    // preserving the pre-capability contract.
    let iacBinaries: string[] = ["terraform"];
    if (body.iac_binaries !== undefined) {
      if (
        !Array.isArray(body.iac_binaries)
        || body.iac_binaries.length === 0
        || body.iac_binaries.some((binary: unknown): boolean =>
          typeof binary !== "string" || (binary !== "tofu" && binary !== "terraform"))
      ) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binaries must be a non-empty array of 'tofu' or 'terraform'" }] };
      }
      iacBinaries = [...new Set(body.iac_binaries as string[])];
    }

    const now = Date.now();
    const existing = await db.query.agents.findFirst({
      where: and(eq(agents.agentPoolId, pool.poolId), eq(agents.name, name)),
    });
    let agentId: string;
    if (existing !== undefined) {
      agentId = existing.id;
      await db.update(agents).set({
        architecture: arch,
        version,
        iacBinaries,
        accept,
        requestForwarding,
        hyok,
        status: "idle",
        lastPingAt: now,
      }).where(eq(agents.id, existing.id));
    } else {
      agentId = `agent-${crypto.randomUUID()}`;
      await db.insert(agents).values({
        id: agentId,
        agentPoolId: pool.poolId,
        name,
        architecture: arch,
        version,
        iacBinaries,
        accept,
        requestForwarding,
        hyok,
        status: "idle",
        lastPingAt: now,
      });
    }
    await db.update(agentPoolTokens).set({ lastUsedAt: now }).where(eq(agentPoolTokens.id, pool.tokenId));
    return { id: agentId, agent_pool_id: pool.poolId };
  })

  // --- Status + completion --------------------------------------------------
  .put("/api/agent/status", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const body = await jsonBodyValue(ctx);
    if (body === undefined) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const status = typeof body.status === "string" ? body.status : "idle";
    const now = Date.now();

    const jobPayload = typeof body.job === "object" && body.job !== null ? body.job as Record<string, unknown> : null;
    const jobStatus = jobPayload === null ? null : jobPayload.status;
    const jobData = jobPayload !== null && typeof jobPayload.data === "object" && jobPayload.data !== null
      ? jobPayload.data as Record<string, unknown>
      : null;
    const runId = jobData !== null && typeof jobData.run_id === "string" ? jobData.run_id : null;
    const operation = jobData !== null && typeof jobData.operation === "string" ? jobData.operation : null;

    if ((jobStatus === "finished" || jobStatus === "errored") && jobPayload !== null && runId !== null) {
      // Completion signal: the agent finished (or failed) its claimed job.
      const phase = operation === "apply" ? "apply" : "plan";
      const job = await db.query.agentJobs.findFirst({
        where: and(
          eq(agentJobs.runId, runId),
          eq(agentJobs.phase, phase),
          eq(agentJobs.agentId, agent.id),
          eq(agentJobs.status, "claimed"),
        ),
      });
      if (job !== undefined) {
        const errorMessage = typeof jobPayload.error === "string" ? jobPayload.error : null;
        const result: Record<string, unknown> = {};
        if (jobData !== null) {
          for (const key of ["has_changes", "generated_configuration", "resource_additions",
            "resource_changes", "resource_destructions", "resource_imports", "action_failures",
            "action_invocations"]) {
            if (jobData[key] !== undefined) result[key] = jobData[key];
          }
        }
        const statePayload = jsonStringOrNull(jobData?.state);
        const jsonState = jsonStringOrNull(jobData?.json_state);
        const jsonStateOutputs = jsonStringOrNull(jobData?.json_state_outputs);
        if (statePayload === undefined || jsonState === undefined || jsonStateOutputs === undefined) {
          set.status = 422;
          return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Agent state payload must be valid JSON strings" }] };
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
          resourceAdditions: numberOrNull(result.resource_additions),
          resourceChanges: numberOrNull(result.resource_changes),
          resourceDestructions: numberOrNull(result.resource_destructions),
          resourceImports: numberOrNull(result.resource_imports),
        };
        await completeAgentJob(agent.id, job.id, completion);
      } else {
        const stackJobId = jobData !== null && typeof jobData.stack_job_id === "string" ? jobData.stack_job_id : null;
        const stackJob = stackJobId === null ? undefined : await db.query.stackAgentJobs.findFirst({
          where: and(
            eq(stackAgentJobs.id, stackJobId),
            eq(stackAgentJobs.phase, phase),
            eq(stackAgentJobs.agentId, agent.id),
            eq(stackAgentJobs.status, "claimed"),
          ),
        });
        if (stackJob !== undefined) {
          const result: Record<string, unknown> = {};
          if (jobData !== null) {
            for (const key of ["has_changes", "has-changes", "deferred_changes", "deferred-changes", "resource_additions", "resource_changes", "resource_destructions", "resource_imports"]) {
              if (jobData[key] !== undefined) result[key] = jobData[key];
            }
            for (const key of ["state", "json_state"]) {
              if (jobData[key] === undefined) continue;
              const value = jsonStringOrNull(jobData[key]);
              if (value === undefined) {
                set.status = 422;
                return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Agent ${key} payload must be a valid JSON string` }] };
              }
              result[key] = value;
            }
          }
          await completeStackAgentJob(agent.id, stackJob.id, { status: jobStatus === "finished" ? "completed" : "errored", errorMessage: typeof jobPayload.error === "string" ? jobPayload.error : null, result });
        }
      }
      await db.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agent.id));
    } else {
      const agentStatus = status === "busy" ? "busy" : status === "exited" ? "exited" : "idle";
      await db.update(agents).set({ status: agentStatus, lastPingAt: now }).where(eq(agents.id, agent.id));
      const stackJobId = jobData !== null && typeof jobData.stack_job_id === "string" ? jobData.stack_job_id : null;
      if (stackJobId !== null) await heartbeatStackAgentJob(agent.id, stackJobId);
    }

    const messageIndex = ctx.request.headers.get("tfc-agent-message-index");
    if (set.headers === undefined) set.headers = {};
    if (messageIndex !== null) set.headers["tfc-agent-message-index"] = messageIndex;
    set.headers["content-type"] = "application/json";
    return {};
  })

  .get("/api/agent/update", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const version = process.env.TERRENCE_AGENT_UPDATE_VERSION?.trim() ?? "";
    const url = process.env.TERRENCE_AGENT_UPDATE_URL?.trim() ?? "";
    const sha256 = process.env.TERRENCE_AGENT_UPDATE_SHA256?.trim().toLowerCase() ?? "";
    if (version === "" || !URL.canParse(url) || !/^[0-9a-f]{64}$/.test(sha256)) {
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
      const claimed = await db.update(agentForwardedRequests).set({
        status: "claimed",
        agentId: agent.id,
        claimedAt: Date.now(),
      }).where(and(eq(agentForwardedRequests.id, candidate.id), eq(agentForwardedRequests.status, "queued"))).returning();
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
    const responseStatus = typeof body?.status === "number" && Number.isInteger(body.status) && body.status >= 100 && body.status <= 599 ? body.status : null;
    // A forwarded response without a body is valid (204 No Content, 304 Not
    // Modified, HEAD responses). Only require responseStatus; default an
    // omitted body to "" so these responses are not rejected as 422 while a
    // non-string body (a malformed payload) still fails loudly.
    const rawResponseBody = body?.body;
    if (typeof rawResponseBody === "string" && rawResponseBody.length > MAX_FORWARDED_RESPONSE_BASE64_BYTES) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Forwarded response body exceeds the size limit" }] };
    }
    const responseBody = typeof rawResponseBody === "string" ? rawResponseBody : rawResponseBody === undefined ? "" : null;
    const errorMessage = typeof body?.error === "string" ? body.error.slice(0, 2_000) : null;
    const rawHeaders = body?.headers;
    const responseHeaders: Record<string, string[]> = {};
    if (rawHeaders !== null && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      for (const [name, values] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !Array.isArray(values) || !values.every((value): value is string => typeof value === "string" && !/[\r\n]/.test(value))) {
          set.status = 422;
          return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid forwarded response headers" }] };
        }
        responseHeaders[name] = values;
      }
    }
    if ((responseStatus === null || responseBody === null) && errorMessage === null) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A forwarded response or error is required" }] };
    }
    const updated = await db.update(agentForwardedRequests).set({
      status: errorMessage === null ? "completed" : "errored",
      responseStatus,
      responseHeaders,
      responseBody,
      errorMessage,
      completedAt: Date.now(),
      // The request is done; the agent no longer needs the original request
      // headers/body to replay it. Drop them so credentials that may have
      // been forwarded (Authorization, cookies) are not persisted with the
      // completed row in the database or a support bundle.
      headers: {},
      body: null,
    }).where(and(
      eq(agentForwardedRequests.id, ctx.params.request_id ?? ""),
      eq(agentForwardedRequests.agentId, agent.id),
      eq(agentForwardedRequests.status, "claimed"),
    )).returning({ id: agentForwardedRequests.id });
    if (updated.length === 0) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {};
  })

  // --- Job claim ------------------------------------------------------------
  .get("/api/agent/jobs", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    // The registered accept list is authoritative: the agent declared its
    // workload set when it registered (validated against AGENT_WORKLOAD_TYPES
    // then persisted). The tfc-agent-accept header may only narrow that set
    // per request — never widen it — so a registration of "none" cannot be
    // bypassed by polling with a header, and an agent cannot silently upgrade
    // its own privileges.
    const registered = (agent.accept ?? DEFAULT_AGENT_ACCEPT);
    const registeredSet = new Set(registered === "none" ? [] : registered.split(","));
    const headerValue = ctx.request.headers.get("tfc-agent-accept");
    const accepted = headerValue === null
      ? registeredSet
      : new Set(headerValue.split(",").filter((value): boolean => registeredSet.has(value)));
    const claimed = await claimAgentJob(agent, ["plan", "apply"].filter((phase): boolean => accepted.has(phase)));
    if (claimed === undefined) {
      const stackClaimed = await claimStackAgentJob(agent, ["plan", "apply"].filter((phase): boolean => accepted.has(`stack_${phase}`)));
      if (stackClaimed === undefined) {
        set.status = 204;
        return undefined;
      }
      return await stackAgentPayload(stackClaimed, agentApiBaseUrl(ctx.request));
    }
    const { job, run, workspace, configuration } = claimed;
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) });
    if (org === undefined) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const baseUrl = agentApiBaseUrl(ctx.request);
    const runToken = await agentRunToken(run.id, workspace.id, workspace.orgId);
    const version = run.terraformVersion ?? workspace.terraformVersion ?? org.defaultTerraformVersion ?? "latest";
    const terraformInfo = await terraformReleaseInfo(version);
    if (terraformInfo === null) {
      set.status = 503;
      return { errors: [{ status: "503", title: "Service Unavailable", detail: "Unable to resolve Terraform release" }] };
    }
    const environment = await agentEnvironment(workspace.id, workspace.orgId, workspace.projectId ?? null);
    const details: AgentJobDetails = { job, run, workspace, organizationName: org.name, configuration };
    // The agent decodes `type`, `job_id` and the per-phase container from the
    // response top level; `data` is the run attribute map. (Verified against
    // tfc-agent 1.30.1: a payload nested under a single `data` key decodes
    // with an empty job type and is not dispatchable.)
    // Terraform variables are delivered as TF_VAR_* environment entries; the
    // container `variables` object is not consumed by the agent, so send an
    // empty object rather than duplicating sensitive values into a dead field.
    const payload = await buildAgentJobPayload(details, baseUrl, runToken, terraformInfo, {}, environment);
    return payload;
  })

  .get("/api/agent/jobs/:job_id/status", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number };
    const agent = await agentFromRequest(ctx);
    if (agent === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const job = await db.query.agentJobs.findFirst({
      where: and(eq(agentJobs.id, ctx.params.job_id ?? ""), eq(agentJobs.agentId, agent.id)),
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
    const claimed = agent === undefined ? undefined : await findClaimedStackAgentJob(agent.id, ctx.params.job_id ?? "");
    const runArchivePath = typeof (claimed?.deploymentRun.payload ?? {}).archivePath === "string" ? (claimed?.deploymentRun.payload ?? {}).archivePath as string : null;
    const configurationArchivePath = typeof (claimed?.configuration.payload ?? {}).archivePath === "string" ? (claimed?.configuration.payload ?? {}).archivePath as string : null;
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
    const details = await claimedJobForArtifact(ctx, ctx.params.job_id ?? "");
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
    try {
      const data = await readFile(await flattenedConfigurationArchive(cvId));
      set.headers = { "content-type": "application/gzip", "content-length": String(data.byteLength) };
      return new Response(data);
    } catch {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
  })

  .get("/api/agent/jobs/:job_id/filesystem", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const details = await claimedJobForArtifact(ctx, ctx.params.job_id ?? "");
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
    const details = await claimedJobForArtifact(ctx, ctx.params.job_id ?? "");
    if (details === undefined) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const buffer = await rawBody(ctx);
    if (buffer.byteLength > MAX_AGENT_FILESYSTEM_BYTES) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const path = agentFilesystemPath(details.job.runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer, { mode: 0o600 });
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
    const details = await claimedJobForArtifact(ctx, ctx.params.job_id ?? "");
    if (details === undefined || details.job.phase !== "plan") {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const planJson = await jsonBody(ctx);
    if (planJson === undefined) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    await writePlanJsonArtifact(details.job.runId, planJson);
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
    (ctx.set as { status?: number }).status = 200;
    return {};
  })
  .put("/api/agent/jobs/:job_id/upload", async (ctx: AgentCtx): Promise<unknown> => {
    (ctx.set as { status?: number }).status = 200;
    return {};
  })
  .post("/api/agent/jobs/:job_id/outcomes/:kind", async (ctx: AgentCtx): Promise<unknown> => {
    (ctx.set as { status?: number }).status = 200;
    return {};
  })
  .put("/api/agent/jobs/:job_id/apply-description", async (ctx: AgentCtx): Promise<unknown> => {
    (ctx.set as { status?: number }).status = 200;
    return {};
  })
  .put("/api/agent/jobs/:job_id/state-description", async (ctx: AgentCtx): Promise<unknown> => {
    (ctx.set as { status?: number }).status = 200;
    return {};
  });

async function appendLog(ctx: AgentCtx): Promise<unknown> {
  const set = ctx.set as { status?: number };
  const details = await claimedJobForArtifact(ctx, ctx.params.job_id ?? "");
  if (details === undefined) {
    set.status = 401;
    return { errors: [{ status: "401", title: "Unauthorized" }] };
  }
  const raw = (await rawBody(ctx)).toString("utf8");
  // The agent streams log chunks; \x02 flushes the buffer and \x03 ends it.
  const text = raw.replace(/\u0002/g, "").replace(/\u0003/g, "");
  if (text.trim() !== "") {
    // The final PUT repeats the last PATCHed chunk; skip exact duplicates so
    // the run log does not double up every line.
    const last = await db.query.logs.findFirst({
      where: and(eq(logs.runId, details.job.runId), eq(logs.phase, details.job.phase)),
      orderBy: [desc(logs.createdAt)],
    });
    if (last === undefined || last.outputText !== text) {
      await appendAgentJobLog(details.job.agentId ?? "", details.job.id, text.slice(0, 1024 * 1024));
    }
  }
  return {};
}

async function storeSideArtifact(ctx: AgentCtx, kind: string, ext: string): Promise<unknown> {
  const set = ctx.set as { status?: number };
  const details = await claimedJobForArtifact(ctx, ctx.params.job_id ?? "");
  if (details === undefined) {
    set.status = 401;
    return { errors: [{ status: "401", title: "Unauthorized" }] };
  }
  const raw = (await rawBody(ctx)).toString("utf8");
  if (raw.length > MAX_AGENT_BODY_BYTES) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
  }
  const path = sideArtifactPath(details.job.runId, kind, ext);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw, { mode: 0o600 });
  return {};
}
