import { Elysia } from "elysia";
import { createHmac, timingSafeEqual } from "node:crypto";
import { envEnabled } from "../lib/env";
import { db } from "../db";
import { runTriggers, auditLogs, githubWebhookDeliveries, workspaces, workspaceVariables, users, organizationMemberships, teams } from "../db/schema";
import { eq, and, asc, count, desc, inArray, or, sql, type SQL } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedRun, findAuthorizedWorkspace, pageRequest, pagination, workspaceIdsForPermission } from "../lib/utils";
import { scopeCoversOrg, scopeGrants } from "../lib/token-scopes";
import { currentTokenScopes } from "../lib/request-scope";
import { workspaceVariableResource } from "../lib/response";
import { variableValueForWrite, variableValueForRead } from "../lib/variable-crypto";
import { validVariableAttributes } from "../lib/validation";
import { enqueueVcsWebhookJob, vcsWebhookDeliveryId, type VcsWebhookProvider } from "../lib/webhook-jobs";
import { costEstimationEnabledForOrganization, getSettings, getSiteCapabilities } from "../lib/settings";
import { confirmRunForApply } from "../lib/operations";
import {
  emptyCostEstimate,
  readCostEstimateArtifact,
  type CostEstimateAttributes,
  type CostEstimateStatus,
  type CostEstimateTimestamps,
} from "../lib/cost-estimate";
import { authPlugin } from "../auth";
import { log } from "../lib/log";
import { cachedOrgByName } from "../lib/cached-lookups";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  token?: Readonly<{ id: string; orgId: string | null; teamId: string | null; tokenType?: string; scopes?: string | null }> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

type WorkspaceVariable = Readonly<typeof workspaceVariables.$inferSelect>;

async function variableAuthorizationWhere(
  user: Readonly<typeof users.$inferSelect> | null | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<SQL | undefined> {
  if (currentTokenScopes() === null && tokenOrgId === null && tokenTeamId === null && user?.isSiteAdmin === true) return sql`true`;

  let organizationIds: string[];
  if (tokenOrgId !== null) {
    organizationIds = [tokenOrgId];
  } else if (tokenTeamId !== null) {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, tokenTeamId), columns: { orgId: true } });
    organizationIds = team === undefined ? [] : [team.orgId];
  } else if (user?.isSiteAdmin === true) {
    const allOrganizations = await db.query.organizations.findMany({ columns: { id: true } });
    organizationIds = allOrganizations.map((organization): string => organization.id);
  } else if (user !== null && user !== undefined) {
    const memberships = await db.query.organizationMemberships.findMany({
      where: and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")),
      columns: { orgId: true },
    });
    organizationIds = memberships.map((membership): string => membership.orgId);
  } else {
    organizationIds = [];
  }

  const accessConditions = (await Promise.all([...new Set(organizationIds)].map(async (organizationId): Promise<SQL | null> => {
    const authorizedWorkspaceIds = await workspaceIdsForPermission(
      organizationId,
      user?.id,
      tokenOrgId,
      tokenTeamId,
      "variables-read",
    );
    if (authorizedWorkspaceIds === null) return eq(workspaces.orgId, organizationId);
    if (authorizedWorkspaceIds.length > 0) return inArray(workspaceVariables.workspaceId, authorizedWorkspaceIds);
    return null;
  }))).filter((condition): condition is SQL => condition !== null);
  return accessConditions.length === 0 ? undefined : or(...accessConditions);
}

function globalVariableResource(variable: WorkspaceVariable): Record<string, unknown> {
  return {
    ...workspaceVariableResource(variable),
    relationships: {
      configurable: { data: { id: variable.workspaceId, type: "workspaces" } },
    },
    links: { self: `/api/v2/vars/${variable.id}` },
  };
}

type CostEstimateRun = Readonly<{
  id: string;
  status: string;
  statusTimestamps: Readonly<Record<string, string>> | null;
}>;

