import { Elysia } from "elysia";
import { eq, and, gte, inArray } from "drizzle-orm";
import { db } from "../db";
import { runs, workspaces, changeRequests } from "../db/schema";
import {
  checkOrgPermission,
  findAuthorizedRun,
  workspaceIdsForPermission,
} from "../lib/utils";
import { getSettings } from "../lib/settings";
import { readPlanJsonArtifact } from "../lib/plan-json";
import { authPlugin } from "../auth";
import { log } from "../lib/log";
import { cachedOrgByName } from "../lib/cached-lookups";

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<{ readonly id: string }> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
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
  // --- AI plan explainer (kanban 21.2) ----------------------------------
  // Read-only convenience: feeds the sanitized stored plan JSON to a
  // user-configured OpenAI-compatible endpoint and returns the plain-
  // language explanation. Never part of the trusted apply decision.
  .post("/api/v2/runs/:run_id/explain", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "run-read");
    if (authorized === undefined) return notFound(set);
    const settings = await getSettings("plan-explainer");
    if (settings.enabled !== true) return notFound(set);
    const endpointUrl = settings["endpoint-url"];
    const model = settings.model;
    const endpointIsUsable = typeof endpointUrl === "string"
      && endpointUrl !== ""
      && typeof model === "string" && model !== "";
    let parsedEndpoint: URL | null = null;
    if (endpointIsUsable) {
      try {
        parsedEndpoint = new URL(endpointUrl);
      } catch {
        parsedEndpoint = null;
      }
    }
    const endpointAllowed = parsedEndpoint !== null
      && (parsedEndpoint.protocol === "http:" || parsedEndpoint.protocol === "https:")
      && parsedEndpoint.hostname !== "";
    if (!endpointIsUsable || !endpointAllowed) {
      (set as { status: number }).status = 503;
      return { errors: [{ status: "503", title: "Service Unavailable", detail: "Plan explainer is not fully configured" }] };
    }
    const planJson = await readPlanJsonArtifact(runId);
    if (planJson === undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "No plan JSON is available for this run" }] };
    }
    const serialized = JSON.stringify(planJson);
    const truncated = serialized.length > 100_000 ? `${serialized.slice(0, 100_000)}\n... (truncated)` : serialized;
    const content = `Explain the following Terraform plan in plain language for a reviewer. Summarize what will be added, changed, and destroyed, flag anything risky, and keep it under 250 words.\n\n${truncated}`;
    const apiKey = typeof settings["api-key"] === "string" && settings["api-key"] !== "" ? settings["api-key"] : undefined;
    let response: Response;
    try {
      response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 500 }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error: unknown) {
      (set as { status: number }).status = 502;
      return { errors: [{ status: "502", title: "Bad Gateway", detail: `Plan explainer endpoint unreachable: ${error instanceof Error ? error.message : String(error)}` }] };
    }
    if (!response.ok) {
      (set as { status: number }).status = 502;
      return { errors: [{ status: "502", title: "Bad Gateway", detail: `Plan explainer endpoint returned ${response.status}` }] };
    }
    let explanation = "";
    try {
      const parsed: unknown = await response.json();
      const choices = (parsed as Readonly<{ choices?: ReadonlyArray<Readonly<{ message?: Readonly<{ content?: unknown }> }>> }>)?.choices;
      const contentValue = choices?.[0]?.message?.content;
      explanation = typeof contentValue === "string" ? contentValue : "";
    } catch (error: unknown) {
      log.warn(`Plan explainer returned unparseable body for run ${runId}: ${String(error)}`);
    }
    if (explanation === "") {
      (set as { status: number }).status = 502;
      return { errors: [{ status: "502", title: "Bad Gateway", detail: "Plan explainer returned no explanation" }] };
    }
    return { data: { id: runId, type: "plan-explanations", attributes: { explanation, model, "generated-at": new Date().toISOString() } } };
  });
