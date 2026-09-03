import { Elysia } from "elysia";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { durableJobs } from "../db/schema";
import {
  findAuthorizedRun,
} from "../lib/utils";
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
  saveExplanation,
  splitInlineThinking,
  type ExplainKind,
  type ReasoningEffort,
  type ExplainSource,
} from "../lib/run-explanations";
import { authPlugin } from "../auth";
import { log } from "../lib/log";
import { enqueueDurableJob } from "../lib/durable-jobs";

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

export const operationsRoutes = new Elysia({ name: "operations" })
  .use(authPlugin)
  // --- AI run explainer (kanban 21.2) ------------------------------------
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
      return notFound(set);
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
        return streamExplainResponse(resolvedSettings, source, runId, kind, model, reasoningEffort, request, refresh);
      }
      // Background the non-streaming generation: enqueue a durable job and
      // return 202 so a tab close does not abort the LLM call. Concurrent
      // requests for the same (run, kind) dedupe to the same job.
      const job = await enqueueDurableJob("plan-explanation", { runId, kind }, { dedupeKey });
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
    const stream = new ReadableStream<Uint8Array>({
      async start(controller: ReadableStreamDefaultController<Uint8Array>) {
        // Some runtimes expose a signal on the controller (fires on stream
        // cancellation) but Bun's controller currently does not, and the TS
        // lib types omit it anyway. Fall back to the request signal, which is
        // always a real AbortSignal and covers client disconnects.
        const controllerSignal = (controller as ReadableStreamDefaultController<Uint8Array> & { readonly signal?: AbortSignal }).signal;
        const clientSignal = controllerSignal ?? request.signal;
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
              if (parts.thinking !== "") send(controller, "thinking", { text: parts.thinking });
              send(controller, "content", { text: parts.content });
              if (clientSignal.aborted) return;
              try {
                await saveExplanation(runId, kind, model, parts.content);
              } catch (error: unknown) {
                log.warn(`Failed to persist plan explanation for run ${runId}: ${String(error)}`);
                throw new Error("Failed to persist the explanation");
              }
              send(controller, "done", { model, "reasoning-effort": reasoningEffort, "generated-at": new Date().toISOString() });
              return;
            }
            const content: string[] = [];
            await forEachUpstreamDelta(
              upstream,
              (channel, text) => {
                if (clientSignal.aborted) return;
                if (channel === "thinking") {
                  send(controller, channel, { text });
                  return;
                }
                content.push(text);
                send(controller, channel, { text });
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
              send(controller, "thinking", { text: split.thinking });
            }
            if (!clientSignal.aborted) {
              try {
                await saveExplanation(runId, kind, model, contentText);
              } catch (error: unknown) {
                log.warn(`Failed to persist plan explanation for run ${runId}: ${String(error)}`);
                throw new Error("Failed to persist the explanation");
              }
            }
            if (!clientSignal.aborted) send(controller, "done", { model, "reasoning-effort": reasoningEffort, "generated-at": new Date().toISOString() });
          });
        } catch (error: unknown) {
          if (!clientSignal.aborted) {
            send(controller, "error", { message: error instanceof Error ? error.message : String(error) });
          }
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