export function costEstimateResource(
  run: CostEstimateRun,
  estimate?: CostEstimateAttributes,
  enabled = false,
): Record<string, unknown> {
  const timestamps = run.statusTimestamps ?? {};
  const finished = typeof timestamps["cost-estimated-at"] === "string";
  const status: CostEstimateStatus = finished
    ? "finished"
    : run.status === "errored"
      ? "errored"
      : ["canceled", "force_canceled", "discarded"].includes(run.status)
        ? "canceled"
        : run.status === "planned_and_finished"
          ? "skipped_due_to_targeting"
          : run.status === "cost_estimating"
            ? "pending"
            : ["pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed", "queuing", "plan_queued", "planning"].includes(run.status)
              ? "queued"
              : "finished";
  const fallbackTimestamps: CostEstimateTimestamps = {
    "queued-at": timestamps["planned-at"] ?? null,
    "pending-at": timestamps["cost-estimating-at"] ?? null,
    "finished-at": timestamps["cost-estimated-at"] ?? null,
  };
  const fallback = emptyCostEstimate(
    status,
    fallbackTimestamps,
    status === "errored" ? "Run errored before cost estimation completed" : null,
  );
  const attributes = estimate === undefined
    ? fallback
    : {
      ...estimate,
      "status-timestamps": {
        ...fallbackTimestamps,
        ...estimate["status-timestamps"],
      },
    };
  return {
    id: `ce-${run.id}`,
    type: "cost-estimates",
    attributes: {
      ...attributes,
      "terrence:infracost-enabled": enabled,
    },
    links: { self: `/api/v2/cost-estimates/ce-${run.id}` },
  };
}

/**
 * Durable enqueue path (todo 183-190): persist the delivery onto the durable
 * job queue and only then ACK. The worker-disabled fallback (tests,
 * benchmarks, API-only nodes) processes inline so deliveries never strand in
 * `queued` behind a worker that will never poll.
 */
async function durableWebhookEnqueue(input: Readonly<{
  provider: VcsWebhookProvider;
  eventName: string;
  payload: Record<string, unknown>;
  deliveryId: string | null;
}>): Promise<void> {
  if (input.deliveryId !== null) {
    await db.insert(githubWebhookDeliveries)
      .values({ id: input.deliveryId, status: "queued", receivedAt: Date.now() })
      .onConflictDoNothing();
  }
  if (envEnabled(process.env["TERRENCE_DISABLE_WORKER"])) {
    const { processVcsWebhookPayload } = await import("../lib/webhook-jobs");
    await processVcsWebhookPayload({
      provider: input.provider,
      eventName: input.eventName,
      payload: input.payload,
      deliveryId: input.deliveryId,
    });
    return;
  }
  await enqueueVcsWebhookJob({
    provider: input.provider,
    eventName: input.eventName,
    payload: input.payload,
    deliveryId: input.deliveryId,
  });
}

function webhookPayload(body: unknown): { payload: Record<string, unknown>; rawBody: string } | undefined {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) as unknown : body;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { payload: parsed as Record<string, unknown>, rawBody }
      : undefined;
  } catch {
    return undefined;
  }
}

