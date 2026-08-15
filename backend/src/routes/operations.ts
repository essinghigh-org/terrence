import { Elysia } from "elysia";
import { eq, and, gte, lte, inArray, asc, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { runs, workspaces, changeRequests } from "../db/schema";
import {
  checkOrgPermission,
  findAuthorizedRun,
  workspaceIdsForPermission,
  pageRequest,
  pagination,
} from "../lib/utils";
import { getSettings, resolvePlanExplainerSettings } from "../lib/settings";
import { jsonExtract } from "../lib/db-json";
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
// is expected to happen. Applies distinguish true future-scheduled actions
// (runs.scheduledAt) from historical confirmation activity: the entry `at`
// is the scheduled time when one exists and `scheduled` is true; otherwise
// it falls back to the confirmation timestamp and `scheduled` is false.

type CalendarBound = Readonly<{ ms: number; iso: string }>;

/** Parse an inclusive range bound; ISO-8601 strings and epoch milliseconds
 * are accepted. Returns undefined for a missing bound and null for a
 * malformed one so the handler can 422 on garbage instead of silently
 * widening the range. */
function parseCalendarBound(raw: string | null): CalendarBound | null | undefined {
  if (raw === null || raw === "") return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  // ECMAScript Date time-value range: out-of-range numeric bounds would
  // throw RangeError from toISOString() and 500 the handler.
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return { ms, iso: new Date(ms).toISOString() };
}

/**
 * SQL range predicate over a confirmed run's effective apply time: its
 * epoch-ms scheduled_at when scheduled, otherwise the ISO confirmed-at
 * timestamp (stored in the status_timestamps JSON). Rows with neither are
 * excluded from a bounded range.
 */
function confirmedRunRangeCondition(
  start: CalendarBound | null,
  end: CalendarBound | null,
): SQL | undefined {
  if (start === null && end === null) return undefined;
  const scheduledConds: SQL[] = [];
  const confirmedConds: SQL[] = [];
  if (start !== null) {
    scheduledConds.push(sql`${runs.scheduledAt} >= ${start.ms}`);
    confirmedConds.push(sql`${jsonExtract(runs.statusTimestamps, '$."confirmed-at"')} >= ${start.iso}`);
  }
  if (end !== null) {
    scheduledConds.push(sql`${runs.scheduledAt} <= ${end.ms}`);
    confirmedConds.push(sql`${jsonExtract(runs.statusTimestamps, '$."confirmed-at"')} <= ${end.iso}`);
  }
  return sql`((${runs.scheduledAt} IS NOT NULL AND ${and(...scheduledConds)}) OR (${runs.scheduledAt} IS NULL AND ${and(...confirmedConds)}))`;
}

type CalendarEntry = Readonly<{
  kind: "apply" | "change-request" | "auto-destroy";
  at: string;
  scheduled: boolean;
  workspaceId: string;
  workspaceName: string | null;
  runId?: string;
  changeRequestId?: string;
  subject?: string | null;
  "scheduled-at"?: string | null;
}>;

function calendarEntryId(entry: CalendarEntry): string {
  return String(entry.changeRequestId ?? entry.runId ?? entry.workspaceId ?? "entry");
}

const CALENDAR_KIND_ORDER: Readonly<Record<CalendarEntry["kind"], number>> = {
  apply: 0,
  "auto-destroy": 1,
  "change-request": 2,
};

export const operationsRoutes = new Elysia({ name: "operations" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/change-calendar", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const organization = await cachedOrgByName(orgName);
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) {
      return notFound(set);
    }
    const searchParams = new URL(request.url).searchParams;
    const start = parseCalendarBound(searchParams.get("filter[start]"));
    if (start === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "filter[start] must be an ISO-8601 date or epoch milliseconds" }] };
    }
    const end = parseCalendarBound(searchParams.get("filter[end]"));
    if (end === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "filter[end] must be an ISO-8601 date or epoch milliseconds" }] };
    }
    if (start !== undefined && end !== undefined && start.ms > end.ms) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "filter[start] must not be later than filter[end]" }] };
    }
    const { number, size } = pageRequest(request);
    const wsIds = await workspaceIdsForPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "run-read");
    // null = org-wide access; resolve to the org's workspace ids so the
    // per-workspace queries below are uniform in both cases.
    const allowedWorkspaceIds = wsIds === null
      ? (await db.query.workspaces.findMany({
          columns: { id: true },
          where: eq(workspaces.orgId, organization.id),
        })).map((w: Readonly<{ id: string }>): string => w.id)
      : [...wsIds];
    const entries: CalendarEntry[] = [];
    if (allowedWorkspaceIds.length > 0) {
      const rangeCondition = confirmedRunRangeCondition(start ?? null, end ?? null);
      const confirmedRuns = await db.query.runs.findMany({
          columns: { id: true, workspaceId: true, statusTimestamps: true, createdAt: true, scheduledAt: true },
          where: and(
            inArray(runs.workspaceId, allowedWorkspaceIds),
            eq(runs.status, "confirmed"),
            ...(rangeCondition === undefined ? [] : [rangeCondition]),
          ),
          // Deterministic source ordering; the merged sort below re-orders by
          // effective time with id tie-breaks either way.
          orderBy: [asc(runs.createdAt), asc(runs.id)],
        });
      const pendingRequests = await db.query.changeRequests.findMany({
          columns: { id: true, workspaceId: true, subject: true, createdAt: true },
          where: and(
            inArray(changeRequests.workspaceId, allowedWorkspaceIds),
            eq(changeRequests.status, "pending"),
            ...(start === undefined && end === undefined ? [] : [
              ...(start === undefined ? [] : [gte(changeRequests.createdAt, start.ms)]),
              ...(end === undefined ? [] : [lte(changeRequests.createdAt, end.ms)]),
            ]),
          ),
          orderBy: [asc(changeRequests.createdAt), asc(changeRequests.id)],
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
        const scheduledAt = run.scheduledAt;
        // scheduled_at semantics (kanban t_19f3556e): an apply is only a
        // FUTURE scheduled action while its scheduled time is still ahead.
        // A confirmed run whose scheduled time has passed is historical
        // activity (shown at its confirmation time, not flagged scheduled).
        const futureScheduled = scheduledAt !== null && scheduledAt > Date.now();
        entries.push({
          kind: "apply",
          at: futureScheduled
            ? new Date(scheduledAt).toISOString()
            : (confirmedAt ?? new Date(run.createdAt).toISOString()),
          scheduled: futureScheduled,
          "scheduled-at": futureScheduled ? new Date(scheduledAt).toISOString() : null,
          runId: run.id,
          workspaceId: run.workspaceId,
          workspaceName: names.get(run.workspaceId) ?? null,
        });
      }
      for (const request of pendingRequests) {
        entries.push({
          kind: "change-request",
          at: new Date(request.createdAt).toISOString(),
          scheduled: false,
          changeRequestId: request.id,
          subject: request.subject,
          workspaceId: request.workspaceId,
          workspaceName: names.get(request.workspaceId) ?? null,
        });
      }
      // Same run-read permission filter as confirmed runs / change requests:
      // auto-destroy schedules are only visible for workspaces the user can
      // read, so a scoped user cannot enumerate other workspaces' schedules.
      // Without an explicit range the default is future-only (matching the
      // original endpoint); an explicit filter[start] can reach past ones.
      const nowIso = new Date().toISOString();
      const autoDestroys = await db.query.workspaces.findMany({
        columns: { id: true, name: true, autoDestroyAt: true },
        where: and(
          eq(workspaces.orgId, organization.id),
          inArray(workspaces.id, allowedWorkspaceIds),
          ...(start === undefined && end === undefined
            ? [gte(workspaces.autoDestroyAt, nowIso)]
            : [
                ...(start === undefined ? [] : [gte(workspaces.autoDestroyAt, start.iso)]),
                ...(end === undefined ? [] : [lte(workspaces.autoDestroyAt, end.iso)]),
              ]),
        ),
        orderBy: [asc(workspaces.autoDestroyAt), asc(workspaces.id)],
      });
      for (const workspace of autoDestroys) {
        entries.push({
          kind: "auto-destroy",
          at: workspace.autoDestroyAt ?? "",
          scheduled: false,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        });
      }
    }
    // Deterministic merged ordering: effective time, then a fixed kind
    // order, then the stable entry id. Sorting happens after the range
    // filters so every entry in the response is in range.
    entries.sort((a: CalendarEntry, b: CalendarEntry): number => {
      const byAt = a.at.localeCompare(b.at);
      if (byAt !== 0) return byAt;
      const byKind = CALENDAR_KIND_ORDER[a.kind] - CALENDAR_KIND_ORDER[b.kind];
      if (byKind !== 0) return byKind;
      return calendarEntryId(a).localeCompare(calendarEntryId(b));
    });
    const pageEntries = entries.slice((number - 1) * size, number * size);
    const data = pageEntries.map((attributes: CalendarEntry): Record<string, unknown> => ({
      // Entry-specific id first so every item has a unique type+id pair:
      // a workspace can appear once per confirmed run / change request, so
      // workspaceId alone would collide for repeated entries.
      id: calendarEntryId(attributes),
      type: "change-calendar-entry",
      attributes,
    }));
    return { data, ...pagination(request, number, size, entries.length) };
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
      const reasoningEffort = configuredReasoningEffort(settings["reasoning-effort"]);
      const kindOrError = parseExplainKind(new URL(request.url).searchParams.get("kind"), set);
      if (typeof kindOrError !== "string") return kindOrError.body;
      const kind = kindOrError;
      const cached = await findExplanation(runId, kind);
      if (cached !== undefined) {
        return explanationResource(runId, kind, cached.content, cached.model, reasoningEffort, new Date(cached.createdAt).toISOString(), true);
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
      const runId = params.run_id ?? "";
      const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "run-read");
      if (authorized === undefined) return notFound(set);
      const settings = await getSettings("plan-explainer");
      if (settings.enabled !== true) return notFound(set);
      const reasoningEffort = configuredReasoningEffort(settings["reasoning-effort"]);
      const attributes = readExplainAttributes(body);
      const kindOrError = parseExplainKind(attributes.kind, set);
      if (typeof kindOrError !== "string") return kindOrError.body;
      const kind = kindOrError;
      const refresh = attributes.refresh === true;
      const streamRequested = attributes.stream === true;
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
      const model = resolvedSettings.model as string;
      const source = await buildExplainSource(runId, kind);
      if (source === undefined) {
        const err = explainError(409, "Conflict", explainMissingArtifactDetail(kind));
        (set as { status: number }).status = err.status;
        return err.body;
      }
      if (streamRequested) return streamExplainResponse(resolvedSettings, source, runId, kind, model, reasoningEffort, request, refresh);
      return explainJsonResponse(set, resolvedSettings, source, runId, kind, model, reasoningEffort);
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
      await saveExplanation(runId, kind, model, parts.content);
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
