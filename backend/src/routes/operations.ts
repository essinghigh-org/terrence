import { Elysia } from "elysia";
import { eq, and, gte, inArray } from "drizzle-orm";
import { db } from "../db";
import { runs, workspaces, changeRequests } from "../db/schema";
import {
  checkOrgPermission,
  findAuthorizedRun,
  workspaceIdsForPermission,
} from "../lib/utils";
import { getSettings, planExplainerUsable } from "../lib/settings";
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
  type CompletionParts,
  type ExplainKind,
  type ReasoningEffort,
  type ExplainSource,
} from "../lib/run-explanations";
import { authPlugin } from "../auth";
import { log } from "../lib/log";
import { cachedOrgByName } from "../lib/cached-lookups";

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

// --- Change calendar (kanban 21.4) -------------------------------------
// Upcoming scheduled applies (runs awaiting confirmation), auto-destroys,
// and open change requests for an organization, sorted by when each item
// is expected to happen.

export const operationsRoutes = new Elysia({ name: "operations" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/change-calendar", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const organization = await cachedOrgByName(orgName);
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) {
      return notFound(set);
    }
    const wsIds = await workspaceIdsForPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "run-read");
    // null = org-wide access; resolve to the org's workspace ids so the
    // per-workspace queries below are uniform in both cases.
    const allowedWorkspaceIds = wsIds === null
      ? (await db.query.workspaces.findMany({
          columns: { id: true },
          where: eq(workspaces.orgId, organization.id),
        })).map((w: Readonly<{ id: string }>): string => w.id)
      : [...wsIds];
    const entries: Record<string, unknown>[] = [];
    if (allowedWorkspaceIds.length > 0) {
      const confirmedRuns = await db.query.runs.findMany({
          columns: { id: true, workspaceId: true, statusTimestamps: true, createdAt: true },
          where: and(inArray(runs.workspaceId, allowedWorkspaceIds), eq(runs.status, "confirmed")),
          limit: 100,
        });
      const pendingRequests = await db.query.changeRequests.findMany({
          columns: { id: true, workspaceId: true, subject: true, createdAt: true },
          where: and(inArray(changeRequests.workspaceId, allowedWorkspaceIds), eq(changeRequests.status, "pending")),
          limit: 100,
        });
      const workspaceIds = [...new Set([...confirmedRuns.map((r): string => r.workspaceId), ...pendingRequests.map((r): string => r.workspaceId)])];
      const names = workspaceIds.length === 0
        ? new Map<string, string>()
        : new Map((await db.query.workspaces.findMany({
            columns: { id: true, name: true },
            where: inArray(workspaces.id, workspaceIds),
          })).map((w: Readonly<{ id: string; name: string }>): [string, string] => [w.id, w.name]));
      for (const run of confirmedRuns) {
        const confirmedAt = (run.statusTimestamps as Readonly<Record<string, string>> | null)?.["confirmed-at"];
        entries.push({
          kind: "apply",
          at: confirmedAt ?? new Date(run.createdAt).toISOString(),
          runId: run.id,
          workspaceId: run.workspaceId,
          workspaceName: names.get(run.workspaceId) ?? null,
        });
      }
      for (const request of pendingRequests) {
        entries.push({
          kind: "change-request",
          at: new Date(request.createdAt).toISOString(),
          changeRequestId: request.id,
          subject: request.subject,
          workspaceId: request.workspaceId,
          workspaceName: names.get(request.workspaceId) ?? null,
        });
      }
    }
    const nowIso = new Date().toISOString();
    if (allowedWorkspaceIds.length > 0) {
      // Same run-read permission filter as confirmed runs / change requests:
      // auto-destroy schedules are only visible for workspaces the user can
      // read, so a scoped user cannot enumerate other workspaces' schedules.
      const autoDestroys = await db.query.workspaces.findMany({
        columns: { id: true, name: true, autoDestroyAt: true },
        where: and(
          eq(workspaces.orgId, organization.id),
          inArray(workspaces.id, allowedWorkspaceIds),
          gte(workspaces.autoDestroyAt, nowIso),
        ),
        limit: 100,
      });
      for (const workspace of autoDestroys) {
        entries.push({
          kind: "auto-destroy",
          at: workspace.autoDestroyAt,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        });
      }
    }
    entries.sort((a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): number =>
      String(a.at).localeCompare(String(b.at)));
    const data = entries.slice(0, 50).map((attributes: Record<string, unknown>): Record<string, unknown> => ({
      // Entry-specific id first so every item has a unique type+id pair:
      // a workspace can appear once per confirmed run / change request, so
      // workspaceId alone would collide for repeated entries.
      id: String(attributes.changeRequestId ?? attributes.runId ?? attributes.workspaceId ?? "entry"),
      type: "change-calendar-entry",
      attributes,
    }));
    return { data, meta: { "total-count": data.length } };
  })
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
      const runId = params.run_id ?? "";
      const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "run-read");
      if (authorized === undefined) return notFound(set);
      const settings = await getSettings("plan-explainer");
      if (settings.enabled !== true) return notFound(set);
      if (!planExplainerUsable(settings)) return notFound(set);
      const reasoningEffort = configuredReasoningEffort(settings["reasoning-effort"]);
      const kindOrError = parseExplainKind(new URL(request.url).searchParams.get("kind"), set);
      if (typeof kindOrError !== "string") return kindOrError.body;
      const kind = kindOrError;
      const source = await buildExplainSource(runId, kind, reasoningEffort);
      if (source === undefined) {
        const err = explainError(409, "Conflict", explainMissingArtifactDetail(kind));
        (set as { status: number }).status = err.status;
        return err.body;
      }
      const cached = await findExplanation(runId, kind, settings.model as string, source.inputHash);
      if (cached === undefined) return notFound(set);
      return explanationResource(runId, kind, cached.content, cached.model, reasoningEffort, new Date(cached.createdAt).toISOString(), true);
    })
    .post("/api/v2/runs/:run_id/explain", async ({ params, body, user, orgId, teamId, set, request }: ParamCtx): Promise<unknown> => {
      const runId = params.run_id ?? "";
      const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "run-read");
      if (authorized === undefined) return notFound(set);
      const settings = await getSettings("plan-explainer");
      if (settings.enabled !== true) return notFound(set);
      if (!planExplainerUsable(settings)) {
        (set as { status: number }).status = 503;
        return { errors: [{ status: "503", title: "Service Unavailable", detail: "Plan explainer is not fully configured" }] };
      }
      const reasoningEffort = configuredReasoningEffort(settings["reasoning-effort"]);
      const attributes = readExplainAttributes(body);
      const kindOrError = parseExplainKind(attributes.kind, set);
      if (typeof kindOrError !== "string") return kindOrError.body;
      const kind = kindOrError;
      const refresh = attributes.refresh === true;
      const streamRequested = attributes.stream === true;
      const model = settings.model as string;
      const source = await buildExplainSource(runId, kind, reasoningEffort);
      if (source === undefined) {
        const err = explainError(409, "Conflict", explainMissingArtifactDetail(kind));
        (set as { status: number }).status = err.status;
        return err.body;
      }
      if (!refresh && !streamRequested) {
        const cached = await findExplanation(runId, kind, model, source.inputHash);
        if (cached !== undefined) {
          return explanationResource(runId, kind, cached.content, cached.model, reasoningEffort, new Date(cached.createdAt).toISOString(), true);
        }
      }
      if (streamRequested) return streamExplainResponse(settings, source, runId, kind, model, reasoningEffort, request, refresh);
      return explainJsonResponse(set, settings, source, runId, kind, model, reasoningEffort);
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

  async function explainJsonResponse(
    set: SetObj,
    settings: Readonly<Record<string, unknown>>,
    source: ExplainSource,
    runId: string,
    kind: ExplainKind,
    model: string,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<unknown> {
    let parts: CompletionParts;
    try {
      parts = await fetchUpstream(settings, source.prompt, false, undefined, async (upstream) => {
        if (!upstream.ok) throw new Error(`Plan explainer endpoint returned ${upstream.status}`);
        let parsed: unknown;
        try {
          parsed = await upstream.json();
        } catch (error: unknown) {
          log.warn(`Plan explainer returned unparseable body for run ${runId}: ${String(error)}`);
          throw new Error("Plan explainer returned an unparseable response");
        }
        const completion = parseCompletionBody(parsed);
        if (completion.content === "") throw new Error("Plan explainer returned no explanation");
        return completion;
      });
    } catch (error: unknown) {
      const err = explainError(502, "Bad Gateway", error instanceof Error ? error.message : String(error));
      (set as { status: number }).status = err.status;
      return err.body;
    }
    try {
      await saveExplanation(runId, kind, model, parts.content, source.inputHash);
    } catch (error: unknown) {
      // A failed write must not hide a successful generation; the next
      // request simply regenerates.
      log.warn(`Failed to persist plan explanation for run ${runId}: ${String(error)}`);
    }
    return explanationResource(runId, kind, parts.content, model, reasoningEffort, new Date().toISOString(), false);
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
      const cached = await findExplanation(runId, kind, model, source.inputHash);
      if (cached !== undefined && cached.content !== "") {
        return cachedSseResponse(cached.content, kind, model, reasoningEffort, cached.createdAt);
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
                await saveExplanation(runId, kind, model, parts.content, source.inputHash);
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
                await saveExplanation(runId, kind, model, contentText, source.inputHash);
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