function sameSecret(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function webhookUnauthorized(set: SetObj, detail: string): { errors: { status: string; title: string; detail: string }[] } {
  (set as { status: number }).status = 401;
  return { errors: [{ status: "401", title: "Unauthorized", detail }] };
}

function webhookUnprocessable(set: SetObj, detail: string): { errors: { status: string; title: string; detail: string }[] } {
  (set as { status: number }).status = 422;
  return { errors: [{ status: "422", title: "Unprocessable Entity", detail }] };
}

type AuditLogItem = Readonly<typeof auditLogs.$inferSelect>;
type AuditLogPage = Readonly<{ number: number; size: number }>;
type PagedAuditLogs = Readonly<{ logs: AuditLogItem[]; total: number }>;

const AUDIT_LOG_RESOURCE_TYPE = "audit-logs";

async function auditLogResources(logsList: readonly AuditLogItem[]): Promise<Record<string, unknown>[]> {
  const actorIds = [...new Set(logsList.map((log): string | null => log.userId).filter((id): id is string => id !== null))];
  const actors = actorIds.length === 0
    ? []
    : await db.query.users.findMany({ where: inArray(users.id, actorIds), columns: { id: true, username: true, email: true } });
  const actorsById = new Map(actors.map((actor): [string, { username: string; email: string | null }] => [actor.id, actor]));
  return logsList.map((al: AuditLogItem): Record<string, unknown> => {
    const actor = al.userId === null ? undefined : actorsById.get(al.userId);
    return {
      id: al.id,
      type: AUDIT_LOG_RESOURCE_TYPE,
      attributes: {
        action: al.action,
        "resource-type": al.resourceType,
        "resource-id": al.resourceId,
        details: al.details,
        "created-at": new Date(al.createdAt).toISOString(),
        "actor-username": actor?.username ?? null,
        "actor-email": actor?.email ?? null,
      },
    };
  });
}

async function pagedAuditLogs(where: SQL | undefined, page: AuditLogPage): Promise<PagedAuditLogs> {
  const [totalRows, logs] = await Promise.all([
    where === undefined
      ? db.select({ total: count() }).from(auditLogs)
      : db.select({ total: count() }).from(auditLogs).where(where),
    db.query.auditLogs.findMany({
      where,
      limit: page.size,
      offset: (page.number - 1) * page.size,
      orderBy: [desc(auditLogs.createdAt), desc(auditLogs.id)],
    }),
  ]);
  return { logs, total: Number(totalRows[0]?.total ?? 0) };
}

const AUDIT_LOG_ACCESS_DENIED = Symbol("audit-log-access-denied");
type AuditLogResult = PagedAuditLogs | null | typeof AUDIT_LOG_ACCESS_DENIED;

async function auditLogsForPrincipal(
  user: Readonly<typeof users.$inferSelect> | null | undefined,
  token: Readonly<{ id: string; orgId: string | null; teamId: string | null; tokenType?: string; scopes?: string | null }> | null | undefined,
  page: AuditLogPage,
): Promise<AuditLogResult> {
  let orgIds: string[];
  if (user === null || user === undefined) {
    // The dedicated organization audit-trails token intentionally has no user
    // principal. It is scoped to exactly one organization by the token row.
    if (token === null || token === undefined) return null;
    if (token.orgId === null || token.orgId === undefined || token.teamId !== null || token.tokenType !== "audit-trails") {
      return AUDIT_LOG_ACCESS_DENIED;
    }
    orgIds = [token.orgId];
  } else {
    const scopes = currentTokenScopes();
    const memberships = await db.query.organizationMemberships.findMany({
      where: and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")),
      columns: { orgId: true, role: true },
    });
    if (scopes !== null) {
      if (!scopeGrants(scopes, "audit-logs:read")) {
        orgIds = [];
      } else {
        const candidateOrgIds = user.isSiteAdmin === true || user.isSiteAuditor === true
          ? (await db.query.organizations.findMany({ columns: { id: true } })).map((org): string => org.id)
          : memberships.filter((membership): boolean => membership.role === "owner").map(({ orgId }): string => orgId);
        orgIds = candidateOrgIds.filter((orgId): boolean => scopeCoversOrg(scopes, orgId));
      }
    } else if (user.isSiteAdmin === true || user.isSiteAuditor === true) {
      orgIds = (await db.query.organizations.findMany({ columns: { id: true } })).map((org): string => org.id);
    } else {
      orgIds = memberships.filter((membership): boolean => membership.role === "owner").map(({ orgId }): string => orgId);
    }
  }
  const uniqueOrgIds = [...new Set(orgIds)];
  if (uniqueOrgIds.length === 0) return user === null || user === undefined ? null : { logs: [], total: 0 };
  return pagedAuditLogs(inArray(auditLogs.orgId, uniqueOrgIds), page);
}

async function auditTrailAliasResponse({ user, token, request, set }: ParamCtx): Promise<unknown> {
  const page = pageRequest(request);
  const result = await auditLogsForPrincipal(user, token, page);
  if (result === null || result === AUDIT_LOG_ACCESS_DENIED) {
    const status = result === AUDIT_LOG_ACCESS_DENIED ? 403 : 401;
    (set as { status: number }).status = status;
    return { errors: [{ status: String(status), title: status === 401 ? "Unauthorized" : "Forbidden" }] };
  }
  return {
    data: await auditLogResources(result.logs),
    ...pagination(request, page.number, page.size, result.total),
  };
}

const webhookAcknowledged = {
  data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } },
} as const;

function firstWebhookHeader(request: Request, names: readonly string[]): string | null {
  for (const name of names) {
    const value = request.headers.get(name);
    if (value !== null && value.trim() !== "") return value;
  }
  return null;
}

