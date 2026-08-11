import { Elysia } from "elysia";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../db";
import { runTriggers, auditLogs, githubWebhookDeliveries, organizations, workspaces, workspaceVariables, users, organizationMemberships } from "../db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedRun, findAuthorizedWorkspace } from "../lib/utils";
import { scopeCoversOrg, scopeGrants } from "../lib/token-scopes";
import { currentTokenScopes } from "../lib/request-scope";
import { workspaceVariableResource } from "../lib/response";
import { validVariableAttributes } from "../lib/validation";
import { handleBitbucketWebhook, handleGithubWebhook, handleGitlabWebhook } from "../lib/webhooks";
import { getSettings } from "../lib/settings";
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

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request?: Readonly<{ url: string }>;
  set: SetObj;
}>;

type WorkspaceVariable = Readonly<typeof workspaceVariables.$inferSelect>;

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
          ? "skipped"
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
      "infracost-enabled": process.env.INFRACOST_ENABLED === "true",
    },
    links: { self: `/api/v2/cost-estimates/ce-${run.id}` },
  };
}

async function processGithubDelivery(deliveryId: string | null, eventName: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  try {
    await handleGithubWebhook(eventName, payload);
    if (deliveryId !== null) {
      await db.update(githubWebhookDeliveries)
        .set({ status: "processed", processedAt: Date.now() })
        .where(eq(githubWebhookDeliveries.id, deliveryId));
    }
  } catch (error) {
    if (deliveryId !== null) await db.delete(githubWebhookDeliveries).where(eq(githubWebhookDeliveries.id, deliveryId));
    console.error(error);
  }
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

async function auditTrailResources(logsList: readonly AuditLogItem[]): Promise<Record<string, unknown>[]> {
  const actorIds = [...new Set(logsList.map((log): string | null => log.userId).filter((id): id is string => id !== null))];
  const actors = actorIds.length === 0
    ? []
    : await db.query.users.findMany({ where: inArray(users.id, actorIds), columns: { id: true, username: true, email: true } });
  const actorsById = new Map(actors.map((actor): [string, { username: string; email: string | null }] => [actor.id, actor]));
  return logsList.map((al: AuditLogItem): Record<string, unknown> => {
    const actor = al.userId === null ? undefined : actorsById.get(al.userId);
    return {
      id: al.id,
      type: "audit-trails",
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

async function auditLogsForUser(user: Readonly<typeof users.$inferSelect>): Promise<AuditLogItem[]> {
  let orgIds: string[];
  if (user.isSiteAdmin === true) {
    orgIds = (await db.query.organizations.findMany({ columns: { id: true } })).map((org): string => org.id);
  } else {
    const memberships = await db.query.organizationMemberships.findMany({
      where: and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")),
      columns: { orgId: true },
    });
    orgIds = memberships.map(({ orgId }): string => orgId);
  }
  // These aliases span every organization the user can reach; a fine-grained
  // token must not widen them beyond the audit-logs:read grant per org.
  const scopes = currentTokenScopes();
  if (scopes !== null) {
    orgIds = orgIds.filter((orgId): boolean => scopeCoversOrg(scopes, orgId) && scopeGrants(scopes, "audit-logs:read"));
  }
  if (orgIds.length === 0) return [];
  return db.query.auditLogs.findMany({ where: inArray(auditLogs.orgId, orgIds), limit: 100, orderBy: [desc(auditLogs.createdAt)] });
}

const webhookAcknowledged = {
  data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } },
} as const;

async function processProviderDelivery(
  handler: (eventName: string, payload: Readonly<Record<string, unknown>>) => Promise<boolean>,
  eventName: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await handler(eventName, payload);
  } catch (error) {
    console.error(error);
  }
}

export const miscRoutes = new Elysia({ name: "misc" })
  .use(authPlugin)
  // --- Webhook Receivers ---
    .post("/api/webhooks/github", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
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
          .values({ id: deliveryId, status: "processing", receivedAt: Date.now() })
          .onConflictDoNothing()
          .returning({ id: githubWebhookDeliveries.id });
        if (claimed.length === 0) {
          return { data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } };
        }
      }

      if (eventName === "push" || eventName === "pull_request") {
        log.info(`Received GitHub ${eventName} event.`);
      }
      void processGithubDelivery(deliveryId, eventName, payload);
    }

    return { data: { id: "webhook-received", type: "webhooks", attributes: { status: "acknowledged" } } };
  })
  .post("/api/webhooks/gitlab", ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): unknown => {
    const secret = process.env.GITLAB_WEBHOOK_SECRET;
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
    void processProviderDelivery(handleGitlabWebhook, eventName, parsed.payload);
    return webhookAcknowledged;
  })
  .post("/api/webhooks/bitbucket", ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): unknown => {
    const parsed = webhookPayload(body);
    if (parsed === undefined) return webhookUnprocessable(set, "Invalid webhook payload");
    const secret = process.env.BITBUCKET_WEBHOOK_SECRET;
    if (typeof secret !== "string" || secret === "") {
      return webhookUnauthorized(set, "Bitbucket webhook secret is not configured");
    }
    const signature = request.headers.get("x-hub-signature");
    const expected = `sha256=${createHmac("sha256", secret).update(parsed.rawBody).digest("hex")}`;
    if (!sameSecret(signature, expected)) return webhookUnauthorized(set, "Invalid Bitbucket webhook signature");
    const eventName = request.headers.get("x-event-key");
    if (eventName === null || eventName === "") return webhookUnprocessable(set, "Missing Bitbucket event header");
    void processProviderDelivery(handleBitbucketWebhook, eventName, parsed.payload);
    return webhookAcknowledged;
  })
  // --- External Apply Approval Webhook (kanban 21.8) ---
  // Lets a ServiceNow/Jira/other workflow unblock an apply that the site
  // has gated behind external approval (admin `approval-webhook` settings).
  // Signature: `X-Terrence-Signature: <sha256 hex HMAC of the raw body>`.
  .post("/api/v2/webhooks/run-approval", async ({ request, body, set }: Readonly<{ request: Request; body: unknown; set: SetObj }>): Promise<unknown> => {
    const settings = await getSettings("approval-webhook");
    if (settings.enabled !== true) {
      return webhookUnprocessable(set, "External apply approval is not enabled");
    }
    const secret = settings.secret;
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
    const runId = typeof parsed.run === "string" ? parsed.run : typeof parsed.run_id === "string" ? parsed.run_id : "";
    if (runId === "") return webhookUnprocessable(set, "Missing run id");
    const outcome = await confirmRunForApply(runId);
    if (!outcome.ok) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: outcome.reason ?? "Apply could not be started" }] };
    }
    log.info(`Approval webhook confirmed apply for run ${runId}`);
    return { data: { id: runId, type: "runs", attributes: { status: outcome.status } } };
  })
  // --- Entitlements ---
  .get("/api/v2/entitlements", (): unknown => ({
    data: {
      id: "entitlements",
      type: "entitlements",
      attributes: {
        agents: true,
        audit_logging: true,
        sentinel: true,
        state_storage: true,
        teams: true,
        vcs_integrations: true,
        run_tasks: true,
        configuration_designer: true,
        module_tests_generation: true,
        module_deprecations: true,
        module_revocations: true,
        private_policy_agents: true,
        private_run_tasks: true,
        private_vcs: true,
        global_run_tasks: true,
        groups: false,
      },
    },
  }))
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
      const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
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
      const variables = await db.query.workspaceVariables.findMany({
        where: eq(workspaceVariables.workspaceId, authorized.id),
      });
      return { data: variables.map(globalVariableResource) };
    }

    const variables = await db.query.workspaceVariables.findMany();
    const workspaceIds = [...new Set(variables.map((variable: WorkspaceVariable): string => variable.workspaceId))];
    const authorized = await Promise.all(workspaceIds.map(async (workspaceId): Promise<string | null> =>
      (await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "variables-read")) === undefined ? null : workspaceId,
    ));
    const allowed = new Set(authorized.filter((workspaceId): workspaceId is string => workspaceId !== null));
    return { data: variables.filter((variable: WorkspaceVariable): boolean => allowed.has(variable.workspaceId)).map(globalVariableResource) };
  })
  .post("/api/v2/vars", async ({ body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attributes = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    const relationships = data.relationships !== null && typeof data.relationships === "object" ? data.relationships as Record<string, unknown> : {};
    const workspaceRelationship = relationships.workspace !== null && typeof relationships.workspace === "object"
      ? relationships.workspace as Record<string, unknown>
      : {};
    const workspaceData = workspaceRelationship.data !== null && typeof workspaceRelationship.data === "object"
      ? workspaceRelationship.data as Record<string, unknown>
      : {};
    const workspaceId = typeof workspaceData.id === "string" ? workspaceData.id : "";
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "variables-write");
    const normalizedAttributes: Record<string, unknown> & { value: string } = {
      ...attributes,
      value: typeof attributes.value === "string" ? attributes.value : "",
    };
    if (
      workspace === undefined
      || data.type !== "vars"
      || workspaceData.type !== "workspaces"
      || !validVariableAttributes(normalizedAttributes)
    ) {
      (set as { status: number }).status = workspace === undefined ? 404 : 422;
      return { errors: [{ status: String(workspace === undefined ? 404 : 422), title: workspace === undefined ? "Not Found" : "Unprocessable Entity" }] };
    }
    const categoryValue: unknown = normalizedAttributes.category;
    const descriptionValue: unknown = normalizedAttributes.description;
    const variable: typeof workspaceVariables.$inferInsert = {
      id: `var-${crypto.randomUUID()}`,
      workspaceId,
      key: normalizedAttributes.key as string,
      value: normalizedAttributes.value,
      category: categoryValue === "env" ? "env" : "terraform",
      sensitive: normalizedAttributes.sensitive === true,
      hcl: normalizedAttributes.hcl === true,
      description: typeof descriptionValue === "string" ? descriptionValue : null,
    };
    await db.insert(workspaceVariables).values(variable);
    (set as { status: number }).status = 201;
    return { data: globalVariableResource(variable as WorkspaceVariable) };
  })
  .patch("/api/v2/vars/:var_id", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const variableId = params.var_id ?? "";
    const variable = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, variableId) });
    const workspace = variable === undefined
      ? undefined
      : await findAuthorizedWorkspace(variable.workspaceId, user?.id, orgId, teamId, "variables-write");
    if (variable === undefined || workspace === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const attributes = data.attributes !== null && typeof data.attributes === "object" ? data.attributes as Record<string, unknown> : {};
    if ((data.type !== undefined && data.type !== "vars") || !validVariableAttributes(attributes, true)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    let sensitive = typeof attributes.sensitive === "boolean" ? attributes.sensitive : variable.sensitive === true;
    if (variable.sensitive === true && !sensitive && attributes.value === undefined) sensitive = true;
    const updates: Partial<typeof workspaceVariables.$inferInsert> = {
      key: typeof attributes.key === "string" ? attributes.key : variable.key,
      value: typeof attributes.value === "string" ? attributes.value : variable.value,
      category: typeof attributes.category === "string" ? attributes.category : variable.category,
      sensitive,
      hcl: typeof attributes.hcl === "boolean" ? attributes.hcl : variable.hcl === true,
      description: attributes.description === null
        ? null
        : typeof attributes.description === "string" ? attributes.description : variable.description,
    };
    await db.update(workspaceVariables).set(updates).where(eq(workspaceVariables.id, variable.id));
    return { data: globalVariableResource({ ...variable, ...updates } as WorkspaceVariable) };
  })
  .delete("/api/v2/vars/:var_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const variableId = params.var_id ?? "";
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
    return {};
  })
  // --- Audit Trails ---
  .get("/api/v2/admin/audit-logs", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const logsList = await db.query.auditLogs.findMany({ limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return { data: (await auditTrailResources(logsList)).map((resource): Record<string, unknown> => ({ ...resource, type: "audit-logs" })) };
  })
  .get("/api/v2/organizations/:org_name/audit-logs", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId, null, "audit-logs:read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const logsList = await db.query.auditLogs.findMany({ where: eq(auditLogs.orgId, org.id), limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return { data: await auditTrailResources(logsList) };
  })
  .get("/api/v2/organizations/:org_name/audit-configuration", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    // go-tfe OrganizationAuditConfigurations.Read. HCP-only fields are null for
    // a TFE-style deployment; audit trails are always enabled here.
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
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
  .get("/api/v2/organization-audit-trailers", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: await auditTrailResources(await auditLogsForUser(user)) };
  })
  .get("/api/v2/audit-trails", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: await auditTrailResources(await auditLogsForUser(user)) };
  })
  // --- Cost Estimation ---
  .get("/api/v2/runs/:run_id/cost-estimate", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId, teamId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: costEstimateResource(authorized.run, await readCostEstimateArtifact(runId)) };
  })
  .get("/api/v2/cost-estimates/:ce_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const ceId = params.ce_id ?? "";
    const runId = ceId.replace(/^ce-/, "");
    if (runId === "") { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(runId, user?.id, orgId, teamId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: costEstimateResource(authorized.run, await readCostEstimateArtifact(runId)) };
  })
  // --- Run Triggers ---
  .get("/api/v2/workspaces/:workspace_id/run-triggers", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId)) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const filterType = request !== undefined ? new URL(request.url).searchParams.get("filter[run-trigger][type]") ?? "" : "";
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
    const workspaceId = params.workspace_id ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const sourceable = rels.sourceable as Record<string, unknown> | undefined;
    const srcData = typeof sourceable?.data === "object" && sourceable.data !== null ? (sourceable.data as Record<string, unknown>) : undefined;
    const srcId = typeof srcData?.id === "string" ? srcData.id : "";
    const srcWs = srcId !== "" ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, srcId) }) : undefined;
    if (srcWs === undefined || srcWs.orgId !== ws.orgId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Sourceable workspace must belong to the same organization" }] }; }
    if (srcId === workspaceId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Sourceable workspace cannot be the workspace itself" }] }; }
    const id = `rt-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runTriggers).values({ id, workspaceId, sourceWorkspaceId: srcId }).onConflictDoNothing();
    (set as { status: number }).status = 201;
    return { data: { id, type: "run-triggers", attributes: { "created-at": new Date().toISOString(), "sourceable-name": srcWs.name, "workspace-name": ws.name }, relationships: { sourceable: { data: { id: srcId, type: "workspaces" } }, "sourceable-workspace": { data: { id: srcId, type: "workspaces" } }, workspace: { data: { id: workspaceId, type: "workspaces" } } } } };
  })
  .get("/api/v2/run-triggers/:run_trigger_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const triggerId = params.run_trigger_id ?? "";
    const trigger = triggerId !== "" ? await db.query.runTriggers.findFirst({ where: eq(runTriggers.id, triggerId) }) : undefined;
    if (trigger === undefined || (await findAuthorizedWorkspace(trigger.workspaceId, user?.id, tokenOrgId, tokenTeamId)) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [tw, sw] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, trigger.workspaceId), columns: { name: true } }),
      db.query.workspaces.findFirst({ where: eq(workspaces.id, trigger.sourceWorkspaceId), columns: { name: true } }),
    ]);
    return { data: { id: trigger.id, type: "run-triggers", attributes: { "created-at": new Date(trigger.createdAt).toISOString(), "sourceable-name": sw?.name ?? "", "workspace-name": tw?.name ?? "" }, relationships: { sourceable: { data: { id: trigger.sourceWorkspaceId, type: "workspaces" } }, "sourceable-workspace": { data: { id: trigger.sourceWorkspaceId, type: "workspaces" } }, workspace: { data: { id: trigger.workspaceId, type: "workspaces" } } } } };
  })
  .delete("/api/v2/run-triggers/:run_trigger_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const triggerId = params.run_trigger_id ?? "";
    const trigger = triggerId !== "" ? await db.query.runTriggers.findFirst({ where: eq(runTriggers.id, triggerId) }) : undefined;
    if (trigger === undefined || (await findAuthorizedWorkspace(trigger.workspaceId, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runTriggers).where(eq(runTriggers.id, triggerId));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item !== null && typeof item === "object") {
          const i = item as Record<string, unknown>;
          const attrs = typeof i.attributes === "object" && i.attributes !== null ? (i.attributes as Record<string, unknown>) : undefined;
          const srcId = typeof i.id === "string" ? i.id : (typeof attrs?.["source-workspace-id"] === "string" ? attrs["source-workspace-id"] : "");
          if (srcId !== "") {
            await db.insert(runTriggers).values({ id: `rt-${crypto.randomUUID()}`, workspaceId, sourceWorkspaceId: srcId }).onConflictDoNothing();
          }
        }
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || (await findAuthorizedWorkspace(ws.id, user?.id, tokenOrgId, tokenTeamId, "admin")) === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const srcIds = items.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== "");
      if (srcIds.length > 0) {
        await db.delete(runTriggers).where(and(eq(runTriggers.workspaceId, workspaceId), inArray(runTriggers.sourceWorkspaceId, srcIds)));
      }
    }
    (set as { status: number }).status = 204;
    return {};
  });
