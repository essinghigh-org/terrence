import { Elysia } from "elysia";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { durableJobs } from "../db/schema";
import {
  findAuthorizedRun,
  findAuthorizedWorkspace,
} from "../lib/utils";
import { assessWorkspacePreflight, preflightResource } from "../lib/workspace-preflight";
import { getSettings, resolvePlanExplainerSettings } from "../lib/settings";
import {
  EXPLAIN_KINDS,
  buildExplainSource,
  configuredReasoningEffort,
  explainError,
  fetchUpstream,
  findExplanation,
  forEachUpstreamDelta,
  parseCompletionBody,
  persistExplainerOutput,
  scrubExplanationContent,
  splitInlineThinking,
  type ExplainKind,
  type ReasoningEffort,
  type ExplainSource,
} from "../lib/run-explanations";
import { authPlugin } from "../auth";
import { log } from "../lib/log";
import { DurableJobBudgetError, enqueueDurableJob } from "../lib/durable-jobs";
import { requestOperationContext } from "../lib/secure-request";

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<{ readonly id: string }> | null;
  orgId: string | null;
  teamId: string | null;
  request: Request;
  set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
}>;

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

function notFound(set: SetObj): { errors: { status: string; title: string }[] } {
  (set as { status: number }).status = 404;
  return { errors: [{ status: "404", title: "Not Found" }] };
}

function explainAuditContext(user: Readonly<{ readonly id: string }> | null | undefined, orgId: string | null | undefined): Readonly<{ userId: string | null; orgId: string | null }> {
  return { userId: user?.id ?? null, orgId: orgId ?? null };
}

function preflightBodyProbes(body: unknown): Readonly<{ probes?: readonly string[]; invalid: boolean }> {
  if (body === undefined || body === null) return { invalid: false };
  if (typeof body !== "object" || Array.isArray(body)) return { invalid: true };
  const data = (body as Record<string, unknown>)["data"];
  if (data === undefined) return { invalid: false };
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { invalid: true };
  const attributes = (data as Record<string, unknown>)["attributes"];
  if (attributes === undefined) return { invalid: false };
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) return { invalid: true };
  const raw = (attributes as Record<string, unknown>)["probes"];
  if (raw === undefined) return { invalid: false };
  if (!Array.isArray(raw) || raw.length > 8 || raw.some((probe): boolean => typeof probe !== "string" || !["connectivity", "identity"].includes(probe))) return { invalid: true };
  return { probes: raw as string[], invalid: false };
}

function preflightError(set: SetObj, status: number, detail: string): Readonly<{ errors: readonly [{ status: string; title: string; detail: string }] }> {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title: status === 422 ? "Unprocessable Entity" : "Not Found", detail }] };
}