export const miscRoutes = new Elysia({ name: "misc" })
  .use(authPlugin)
  // --- Webhook Receivers ---
    .post("/api/webhooks/github", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    const secret = process.env["GITHUB_WEBHOOK_SECRET"];
    const signature = request.headers.get("x-hub-signature-256");
    const rawBody = typeof body === "string" ? body : await request.text().catch((): string => "");
    if (typeof secret !== "string" || secret.length === 0) {
      return webhookUnauthorized(set, "GitHub webhook secret is not configured");
    }
    if (signature === null) {
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Missing signature" }] };
      }

      const expectedSignature = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
      const providedSignature = Buffer.from(signature);
      if (providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) {
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid signature" }] };
      }

    const eventName = request.headers.get("x-github-event");
    if (eventName !== null) {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed !== null && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch {}
      const deliveryHeader = request.headers.get("x-github-delivery");
      const deliveryId = deliveryHeader !== null && deliveryHeader !== "" ? deliveryHeader : null;
      if (deliveryId !== null) {
        const claimed = await db.insert(githubWebhookDeliveries)
          .values({ id: deliveryId, status: "queued", receivedAt: Date.now() })
          .onConflictDoNothing()
          .returning({ id: githubWebhookDeliveries.id });
        if (claimed.length === 0) {
          // Redelivery of a delivery we already hold: acknowledged without
          // reprocessing (todo 184/199). A failed delivery stays failed until
          // the admin retry endpoint re-arms it.
          return { data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } };
        }
      }

      if (eventName === "push" || eventName === "pull_request") {
        log.info(`Received GitHub ${eventName} event.`);
      }
      // Durable path: the delivery row (or the job row itself when no header
      // GUID was sent) IS the durable record; enqueue before ACK (todo 190).
      await durableWebhookEnqueue({
        provider: "github",
        eventName,
        payload,
        deliveryId,
      });
    }

    return { data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } };
  })
  .post("/api/webhooks/gitlab", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    const secret = process.env["GITLAB_WEBHOOK_SECRET"];
    if (typeof secret !== "string" || secret === "") {
      return webhookUnauthorized(set, "GitLab webhook secret is not configured");
    }
    if (!sameSecret(request.headers.get("x-gitlab-token"), secret)) {
      return webhookUnauthorized(set, "Invalid GitLab webhook token");
    }
    const eventName = request.headers.get("x-gitlab-event");
    if (eventName === null || eventName === "") return webhookUnprocessable(set, "Missing GitLab event header");
    const parsed = webhookPayload(body);
    if (parsed === undefined) return webhookUnprocessable(set, "Invalid webhook payload");
    await durableWebhookEnqueue({
      provider: "gitlab",
      eventName,
      payload: parsed.payload,
      deliveryId: vcsWebhookDeliveryId(
        "gitlab",
        eventName,
        parsed.payload,
        firstWebhookHeader(request, ["x-gitlab-event-uuid", "x-gitlab-webhook-uuid", "webhook-id", "idempotency-key"]),
      ),
    });
    return webhookAcknowledged;
  })
  .post("/api/webhooks/bitbucket", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    const parsed = webhookPayload(body);
    if (parsed === undefined) return webhookUnprocessable(set, "Invalid webhook payload");
    const secret = process.env["BITBUCKET_WEBHOOK_SECRET"];
    if (typeof secret !== "string" || secret === "") {
      return webhookUnauthorized(set, "Bitbucket webhook secret is not configured");
    }
    const signature = request.headers.get("x-hub-signature");
    const expected = `sha256=${createHmac("sha256", secret).update(parsed.rawBody).digest("hex")}`;
    if (!sameSecret(signature, expected)) return webhookUnauthorized(set, "Invalid Bitbucket webhook signature");
    const eventName = request.headers.get("x-event-key");
    if (eventName === null || eventName === "") return webhookUnprocessable(set, "Missing Bitbucket event header");
    await durableWebhookEnqueue({
      provider: "bitbucket",
      eventName,
      payload: parsed.payload,
      deliveryId: vcsWebhookDeliveryId("bitbucket", eventName, parsed.payload, firstWebhookHeader(request, ["x-request-uuid"])),
    });
    return webhookAcknowledged;
  })
  // --- External Apply Approval Webhook (kanban 21.8) ---
  // Lets a ServiceNow/Jira/other workflow unblock an apply that the site
  // has gated behind external approval (admin `approval-webhook` settings).
  // Signature: `X-Terrence-Signature: <sha256 hex HMAC of the raw body>`.
  .post("/api/v2/webhooks/run-approval", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    const settings = await getSettings("approval-webhook");
    if (settings["enabled"] !== true) {
      return webhookUnprocessable(set, "External apply approval is not enabled");
    }
    const secret = settings["secret"];
    if (typeof secret !== "string" || secret === "") {
      return webhookUnauthorized(set, "Approval webhook secret is not configured");
    }
    const rawBody = typeof body === "string" ? body : await request.text().catch((): string => "");
    const signature = request.headers.get("x-terrence-signature");
    if (signature === null) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Missing signature" }] };
    }
    const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
    const provided = Buffer.from(signature);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return webhookUnauthorized(set, "Invalid approval webhook signature");
    }
    let parsed: Readonly<Record<string, unknown>> = {};
    try {
      const value: unknown = JSON.parse(rawBody);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed = value as Readonly<Record<string, unknown>>;
    } catch {
      return webhookUnprocessable(set, "Invalid JSON payload");
    }
    const runId = typeof parsed["run"] === "string" ? parsed["run"] : typeof parsed["run_id"] === "string" ? parsed["run_id"] : "";
    if (runId === "") return webhookUnprocessable(set, "Missing run id");
    const action = typeof parsed["action"] === "string" ? parsed["action"] : "";
    if (action !== "confirm") {
      return webhookUnprocessable(set, "Invalid action; expected \"confirm\"");
    }
    const outcome = await confirmRunForApply(runId, { isWebhookApproval: true });
    if (!outcome.ok) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: outcome.reason ?? "Apply could not be started" }] };
    }
    log.info(`Approval webhook confirmed apply for run ${runId}`);
    return { data: { id: runId, type: "runs", attributes: { status: outcome.status } } };
  })
  // --- Entitlements ---
  .get("/api/v2/entitlements", async ({ user, set }: ParamCtx): Promise<unknown> => {
    // The response discloses which site capabilities an operator enabled
    // (audit_logging, private_vcs, sentinel, ...). the reference format requires an
    // authenticated request for this endpoint; leave it anonymous and any
    // unauthenticated caller can fingerprint the deployment.
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const capabilities = await getSiteCapabilities();
    return { data: {
      id: "entitlements",
      type: "entitlements",
      attributes: {
        agents: capabilities["agents"] === true,
        audit_logging: capabilities["audit-logging"] === true,
        sentinel: capabilities["sentinel"] === true,
        state_storage: capabilities["state-storage"] === true,
        teams: capabilities["teams"] === true,
        vcs_integrations: capabilities["vcs-integrations"] === true,
        run_tasks: capabilities["run-tasks"] === true,
        configuration_designer: capabilities["no-code"] === true,
        module_tests_generation: capabilities["module-testing"] === true,
        module_deprecations: capabilities["private-module-registry"] === true,
        module_revocations: capabilities["private-module-registry"] === true,
        private_policy_agents: capabilities["private-policy-agents"] === true,
        private_run_tasks: capabilities["private-run-tasks"] === true,
        private_vcs: capabilities["private-vcs"] === true,
        global_run_tasks: capabilities["global-run-tasks"] === true,
        groups: false,
      },
    } };
  })
  // --- Deprecated Global Vars API ---
  .get("/api/v2/vars", async ({ user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const search = new URL(request?.url ?? "http://localhost/api/v2/vars").searchParams;
    const orgName = search.get("filter[organization][name]");
    const workspaceName = search.get("filter[workspace][name]");
    if ((orgName === null) !== (workspaceName === null)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Organization and workspace filters must be provided together" }] };
    }

    if (orgName !== null && workspaceName !== null) {
      const org = await cachedOrgByName(orgName);
      const workspace = org === undefined
        ? undefined
        : await db.query.workspaces.findFirst({
          where: and(eq(workspaces.orgId, org.id), eq(workspaces.name, workspaceName)),
        });
      const authorized = workspace === undefined
        ? undefined
        : await findAuthorizedWorkspace(workspace.id, user?.id, orgId, teamId, "variables-read");
      if (authorized === undefined) {
        (set as { status: number }).status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
      }
      const where = eq(workspaceVariables.workspaceId, authorized.id);
      const page = pageRequest(request ?? { url: "http://localhost/api/v2/vars" });
      const [variables, countRows] = await Promise.all([
        db.select().from(workspaceVariables)
          .where(where)
          .orderBy(asc(workspaceVariables.id))
          .limit(page.size)
          .offset((page.number - 1) * page.size),
        db.select({ total: count() }).from(workspaceVariables).where(where),
      ]);
      const totalCount = countRows[0]?.total ?? 0;
      return {
        data: variables.map(globalVariableResource),
        ...pagination(request ?? { url: "http://localhost/api/v2/vars" }, page.number, page.size, totalCount),
      };
    }

    const requestWithUrl = request ?? { url: "http://localhost/api/v2/vars" };
    const where = await variableAuthorizationWhere(user, orgId, teamId);
    const page = pageRequest(requestWithUrl);
    if (where === undefined) return { data: [], ...pagination(requestWithUrl, page.number, page.size, 0) };
    const [rows, countRows] = await Promise.all([
      db.select({ variable: workspaceVariables })
        .from(workspaceVariables)
        .innerJoin(workspaces, eq(workspaceVariables.workspaceId, workspaces.id))
        .where(where)
        .orderBy(asc(workspaceVariables.id))
        .limit(page.size)
        .offset((page.number - 1) * page.size),
      db.select({ total: count() })
        .from(workspaceVariables)
        .innerJoin(workspaces, eq(workspaceVariables.workspaceId, workspaces.id))
        .where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return {
      data: rows.map((row): Record<string, unknown> => globalVariableResource(row.variable)),
      ...pagination(requestWithUrl, page.number, page.size, totalCount),
    };
  })
  .post("/api/v2/vars", async ({ body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload["data"] !== null && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : {};
    const attributes = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
    const relationships = data["relationships"] !== null && typeof data["relationships"] === "object" ? data["relationships"] as Record<string, unknown> : {};
    const workspaceRelationship = relationships["workspace"] !== null && typeof relationships["workspace"] === "object"
      ? relationships["workspace"] as Record<string, unknown>
      : {};
    const workspaceData = workspaceRelationship["data"] !== null && typeof workspaceRelationship["data"] === "object"
      ? workspaceRelationship["data"] as Record<string, unknown>
      : {};
    const workspaceId = typeof workspaceData["id"] === "string" ? workspaceData["id"] : "";
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "variables-write");
    const normalizedAttributes: Record<string, unknown> & { value: string } = {
      ...attributes,
      value: typeof attributes["value"] === "string" ? attributes["value"] : "",
    };
    if (
      workspace === undefined
      || data["type"] !== "vars"
      || workspaceData["type"] !== "workspaces"
      || !validVariableAttributes(normalizedAttributes)
    ) {
      (set as { status: number }).status = workspace === undefined ? 404 : 422;
      return { errors: [{ status: String(workspace === undefined ? 404 : 422), title: workspace === undefined ? "Not Found" : "Unprocessable Entity" }] };
    }
    const categoryValue: unknown = normalizedAttributes["category"];
    const descriptionValue: unknown = normalizedAttributes["description"];
    const sensitiveValue = normalizedAttributes["sensitive"] === true;
    // Sensitive values are encrypted at rest (todo 167/168).
    const stored = await variableValueForWrite(sensitiveValue, normalizedAttributes.value);
    const variable: typeof workspaceVariables.$inferInsert = {
      id: `var-${crypto.randomUUID()}`,
      workspaceId,
      key: normalizedAttributes["key"] as string,
      value: stored.value,
      valueEncrypted: stored.valueEncrypted,
      category: categoryValue === "env" ? "env" : "terraform",
      sensitive: sensitiveValue,
      hcl: normalizedAttributes["hcl"] === true,
      description: typeof descriptionValue === "string" ? descriptionValue : null,
    };
    await db.insert(workspaceVariables).values(variable);
    (set as { status: number }).status = 201;
    return { data: globalVariableResource(variable as WorkspaceVariable) };
  })
  .patch("/api/v2/vars/:var_id", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const variableId = params["var_id"] ?? "";
    const variable = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, variableId) });
    const workspace = variable === undefined
      ? undefined
      : await findAuthorizedWorkspace(variable.workspaceId, user?.id, orgId, teamId, "variables-write");
    if (variable === undefined || workspace === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload["data"] !== null && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : {};
    const attributes = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
    if ((data["type"] !== undefined && data["type"] !== "vars") || !validVariableAttributes(attributes, true)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    let sensitive = typeof attributes["sensitive"] === "boolean" ? attributes["sensitive"] : variable.sensitive === true;
    if (variable.sensitive === true && !sensitive && attributes["value"] === undefined) sensitive = true;
    // Re-encrypt when the value or sensitive flag changed; flipping sensitive
    // on encrypts the existing plaintext (todo 169).
    const suppliedValue = typeof attributes["value"] === "string" ? attributes["value"] : null;
    const effectiveValue = suppliedValue ?? (sensitive ? await variableValueForRead(variable) : variable.value);
    const stored = await variableValueForWrite(sensitive, effectiveValue);
    const updates: Partial<typeof workspaceVariables.$inferInsert> = {
      key: typeof attributes["key"] === "string" ? attributes["key"] : variable.key,
      value: stored.value,
      valueEncrypted: stored.valueEncrypted,
      category: typeof attributes["category"] === "string" ? attributes["category"] : variable.category,
      sensitive,
      hcl: typeof attributes["hcl"] === "boolean" ? attributes["hcl"] : variable.hcl === true,
      description: attributes["description"] === null
        ? null
        : typeof attributes["description"] === "string" ? attributes["description"] : variable.description,
    };
    await db.update(workspaceVariables).set(updates).where(eq(workspaceVariables.id, variable.id));
    return { data: globalVariableResource({ ...variable, ...updates } as WorkspaceVariable) };
  })
  .delete("/api/v2/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const variableId = params["var_id"] ?? "";
    const variable = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, variableId) });
    const workspace = variable === undefined
      ? undefined
      : await findAuthorizedWorkspace(variable.workspaceId, user?.id, orgId, teamId, "variables-write");
    if (variable === undefined || workspace === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, variable.id));
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  // --- Audit Trails ---
  .get("/api/v2/admin/audit-logs", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    if (user.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const page = pageRequest(request);
    const result = await pagedAuditLogs(undefined, page);
    return { data: await auditLogResources(result.logs), ...pagination(request, page.number, page.size, result.total) };
  })
  .get("/api/v2/organizations/:org_name/audit-logs", async ({ params, user, orgId: tokenOrgId, request, set }: ParamCtx): Promise<unknown> => {
    if ((user === null || user === undefined) && tokenOrgId === null) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId, null, "audit-logs:read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const page = pageRequest(request);
    const result = await pagedAuditLogs(eq(auditLogs.orgId, org.id), page);
    return { data: await auditLogResources(result.logs), ...pagination(request, page.number, page.size, result.total) };
  })
  .get("/api/v2/organizations/:org_name/audit-configuration", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    // go-tfe OrganizationAuditConfigurations.Read. Fields that the cloud
    // platform gates behind paid tiers are null for a reference-style
    // deployment; audit trails are always enabled here.
    if ((user === null || user === undefined) && tokenOrgId === null) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId, null, "audit-logs:read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return {
      data: {
        id: org.id,
        type: "audit-configurations",
        attributes: {
          // go-tfe expects nested objects and the org relationship name
          // (the data source dereferences v.Organization.Name).
          "audit-trails": { enabled: true },
          "hcp-audit-log-streaming": { enabled: false, "organization-id": "", "use-default-organization": true },
          permissions: {
            "can-enable-hcp-audit-log-streaming": true,
            "can-set-hcp-audit-log-streaming-organization-id": true,
            "can-use-default-audit-log-streaming-organization": true,
          },
          "updated-at": new Date().toISOString(),
        },
        relationships: {
          organization: { data: { id: org.name, type: "organizations" } },
        },
      },
    };
  })
  .get("/api/v2/organization-audit-trailers", auditTrailAliasResponse)
  .get("/api/v2/audit-trails", auditTrailAliasResponse)
  // --- Cost Estimation ---
  .get("/api/v2/runs/:run_id/cost-estimate", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId, teamId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: costEstimateResource(authorized.run, await readCostEstimateArtifact(runId), await costEstimationEnabledForOrganization(authorized.workspace.orgId)) };
  })
  .get("/api/v2/cost-estimates/:ce_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const ceId = params["ce_id"] ?? "";
    const runId = ceId.replace(/^ce-/, "");
    if (runId === "") { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(runId, user?.id, orgId, teamId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: costEstimateResource(authorized.run, await readCostEstimateArtifact(runId), await costEstimationEnabledForOrganization(authorized.workspace.orgId)) };
  })
  // --- Run Triggers ---
  .get("/api/v2/workspaces/:workspace_id/run-triggers", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId)) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const rawFilterType = request !== undefined ? new URL(request.url).searchParams.get("filter[run-trigger][type]") : null;
    if (rawFilterType !== null && rawFilterType !== "" && rawFilterType !== "inbound" && rawFilterType !== "outbound") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "filter[run-trigger][type] must be 'inbound' or 'outbound'" }] };
    }
    const filterType = rawFilterType ?? "inbound";
    const triggers = filterType === "outbound"
      ? await db.query.runTriggers.findMany({ where: eq(runTriggers.sourceWorkspaceId, workspaceId) })
      : await db.query.runTriggers.findMany({ where: eq(runTriggers.workspaceId, workspaceId) });
    const relatedWorkspaceIds = [...new Set(triggers.flatMap((t: Readonly<typeof runTriggers.$inferSelect>): string[] => [t.workspaceId, t.sourceWorkspaceId]))];
    const relatedWorkspaces = relatedWorkspaceIds.length === 0
      ? []
      : await db.query.workspaces.findMany({
        where: inArray(workspaces.id, relatedWorkspaceIds),
        columns: { id: true, name: true },
      });
    const wsNames = new Map(relatedWorkspaces.map((w: Readonly<{ readonly id: string; readonly name: string }>): [string, string] => [w.id, w.name]));
    return { data: triggers.map((t: Readonly<typeof runTriggers.$inferSelect>): Record<string, unknown> => ({
      id: t.id,
      type: "run-triggers",
      attributes: {
        "created-at": new Date(t.createdAt).toISOString(),
        "sourceable-name": wsNames.get(t.sourceWorkspaceId) ?? "",
        "workspace-name": wsNames.get(t.workspaceId) ?? "",
      },
      relationships: {
        sourceable: { data: { id: t.sourceWorkspaceId, type: "workspaces" } },
        "sourceable-workspace": { data: { id: t.sourceWorkspaceId, type: "workspaces" } },
        workspace: { data: { id: t.workspaceId, type: "workspaces" } },
      },
    })) };
  })
  .post("/api/v2/workspaces/:workspace_id/run-triggers", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const rels = typeof data?.["relationships"] === "object" && data["relationships"] !== null ? (data["relationships"] as Record<string, unknown>) : {};
    const sourceable = rels["sourceable"] as Record<string, unknown> | undefined;
    const srcData = typeof sourceable?.["data"] === "object" && sourceable["data"] !== null ? (sourceable["data"] as Record<string, unknown>) : undefined;
    const srcId = typeof srcData?.["id"] === "string" ? srcData["id"] : "";
    if (srcData?.["type"] !== "workspaces" || srcId === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Sourceable workspace must be a workspace resource identifier" }] };
    }
    const srcWs = await db.query.workspaces.findFirst({ where: eq(workspaces.id, srcId) });
    if (srcWs === undefined || srcWs.orgId !== ws.orgId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Sourceable workspace must belong to the same organization" }] }; }
    if (srcId === workspaceId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Sourceable workspace cannot be the workspace itself" }] }; }
    const id = `rt-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runTriggers).values({ id, workspaceId, sourceWorkspaceId: srcId }).onConflictDoNothing();
    (set as { status: number }).status = 201;
    return { data: { id, type: "run-triggers", attributes: { "created-at": new Date().toISOString(), "sourceable-name": srcWs.name, "workspace-name": ws.name }, relationships: { sourceable: { data: { id: srcId, type: "workspaces" } }, "sourceable-workspace": { data: { id: srcId, type: "workspaces" } }, workspace: { data: { id: workspaceId, type: "workspaces" } } } } };
  })
  .get("/api/v2/run-triggers/:run_trigger_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const triggerId = params["run_trigger_id"] ?? "";
    const trigger = triggerId !== "" ? await db.query.runTriggers.findFirst({ where: eq(runTriggers.id, triggerId) }) : undefined;
    if (trigger === undefined || (await findAuthorizedWorkspace(trigger.workspaceId, user?.id, tokenOrgId, tokenTeamId)) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [tw, sw] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, trigger.workspaceId), columns: { name: true } }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, trigger.sourceWorkspaceId), columns: { name: true } }),
    ]);
    return { data: { id: trigger.id, type: "run-triggers", attributes: { "created-at": new Date(trigger.createdAt).toISOString(), "sourceable-name": sw?.name ?? "", "workspace-name": tw?.name ?? "" }, relationships: { sourceable: { data: { id: trigger.sourceWorkspaceId, type: "workspaces" } }, "sourceable-workspace": { data: { id: trigger.sourceWorkspaceId, type: "workspaces" } }, workspace: { data: { id: trigger.workspaceId, type: "workspaces" } } } } };
  })
  .delete("/api/v2/run-triggers/:run_trigger_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const triggerId = params["run_trigger_id"] ?? "";
    const trigger = triggerId !== "" ? await db.query.runTriggers.findFirst({ where: eq(runTriggers.id, triggerId) }) : undefined;
    if (trigger === undefined || (await findAuthorizedWorkspace(trigger.workspaceId, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runTriggers).where(eq(runTriggers.id, triggerId));
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    if (!Array.isArray(items)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Run trigger relationships must be an array of workspace resource identifiers" }] };
    }
    const sourceIds: string[] = [];
    for (const item of items) {
      if (item === null || typeof item !== "object") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Run trigger source must be a workspace resource identifier" }] };
      }
      const identifier = item as Record<string, unknown>;
      if (identifier["type"] !== "workspaces" || typeof identifier["id"] !== "string" || identifier["id"] === "") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Run trigger source must be a workspace resource identifier" }] };
      }
      sourceIds.push(identifier["id"]);
    }
    const uniqueSourceIds = [...new Set(sourceIds)];
    const sourceWorkspaces = uniqueSourceIds.length === 0
      ? []
      : await db.query.workspaces.findMany({ where: inArray(workspaces.id, uniqueSourceIds), columns: { id: true, orgId: true } });
    const validSources = new Set(sourceWorkspaces.filter((source): boolean => source.orgId === ws.orgId && source.id !== workspaceId).map((source): string => source.id));
    if (validSources.size !== uniqueSourceIds.length) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Sourceable workspace must belong to the same organization and cannot be the workspace itself" }] };
    }
    if (uniqueSourceIds.length > 0) {
      await db.insert(runTriggers).values(uniqueSourceIds.map((sourceWorkspaceId: string): typeof runTriggers.$inferInsert => ({
        id: `rt-${crypto.randomUUID()}`,
        workspaceId,
        sourceWorkspaceId,
      }))).onConflictDoNothing();
    }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    if (Array.isArray(items)) {
      const srcIds = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>)["id"] === "string") ? (i as Record<string, unknown>)["id"] as string : "").filter((s: string): boolean => s !== "");
      if (srcIds.length > 0) {
        await db.delete(runTriggers).where(and(eq(runTriggers.workspaceId, workspaceId), inArray(runTriggers.sourceWorkspaceId, srcIds)));
      }
    }
    (set as { status: number }).status = 204;
    return new Response(null, { status: 204 });
  });
