import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentPoolTokens, agents, agentJobs, organizations, runs } from "../db/schema";
import { authPlugin } from "../auth";
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
import { writePlanJsonArtifact } from "../lib/plan-json";
import {
  agentApiBaseUrl,
  agentFilesystemPath,
  agentRunToken,
  agentTerraformVariables,
  buildAgentJobPayload,
  terraformReleaseInfo,
  type AgentJobDetails,
} from "../lib/agent-api";

const MAX_AGENT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_FILESYSTEM_BYTES = 256 * 1024 * 1024;

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
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = await db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.token, tokenHash) });
  return row === undefined ? undefined : { poolId: row.agentPoolId, tokenId: row.id };
}

async function agentFromRequest(ctx: AgentCtx): Promise<Agent | undefined> {
  const agentId = ctx.request.headers.get("tfc-agent-id");
  if (agentId === null || agentId === "") return undefined;
  return authenticateAgent(agentId, ctx.request.headers.get("authorization"));
}

async function claimedJobFor(
  agent: Agent | undefined,
  jobId: string,
): Promise<ClaimedAgentJob | undefined> {
  if (agent === undefined || jobId === "") return undefined;
  return findClaimedAgentJob(agent.id, jobId);
}

function storageRoot(): string {
  return process.env.STORAGE_DIR ?? new URL("../../storage", import.meta.url).pathname;
}

function sideArtifactPath(runId: string, kind: string, ext: string): string {
  return resolve(storageRoot(), "plan-json", `${runId}.${kind}.${ext}`);
}

async function configurationArchivePath(cvId: string): Promise<string> {
  return join(storageRoot(), "cv", `config-${cvId}.tar.gz`);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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
        const completion: AgentJobCompletion = {
          status: jobStatus === "finished" ? "completed" : "errored",
          errorMessage,
          result,
          planJson: null,
          statePayload: null,
          jsonState: null,
          jsonStateOutputs: null,
          resourceAdditions: numberOrNull(result.resource_additions),
          resourceChanges: numberOrNull(result.resource_changes),
          resourceDestructions: numberOrNull(result.resource_destructions),
          resourceImports: numberOrNull(result.resource_imports),
        };
        await completeAgentJob(agent.id, job.id, completion);
      }
      await db.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agent.id));
    } else {
      const agentStatus = status === "busy" ? "busy" : "idle";
      await db.update(agents).set({ status: agentStatus, lastPingAt: now }).where(eq(agents.id, agent.id));
    }

    const messageIndex = ctx.request.headers.get("tfc-agent-message-index");
    if (set.headers === undefined) set.headers = {};
    if (messageIndex !== null) set.headers["tfc-agent-message-index"] = messageIndex;
    set.headers["content-type"] = "application/json";
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
    const claimed = await claimAgentJob(agent);
    if (claimed === undefined) {
      set.status = 204;
      return undefined;
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
    const variables = await agentTerraformVariables(workspace.id, workspace.orgId, workspace.projectId ?? null);
    const details: AgentJobDetails = { job, run, workspace, organizationName: org.name, configuration };
    // The agent decodes `type`, `job_id` and the per-phase container from the
    // response top level; `data` is the run attribute map. (Verified against
    // tfc-agent 1.30.1: a payload nested under a single `data` key decodes
    // with an empty job type and is not dispatchable.)
    return buildAgentJobPayload(details, baseUrl, runToken, terraformInfo, variables);
  })

  // --- Artifact endpoints (agent-token + claimed-job scoped) ----------------
  .get("/api/agent/jobs/:job_id/configuration-version", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const agent = await agentFromRequest(ctx);
    const details = await claimedJobFor(agent, ctx.params.job_id ?? "");
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
      const data = await readFile(await configurationArchivePath(cvId));
      set.headers = { "content-type": "application/gzip", "content-length": String(data.byteLength) };
      return new Response(data);
    } catch {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
  })

  .get("/api/agent/jobs/:job_id/filesystem", async (ctx: AgentCtx): Promise<unknown> => {
    const set = ctx.set as { status?: number; headers?: Record<string, string | number> };
    const agent = await agentFromRequest(ctx);
    const details = await claimedJobFor(agent, ctx.params.job_id ?? "");
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
    const agent = await agentFromRequest(ctx);
    const details = await claimedJobFor(agent, ctx.params.job_id ?? "");
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
    const agent = await agentFromRequest(ctx);
    const details = await claimedJobFor(agent, ctx.params.job_id ?? "");
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
  const agent = await agentFromRequest(ctx);
  const details = await claimedJobFor(agent, ctx.params.job_id ?? "");
  if (details === undefined) {
    set.status = 401;
    return { errors: [{ status: "401", title: "Unauthorized" }] };
  }
  const raw = (await rawBody(ctx)).toString("utf8");
  // The agent streams log chunks; \x02 flushes the buffer and \x03 ends it.
  const text = raw.replace(/\u0002/g, "").replace(/\u0003/g, "");
  if (text.trim() !== "" && agent !== undefined) {
    await appendAgentJobLog(agent.id, details.job.id, text.slice(0, 1024 * 1024));
  }
  return {};
}

async function storeSideArtifact(ctx: AgentCtx, kind: string, ext: string): Promise<unknown> {
  const set = ctx.set as { status?: number };
  const agent = await agentFromRequest(ctx);
  const details = await claimedJobFor(agent, ctx.params.job_id ?? "");
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