export const operationsRoutes = new Elysia({ name: "operations" })
  .use(authPlugin)
    // Workspace-scoped run readiness. These endpoints inspect only bounded,
    // persisted control-plane state. Optional probes are represented as
    // deferred checks so the eventual worker/agent/client context remains the
    // authority and the control plane never follows an arbitrary URL.
    .get("/api/v2/workspaces/:workspace_id/preflight", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
      const workspace = await findAuthorizedWorkspace(params["workspace_id"] ?? "", user?.id, orgId ?? null, teamId ?? null, "read");
      if (workspace === undefined) return notFound(set);
      return preflightResource(await assessWorkspacePreflight(workspace));
    })
    .post("/api/v2/workspaces/:workspace_id/preflight", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
      const workspace = await findAuthorizedWorkspace(params["workspace_id"] ?? "", user?.id, orgId ?? null, teamId ?? null, "read");
      if (workspace === undefined) return notFound(set);
      const parsed = preflightBodyProbes(body);
      if (parsed.invalid) return preflightError(set, 422, "Preflight probes must be connectivity or identity.");
      return preflightResource(await assessWorkspacePreflight(workspace, parsed.probes === undefined ? {} : { probes: parsed.probes }));
    })
    .post("/api/v2/workspaces/:workspace_id/actions/preflight", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
      const workspace = await findAuthorizedWorkspace(params["workspace_id"] ?? "", user?.id, orgId ?? null, teamId ?? null, "read");
      if (workspace === undefined) return notFound(set);
      const parsed = preflightBodyProbes(body);
      if (parsed.invalid) return preflightError(set, 422, "Preflight probes must be connectivity or identity.");
      return preflightResource(await assessWorkspacePreflight(workspace, parsed.probes === undefined ? {} : { probes: parsed.probes }));
    })
    // --- AI run explainer ---------------------------------------------------
    // Read-only convenience: feeds the sanitized stored plan JSON (or a failed
    // apply log) to a user-configured OpenAI-compatible endpoint and returns the
    // plain-language explanation. Explanations are cached per (run, kind) so
    // re-opening the dialog never re-burns tokens; `refresh: true` forces a
    // fresh generation and `stream: true` relays upstream SSE deltas. Never part
    // of the trusted apply decision.

    // POST body shape: { data: { type: "plan-explanations",
    //   attributes: { kind: "plan" | "apply", refresh?: boolean, stream?: boolean } } }.
    // kind/refresh/stream are additive; the original { data: { type } } payload
    // still means kind="plan", no refresh, JSON response.

    .get("/api/v2/runs/:run_id/explain", async ({ params, user, orgId, teamId, set, request }: ParamCtx): Promise<unknown> => {
      const runId = params["run_id"] ?? "";
      const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "run-read");
      if (authorized === undefined) return notFound(set);
      const settings = await getSettings("plan-explainer");
      if (settings["enabled"] !== true) return notFound(set);
      const reasoningEffort = configuredReasoningEffort(settings["reasoning-effort"]);
      const kindOrError = parseExplainKind(new URL(request.url).searchParams.get("kind"), set);
      if (typeof kindOrError !== "string") return kindOrError.body;
      const kind = kindOrError;
      const cached = await findExplanation(runId, kind);
      if (cached !== undefined) {
        return explanationResource(runId, kind, cached.content, cached.model, reasoningEffort, new Date(cached.createdAt).toISOString(), true);
      }
      const dedupeKey = `${runId}:${kind}`;
      const job = await db.query.durableJobs.findFirst({
        where: and(eq(durableJobs.kind, "plan-explanation"), eq(durableJobs.dedupeKey, dedupeKey)),
      });
      if (job !== undefined && (job.status === "queued" || job.status === "running")) {
        return explainJobResource(runId, kind, job, reasoningEffort);
      }
      if (job !== undefined && job.status === "failed") {
        const err = explainError(502, "Bad Gateway", job.lastError ?? "Plan explainer failed");
        (set as { status: number }).status = err.status;
        return err.body;
      }
      const resolvedSettings = await resolvePlanExplainerSettings(settings);
      if (resolvedSettings === null) return notFound(set);
      const source = await buildExplainSource(runId, kind);
      if (source === undefined) {
        const err = explainError(409, "Conflict", explainMissingArtifactDetail(kind));
        (set as { status: number }).status = err.status;
        return err.body;
      }
      // Read-only probe: the artifact exists but nobody asked for an
      // explanation yet. Tell the client to POST instead of a bare 404
      // (issue #645); the source build above is what distinguishes this
      // from the missing-artifact 409.
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "No explanation has been requested for this run yet. POST to this endpoint to generate one." }] };
    })
    .post("/api/v2/runs/:run_id/explain", async ({ params, body, user, orgId, teamId, set, request }: ParamCtx): Promise<unknown> => {
      const runId = params["run_id"] ?? "";
      const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "run-read");
      if (authorized === undefined) return notFound(set);
      const settings = await getSettings("plan-explainer");
      if (settings["enabled"] !== true) return notFound(set);
      const reasoningEffort = configuredReasoningEffort(settings["reasoning-effort"]);
      const attributes = readExplainAttributes(body);
      const kindOrError = parseExplainKind(attributes["kind"], set);
      if (typeof kindOrError !== "string") return kindOrError.body;
      const kind = kindOrError;
      const refresh = attributes["refresh"] === true;
      const streamRequested = attributes["stream"] === true;
      if (!refresh) {
        const cached = await findExplanation(runId, kind);
        if (cached !== undefined) {
          if (streamRequested) return cachedSseResponse(cached.content, kind, cached.model, reasoningEffort, cached.createdAt);
          return explanationResource(runId, kind, cached.content, cached.model, reasoningEffort, new Date(cached.createdAt).toISOString(), true);
        }
      }
      const resolvedSettings = await resolvePlanExplainerSettings(settings);
      if (resolvedSettings === null) {
        (set as { status: number }).status = 503;
        return { errors: [{ status: "503", title: "Service Unavailable", detail: "Plan explainer is not fully configured" }] };
      }
      const model = resolvedSettings["model"] as string;
      const source = await buildExplainSource(runId, kind);
      if (source === undefined) {
        const err = explainError(409, "Conflict", explainMissingArtifactDetail(kind));
        (set as { status: number }).status = err.status;
        return err.body;
      }
      const dedupeKey = `${runId}:${kind}`;
      if (streamRequested) {
        if (!refresh) {
          const cachedStream = await findExplanation(runId, kind);
          if (cachedStream !== undefined && cachedStream.content !== "") {
            return cachedSseResponse(cachedStream.content, kind, cachedStream.model, reasoningEffort, cachedStream.createdAt);
          }
          const pendingJob = await db.query.durableJobs.findFirst({
            where: and(eq(durableJobs.kind, "plan-explanation"), eq(durableJobs.dedupeKey, dedupeKey)),
          });
          if (pendingJob !== undefined && (pendingJob.status === "queued" || pendingJob.status === "running")) {
            return sseJobProgressResponse(runId, kind, pendingJob, model, reasoningEffort, request);
          }
        }
        return streamExplainResponse(resolvedSettings, source, runId, kind, model, reasoningEffort, request, refresh, explainAuditContext(user, orgId));
      }
      // Background the non-streaming generation: enqueue a durable job and
      // return 202 so a tab close does not abort the LLM call. Concurrent
      // requests for the same (run, kind) dedupe to the same job.
      let job;
      try {
        job = await enqueueDurableJob(
          "plan-explanation",
          { runId, kind, organizationId: orgId, jobClass: "explanation", estimatedBytes: 1 * 1024 * 1024 },
          {
            dedupeKey,
            budget: { organizationId: orgId, jobClass: "explanation", estimatedBytes: 1 * 1024 * 1024 },
          },
        );
      } catch (error: unknown) {
        if (!(error instanceof DurableJobBudgetError)) throw error;
        (set as { status: number }).status = error.status;
        if (error.status === 429 && error.admission.retryAfterMs !== null) {
          (set.headers as Record<string, string | number>)["Retry-After"] = Math.ceil(error.admission.retryAfterMs / 1_000);
        }
        return {
          errors: [{
            status: String(error.status),
            title: error.status === 413 ? "Payload Too Large" : "Too Many Requests",
            detail: error.status === 413
              ? "The plan explanation estimate exceeds the configured artifact byte budget."
              : "Plan explanation capacity is temporarily full; retry after the queue drains.",
          }],
        };
      }
      if (job.status === "succeeded") {
        // Rare: a terminal job was recycled in the same call; fall through
        // to serve the cached explanation if present.
        const cachedAfter = await findExplanation(runId, kind);
        if (cachedAfter !== undefined) {
          return explanationResource(runId, kind, cachedAfter.content, cachedAfter.model, reasoningEffort, new Date(cachedAfter.createdAt).toISOString(), true);
        }
      }
      (set as { status: number }).status = 202;
      return explainJobResource(runId, kind, job, reasoningEffort);
    });

  function readExplainAttributes(body: unknown): Readonly<Record<string, unknown>> {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"];
    const attributes = data !== null && typeof data === "object" ? (data as Record<string, unknown>)["attributes"] : undefined;
    return attributes !== null && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  }

  function parseExplainKind(value: unknown, set: SetObj): ExplainKind | Readonly<{ status: number; body: unknown }> {
    if (value === undefined || value === null || value === "") return "plan";
    const asString = typeof value === "string" ? value : "";
    if (EXPLAIN_KINDS.includes(asString as ExplainKind)) return asString as ExplainKind;
    const err = explainError(422, "Unprocessable Entity", `explain kind must be one of: ${EXPLAIN_KINDS.join(", ")}`);
    (set as { status: number }).status = err.status;
    return err;
  }

  function explainMissingArtifactDetail(kind: ExplainKind): string {
    return kind === "plan" ? "No plan JSON is available for this run" : "No apply log is available for this run";
  }

  function explanationResource(
    runId: string,
    kind: ExplainKind,
    explanation: string,
    model: string,
    reasoningEffort: ReasoningEffort | null,
    generatedAt: string,
    cached: boolean,
  ): Readonly<{ data: Readonly<{ id: string; type: string; attributes: Record<string, unknown> }> }> {
    return {
      data: {
        id: runId,
        type: "plan-explanations",
        attributes: {
          kind,
          explanation,
          model,
          "reasoning-effort": reasoningEffort,
          "generated-at": generatedAt,
          cached,
        },
      },
    };
  }

  function explainJobResource(
    runId: string,
    kind: ExplainKind,
    job: Readonly<{ id: string; status: string; createdAt: number; updatedAt: number; lastError?: string | null }>,
    reasoningEffort: ReasoningEffort | null,
  ): Readonly<{ data: Readonly<{ id: string; type: string; attributes: Record<string, unknown> }> }> {
    return {
      data: {
        id: runId,
        type: "plan-explanations",
        attributes: {
          kind,
          status: job.status,
          "reasoning-effort": reasoningEffort,
          "job-id": job.id,
          "created-at": new Date(job.createdAt).toISOString(),
          "updated-at": new Date(job.updatedAt).toISOString(),
          ...(job.lastError !== null && job.lastError !== undefined && job.lastError !== "" ? { error: job.lastError } : {}),
        },
      },
    };
  }

  /** Replay a cached generation through the SSE envelope (no upstream call). */
  function cachedSseResponse(content: string, kind: ExplainKind, model: string, reasoningEffort: ReasoningEffort | null, createdAt: number): Response {
    const encoder = new TextEncoder();
    const events = [
      `event: meta\ndata: ${JSON.stringify({ kind, model, "reasoning-effort": reasoningEffort })}\n\n`,
      `event: content\ndata: ${JSON.stringify({ text: content })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ model, "reasoning-effort": reasoningEffort, "generated-at": new Date(createdAt).toISOString(), cached: true })}\n\n`,
    ];
    return new Response(new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /**
   * Streaming path: relay upstream SSE deltas to the browser as
   * `meta` / `thinking` / `content` / `done` / `error` events, persisting the
   * completed generation before `done` (a client abort skips persistence).
   * Providers that ignore `stream: true` and return plain JSON are folded into
   * the same event protocol so the client has a single parsing path.
   */
  async function streamExplainResponse(
    settings: Readonly<Record<string, unknown>>,
    source: ExplainSource,
    runId: string,
    kind: ExplainKind,
    model: string,
    reasoningEffort: ReasoningEffort | null,
    request: Request,
    forceRefresh: boolean,
    audit: Readonly<{ userId: string | null; orgId: string | null }>,
  ): Promise<Response> {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    if (!forceRefresh) {
      // A stream request must never answer with a JSON cache hit; deliver
      // the cached generation through the same SSE envelope instead.
      const cached = await findExplanation(runId, kind);
      if (cached !== undefined && cached.content !== "") {
        return cachedSseResponse(cached.content, kind, cached.model, reasoningEffort, cached.createdAt);
      }
    }
    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController<Uint8Array>, name: string, data: unknown): void => {
      controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    const finalizeStreamedContent = async (
      streamer: ReadableStreamDefaultController<Uint8Array>,
      contentText: string,
      scrubbedDeltas: number,
    ): Promise<void> => {
      const final = scrubExplanationContent(contentText, source.secrets);
      const scrubbedTotal = scrubbedDeltas + final.scrubbed;
      if (final.content !== contentText) send(streamer, "content-reset", { text: final.content });
      try {
        await persistExplainerOutput({
          runId, kind, model,
          settings,
          userId: audit.userId, orgId: audit.orgId,
          content: final.content,
          redactedInputSecrets: source.redactedInputSecrets,
          scrubbedOutputSecrets: scrubbedTotal,
        });
      } catch (error: unknown) {
        log.warn(`Failed to persist plan explanation for run ${runId}: ${String(error)}`);
        throw new Error("Failed to persist the explanation");
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller: ReadableStreamDefaultController<Uint8Array>) {
        // Some runtimes expose a signal on the controller (fires on stream
        // cancellation) but Bun's controller currently does not, and the TS
        // lib types omit it anyway. Fall back to the request signal, which is
        // always a real AbortSignal and covers client disconnects.
        const controllerSignal = (controller as ReadableStreamDefaultController<Uint8Array> & { readonly signal?: AbortSignal }).signal;
        const requestOperation = requestOperationContext({
          url: request.url,
          signal: controllerSignal ?? request.signal,
        });
        const clientSignal = requestOperation.signal;
        send(controller, "meta", { kind, model, "reasoning-effort": reasoningEffort });
        try {
          await fetchUpstream(settings, source.prompt, true, clientSignal, async (upstream, tick) => {
            if (!upstream.ok) throw new Error(`Plan explainer endpoint returned ${upstream.status}`);
            if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
              // Provider ignored stream: true. Fold the JSON response into the same
              // event protocol so the client has one parsing path.
              let parsed: unknown;
              try {
                parsed = await upstream.json();
              } catch (error: unknown) {
                log.warn(`Plan explainer returned an unparseable non-stream body for run ${runId}: ${String(error)}`);
                throw new Error("Plan explainer returned an unparseable response");
              }
              const parts = parseCompletionBody(parsed);
              if (parts.content === "") throw new Error("Plan explainer returned no explanation");
              if (parts.thinking !== "") {
                const scrubbedThinking = scrubExplanationContent(parts.thinking, source.secrets);
                send(controller, "thinking", { text: scrubbedThinking.content });
              }
              const scrubbed = scrubExplanationContent(parts.content, source.secrets);
              send(controller, "content", { text: scrubbed.content });
              if (clientSignal.aborted) return;
              try {
                await persistExplainerOutput({
                  runId, kind, model,
                  settings,
                  userId: audit.userId, orgId: audit.orgId,
                  content: scrubbed.content,
                  redactedInputSecrets: source.redactedInputSecrets,
                  scrubbedOutputSecrets: scrubbed.scrubbed,
                });
              } catch (error: unknown) {
                log.warn(`Failed to persist plan explanation for run ${runId}: ${String(error)}`);
                throw new Error("Failed to persist the explanation");
              }
              send(controller, "done", { model, "reasoning-effort": reasoningEffort, "generated-at": new Date().toISOString() });
              return;
            }
            const content: string[] = [];
            let scrubbedDeltas = 0;
            await forEachUpstreamDelta(
              upstream,
              (channel, text) => {
                if (clientSignal.aborted) return;
                if (channel === "thinking") {
                  // Thinking is transient and never persisted, but it is
                  // still served: scrub whole occurrences live. A secret
                  // split across two thinking deltas is a documented
                  // residual (content has the joined scrub + reset).
                  const scrubbedThinking = scrubExplanationContent(text, source.secrets);
                  send(controller, channel, { text: scrubbedThinking.content });
                  return;
                }
                // Scrub each delta live; a secret split across two deltas is
                // caught by the joined scrub below with a content-reset.
                const scrubbedDelta = scrubExplanationContent(text, source.secrets);
                scrubbedDeltas += scrubbedDelta.scrubbed;
                content.push(scrubbedDelta.content);
                send(controller, channel, { text: scrubbedDelta.content });
              },
              // Keep the idle deadline alive while deltas keep arriving.
              // An upstream that answers headers and then stalls is aborted
              // by fetchUpstream after EXPLAIN_TIMEOUT_MS of silence.
              tick,
            );
            if (clientSignal.aborted) return;
            let contentText = content.join("");
            if (contentText === "") throw new Error("Plan explainer returned no explanation");
            const split = splitInlineThinking(contentText);
            if (split.thinking !== "") {
              contentText = split.content;
              send(controller, "content-reset", { text: contentText });
              send(controller, "thinking", { text: scrubExplanationContent(split.thinking, source.secrets).content });
            }
            if (!clientSignal.aborted) {
              await finalizeStreamedContent(controller, contentText, scrubbedDeltas);
            }
            if (!clientSignal.aborted) send(controller, "done", { model, "reasoning-effort": reasoningEffort, "generated-at": new Date().toISOString() });
          });
        } catch (error: unknown) {
          if (!clientSignal.aborted) {
            send(controller, "error", { message: error instanceof Error ? error.message : String(error) });
          }
        } finally {
          requestOperation.dispose();
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /** When a stream is requested while a durable job is enqueued/running, return
   * progress as SSE so the dialog can poll via the same parser. A GET is used
   * as the polling tick. */
  function sseJobProgressResponse(
    runId: string,
    kind: ExplainKind,
    job: Readonly<{ id: string; status: string; createdAt: number; updatedAt: number }>,
    model: string,
    reasoningEffort: ReasoningEffort | null,
    request: Request,
  ): Response {
    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController<Uint8Array>, name: string, data: unknown): void => {
      controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        send(controller, "meta", { kind, model, "reasoning-effort": reasoningEffort, "job-id": job.id, status: job.status });
        send(controller, "progress", {
          status: job.status,
          "job-id": job.id,
          runId,
          kind,
          "created-at": new Date(job.createdAt).toISOString(),
          "updated-at": new Date(job.updatedAt).toISOString(),
        });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
