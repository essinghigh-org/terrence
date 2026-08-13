import { count, desc, eq, and, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { db } from "../db";
import { changeRequests, organizations, users, workspaces } from "../db/schema";
import {
  checkOrganizationPermission,
  checkOrgPermission,
  checkWorkspacePermission,
  pageRequest,
  pagination,
  auditLog,
  workspaceIdsForPermission,
} from "../lib/utils";
import { queueChangeRequestNotification } from "../lib/notifications";

type SetObject = Readonly<{
  status?: number | string;
  headers: Readonly<Record<string, string | number>>;
}>;

type Context = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  teamId?: string | null;
  request: Readonly<{ url: string }>;
  set: SetObject;
}>;

type ChangeRequest = Readonly<typeof changeRequests.$inferSelect>;
type Workspace = Readonly<typeof workspaces.$inferSelect>;

const VALID_STATUSES = ["pending", "approved", "discarded", "archived"] as const;

function errorResponse(set: SetObject, status: number, title: string, detail?: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  return {
    errors: [{
      status: String(status),
      title,
      ...(detail === undefined ? {} : { detail }),
    }],
  };
}

function resource(changeRequest: ChangeRequest, compatibility = false): Record<string, unknown> {
  if (compatibility) {
    return {
      id: changeRequest.id,
      type: "workspace-change-requests",
      attributes: {
        subject: changeRequest.subject,
        message: changeRequest.message,
        status: changeRequest.status,
        "archived-by": changeRequest.status === "approved" ? changeRequest.resolvedBy : null,
        "archived-at": changeRequest.status === "approved" && changeRequest.resolvedAt !== null
          ? new Date(changeRequest.resolvedAt).toISOString()
          : null,
        "resolved-by": changeRequest.resolvedBy,
        "resolved-at": changeRequest.resolvedAt === null ? null : new Date(changeRequest.resolvedAt).toISOString(),
        "created-at": new Date(changeRequest.createdAt).toISOString(),
        "updated-at": new Date(changeRequest.updatedAt).toISOString(),
      },
      relationships: {
        workspace: { data: { id: changeRequest.workspaceId, type: "workspaces" } },
        creator: { data: changeRequest.createdBy === null ? null : { id: changeRequest.createdBy, type: "users" } },
      },
      links: { self: `/api/v2/change-requests/${changeRequest.id}` },
    };
  }
  return {
    id: changeRequest.id,
    type: "workspace_change_requests",
    attributes: {
      subject: changeRequest.subject,
      message: changeRequest.message,
      status: changeRequest.status,
      "archived-by": changeRequest.status === "archived" ? changeRequest.resolvedBy : null,
      "archived-at": changeRequest.status === "archived" && changeRequest.resolvedAt !== null
        ? new Date(changeRequest.resolvedAt).toISOString()
        : null,
      "created-at": new Date(changeRequest.createdAt).toISOString(),
      "updated-at": new Date(changeRequest.updatedAt).toISOString(),
      "resolved-by": changeRequest.resolvedBy,
      "resolved-at": changeRequest.resolvedAt === null ? null : new Date(changeRequest.resolvedAt).toISOString(),
    },
    relationships: {
      workspace: { data: { id: changeRequest.workspaceId, type: "workspaces" } },
      creator: {
        data: changeRequest.createdBy === null ? null : { id: changeRequest.createdBy, type: "users" },
      },
      resolver: {
        data: changeRequest.resolvedBy === null ? null : { id: changeRequest.resolvedBy, type: "users" },
      },
    },
  };
}

function changeRequestValues(
  workspaceId: string,
  subject: string,
  message: string,
  createdBy: string | null,
  now: number,
): ChangeRequest {
  return {
    id: `wscr-${crypto.randomUUID()}`,
    workspaceId,
    subject,
    message,
    status: "pending",
    createdBy,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ponytail: supports the documented workspace-name query; reuse a full Explorer engine when one exists.
function queryWorkspaceIds(
  query: unknown,
  candidates: readonly Readonly<{ id: string; name: string }>[],
): string[] | undefined {
  if (query === null || typeof query !== "object") return undefined;
  const value = query as Record<string, unknown>;
  if (value.type !== "workspaces") return undefined;
  if (value.filter === undefined) return candidates.map((workspace): string => workspace.id);
  if (!Array.isArray(value.filter)) return undefined;

  let matches = [...candidates];
  for (const filter of value.filter) {
    if (filter === null || typeof filter !== "object") return undefined;
    const nameFilter = (filter as Record<string, unknown>).workspace_name;
    if (nameFilter === null || typeof nameFilter !== "object") return undefined;
    const entries = Object.entries(nameFilter as Record<string, unknown>);
    if (entries.length !== 1) return undefined;
    const [operator, values] = entries[0] ?? [];
    if (!Array.isArray(values) || values.length !== 1) return undefined;
    const operand: unknown = (values as readonly unknown[])[0];
    if (typeof operand !== "string") return undefined;
    if (operator === "contains") matches = matches.filter((workspace): boolean => workspace.name.includes(operand));
    else if (operator === "is") matches = matches.filter((workspace): boolean => workspace.name === operand);
    else return undefined;
  }
  return matches.map((workspace): string => workspace.id);
}

async function authorizedWorkspace(
  identifier: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  required: "read" | "admin" = "read",
): Promise<Workspace | undefined> {
  const byId = await db.query.workspaces.findFirst({ where: eq(workspaces.id, identifier) });
  if (byId !== undefined && await checkWorkspacePermission(byId, userId, tokenOrgId, tokenTeamId, required)) return byId;
  const byName = await db.query.workspaces.findMany({ where: eq(workspaces.name, identifier) });
  for (const workspace of byName) {
    if (await checkWorkspacePermission(workspace, userId, tokenOrgId, tokenTeamId, required)) return workspace;
  }
  return undefined;
}

async function authorizedChangeRequest(
  id: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  required: "read" | "apply" = "read",
): Promise<ChangeRequest | undefined> {
  const changeRequest = await db.query.changeRequests.findFirst({ where: eq(changeRequests.id, id) });
  if (changeRequest === undefined) return undefined;
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, changeRequest.workspaceId) });
  if (workspace === undefined || !(await checkWorkspacePermission(workspace, userId, tokenOrgId, tokenTeamId, required))) return undefined;
  return changeRequest;
}

/** Detail/inbox resource enriched with creator and resolver usernames. */
async function enrichedResource(changeRequest: ChangeRequest): Promise<Record<string, unknown>> {
  const base = resource(changeRequest);
  const ids = [...new Set([
    ...(changeRequest.createdBy === null ? [] : [changeRequest.createdBy]),
    ...(changeRequest.resolvedBy === null ? [] : [changeRequest.resolvedBy]),
  ])];
  const userRows = ids.length === 0
    ? []
    : await db.query.users.findMany({ where: inArray(users.id, ids), columns: { id: true, username: true } });
  const usernamesById = new Map(userRows.map((row): [string, string] => [row.id, row.username]));
  return {
    ...base,
    attributes: {
      ...(base.attributes as Record<string, unknown>),
      "created-by-username": changeRequest.createdBy === null ? null : usernamesById.get(changeRequest.createdBy) ?? null,
      "resolved-by-username": changeRequest.resolvedBy === null ? null : usernamesById.get(changeRequest.resolvedBy) ?? null,
    },
  };
}

async function resolveChangeRequest(
  id: string,
  status: "approved" | "archived" | "discarded",
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  set: SetObject,
  required: "read" | "apply" = "read",
  compatibility = true,
): Promise<unknown> {
  const changeRequest = await authorizedChangeRequest(id, userId, tokenOrgId, tokenTeamId, required);
  if (changeRequest === undefined) return errorResponse(set, 404, "Not Found");
  if (changeRequest.status !== "pending") {
    return errorResponse(set, 409, "Conflict", "Change request is already resolved");
  }
  const now = Date.now();
  await db.update(changeRequests).set({
    status,
    resolvedBy: userId ?? null,
    resolvedAt: now,
    updatedAt: now,
  }).where(eq(changeRequests.id, id));
  const workspace = await db.query.workspaces.findFirst({
    columns: { orgId: true },
    where: eq(workspaces.id, changeRequest.workspaceId),
  });
  await auditLog(status, "change-requests", id, userId ?? null, workspace?.orgId ?? null, {
    workspaceId: changeRequest.workspaceId,
    fromStatus: changeRequest.status,
    toStatus: status,
  });
  const updated = await db.query.changeRequests.findFirst({ where: eq(changeRequests.id, id) });
  if (updated === undefined) return errorResponse(set, 404, "Not Found");
  return { data: resource(updated, compatibility) };
}

export const changeRequestRoutes = new Elysia({ name: "change-requests" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/change-requests", async ({ params, user, orgId, teamId, request, set }: Context): Promise<unknown> => {
    const workspace = await authorizedWorkspace(params.workspace_id ?? "", user?.id, orgId ?? null, teamId ?? null);
    if (workspace === undefined) return errorResponse(set, 404, "Not Found");
    const { number, size } = pageRequest(request);
    const [rows, counts] = await Promise.all([
      db.query.changeRequests.findMany({
        where: eq(changeRequests.workspaceId, workspace.id),
        orderBy: [desc(changeRequests.createdAt)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(changeRequests).where(eq(changeRequests.workspaceId, workspace.id)),
    ]);
    return {
      data: rows.map((row): Record<string, unknown> => resource(row)),
      ...pagination(request, number, size, counts[0]?.total ?? 0),
    };
  })
  .post("/api/v2/workspaces/:workspace_id/change-requests", async ({ params, body, user, orgId, teamId, set }: Context): Promise<unknown> => {
    const workspace = await authorizedWorkspace(params.workspace_id ?? "", user?.id, orgId ?? null, teamId ?? null, "admin");
    if (workspace === undefined) return errorResponse(set, 404, "Not Found");
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data;
    const attributes = data !== null && typeof data === "object"
      && (data as Record<string, unknown>).attributes !== null
      && typeof (data as Record<string, unknown>).attributes === "object"
      ? (data as Record<string, unknown>).attributes as Record<string, unknown>
      : {};
    const subject = typeof attributes.subject === "string" ? attributes.subject.trim() : "";
    const message = typeof attributes.message === "string" ? attributes.message.trim() : "";
    if (subject === "" || message === "") {
      return errorResponse(set, 422, "Unprocessable Entity", "Subject and message are required");
    }
    const changeRequest = changeRequestValues(workspace.id, subject, message, user?.id ?? null, Date.now());
    await db.insert(changeRequests).values(changeRequest);
    queueChangeRequestNotification(changeRequest.id);
    await auditLog("create", "change-requests", changeRequest.id, user?.id ?? null, workspace.orgId, {
      workspaceId: workspace.id,
      toStatus: "pending",
    });
    (set as { status: number }).status = 201;
    return { data: resource(changeRequest, true) };
  })
  .post("/api/v2/organizations/:org_name/explorer/bulk-actions", async ({ params, body, user, orgId, teamId, set }: Context): Promise<unknown> => {
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.name, params.org_name ?? ""),
    });
    if (
      organization === undefined
      || !(await checkOrganizationPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "manage-workspaces"))
    ) return errorResponse(set, 404, "Not Found");

    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data;
    const dataObject = data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
    const attributes = dataObject.attributes !== null && typeof dataObject.attributes === "object"
      ? dataObject.attributes as Record<string, unknown>
      : {};
    const inputs = attributes.action_inputs !== null && typeof attributes.action_inputs === "object"
      ? attributes.action_inputs as Record<string, unknown>
      : {};
    const subject = typeof inputs.subject === "string" ? inputs.subject.trim() : "";
    const message = typeof inputs.message === "string" ? inputs.message.trim() : "";
    const actionType = attributes.action_type;
    const targetIds = attributes.target_ids;
    const query = attributes.query;
    if (
      dataObject.type !== "bulk_actions"
      || (actionType !== "change_request" && actionType !== "change_requests")
      || subject === ""
      || message === ""
      || (targetIds === undefined) === (query === undefined)
    ) return errorResponse(set, 422, "Unprocessable Entity", "Valid change request inputs and exactly one target selector are required");

    const candidates = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    let selectedIds: string[] | undefined;
    if (targetIds !== undefined) {
      if (!Array.isArray(targetIds) || targetIds.length === 0 || targetIds.some((id): boolean => typeof id !== "string")) {
        return errorResponse(set, 422, "Unprocessable Entity", "target_ids must contain workspace IDs");
      }
      const candidateIds = new Set(candidates.map((workspace): string => workspace.id));
      selectedIds = [...new Set(targetIds as string[])];
      if (selectedIds.some((id): boolean => !candidateIds.has(id))) selectedIds = undefined;
    } else {
      selectedIds = queryWorkspaceIds(query, candidates);
    }
    if (selectedIds === undefined || selectedIds.length === 0) {
      return errorResponse(set, 422, "Unprocessable Entity", "The target selector did not resolve to workspaces");
    }

    const now = Date.now();
    const records = selectedIds.map((workspaceId): ChangeRequest =>
      changeRequestValues(workspaceId, subject, message, user?.id ?? null, now));
    await db.insert(changeRequests).values(records);
    for (const record of records) queueChangeRequestNotification(record.id);
    // Audit writes are independent of the notifications; run them with
    // bounded concurrency so a very large bulk action cannot open hundreds
    // of simultaneous write transactions.
    const AUDIT_CONCURRENCY = 10;
    for (let i = 0; i < records.length; i += AUDIT_CONCURRENCY) {
      await Promise.all(records.slice(i, i + AUDIT_CONCURRENCY).map((record): Promise<void> =>
        auditLog("create", "change-requests", record.id, user?.id ?? null, organization.id, {
          workspaceId: record.workspaceId,
          toStatus: "pending",
        })));
    }
    (set as { status: number }).status = 201;
    return {
      data: {
        id: `eba-${crypto.randomUUID()}`,
        type: "explorer_bulk_actions",
        attributes: {
          organization_id: organization.id,
          action_type: "change_requests",
          action_inputs: { subject, message },
          created_by: user === null || user === undefined ? null : { id: user.id, type: "users" },
        },
      },
    };
  })
  .get("/api/v2/organizations/:org_name/change-requests", async ({ params, user, orgId, teamId, request, set }: Context): Promise<unknown> => {
    // Org-wide change request inbox (21.9). Scoped like the calendar: org
    // membership gates the endpoint, workspace read access gates the rows.
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.name, params.org_name ?? ""),
    });
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId ?? null, teamId ?? null))) {
      return errorResponse(set, 404, "Not Found");
    }
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("filter[status]");
    const statuses = statusFilter === null || statusFilter === ""
      ? null
      : [...new Set(statusFilter.split(",").map((value: string): string => value.trim()).filter((value: string): boolean => value !== ""))];
    if (statuses !== null && (statuses.length === 0 || statuses.some((value: string): boolean => !VALID_STATUSES.includes(value as typeof VALID_STATUSES[number])))) {
      return errorResponse(set, 422, "Unprocessable Entity", "filter[status] must contain pending, approved, discarded, or archived");
    }
    const { number, size } = pageRequest(request);
    // Scope rows by readable workspaces, matching the calendar and the
    // per-workspace list: a member must not see change requests for
    // workspaces they cannot read.
    const readable = await workspaceIdsForPermission(organization.id, user?.id, orgId ?? null, teamId ?? null, "read");
    const orgWorkspaceIds = readable === null
      ? (await db.query.workspaces.findMany({
          where: eq(workspaces.orgId, organization.id),
          columns: { id: true },
        })).map((row): string => row.id)
      : [...readable];
    if (orgWorkspaceIds.length === 0) {
      // No readable workspaces: nothing to list, but pagination metadata
      // must still be well-formed.
      return { data: [], ...pagination(request, number, size, 0) };
    }
    // SQLite drivers cap bound parameters per statement; chunk huge id
    // lists and merge in JS so org-wide inboxes cannot hit the limit.
    const ID_CHUNK = 500;
    const statusesWhere = statuses === null ? [] : [inArray(changeRequests.status, statuses)];
    const chunkCount = Math.ceil(orgWorkspaceIds.length / ID_CHUNK);
    const chunked = async <T>(
      run: (ids: readonly string[]) => Promise<T[]>,
      combine: (chunks: T[][]) => T[],
    ): Promise<T[]> => {
      const results: T[][] = [];
      for (let i = 0; i < chunkCount; i += 1) {
        const ids = orgWorkspaceIds.slice(i * ID_CHUNK, (i + 1) * ID_CHUNK);
        results.push(await run(ids));
      }
      return combine(results);
    };
    const [rows, counts] = await Promise.all([
      chunked(
        (ids): Promise<Readonly<typeof changeRequests.$inferSelect>[]> =>
          db.query.changeRequests.findMany({
            where: and(inArray(changeRequests.workspaceId, ids), ...statusesWhere),
            orderBy: [desc(changeRequests.createdAt), desc(changeRequests.id)],
            // Each chunk must cover the FULL requested window from its own
            // start (offset 0): a row that ranks early in its chunk would
            // otherwise fall outside a chunk-local offset window and vanish
            // from the merged page.
            limit: number * size,
          }),
        (chunks): Readonly<typeof changeRequests.$inferSelect>[] => {
          const merged = chunks.flat().sort((a, b): number =>
            b.createdAt - a.createdAt || b.id.localeCompare(a.id));
          return merged.slice((number - 1) * size, number * size);
        },
      ),
      chunked(
        (ids): Promise<Readonly<{ total: number }>[]> =>
          db.select({ total: count() }).from(changeRequests)
            .where(and(inArray(changeRequests.workspaceId, ids), ...statusesWhere)),
        (chunks): { total: number }[] => [{
          total: chunks.reduce((sum: number, chunk): number => sum + (chunk[0]?.total ?? 0), 0),
        }],
      ),
    ]);
    const [namesById, userRows] = await Promise.all([
      rows.length === 0
        ? Promise.resolve(new Map<string, string>())
        : db.query.workspaces.findMany({
          where: inArray(workspaces.id, [...new Set(rows.map((row): string => row.workspaceId))]),
          columns: { id: true, name: true },
        }).then((found): Map<string, string> => new Map(found.map((row): [string, string] => [row.id, row.name]))),
      rows.length === 0
        ? Promise.resolve([])
        : db.query.users.findMany({
          where: inArray(users.id, [...new Set(rows.flatMap((row): string[] => [
            ...(row.createdBy === null ? [] : [row.createdBy]),
            ...(row.resolvedBy === null ? [] : [row.resolvedBy]),
          ]))]),
          columns: { id: true, username: true },
        }),
    ]);
    const usernamesById = new Map(userRows.map((row): [string, string] => [row.id, row.username]));
    return {
      data: rows.map((row): Record<string, unknown> => {
        const base = resource(row);
        return {
          ...base,
          attributes: {
            ...(base.attributes as Record<string, unknown>),
            "workspace-name": namesById.get(row.workspaceId) ?? null,
            "created-by-username": row.createdBy === null ? null : usernamesById.get(row.createdBy) ?? null,
            "resolved-by-username": row.resolvedBy === null ? null : usernamesById.get(row.resolvedBy) ?? null,
          },
        };
      }),
      ...pagination(request, number, size, counts[0]?.total ?? 0),
    };
  })
  .get("/api/v2/change-requests/:change_request_id", async ({ params, user, orgId, teamId, set }: Context): Promise<unknown> => {
    const changeRequest = await authorizedChangeRequest(params.change_request_id ?? "", user?.id, orgId ?? null, teamId ?? null);
    return changeRequest === undefined
      ? errorResponse(set, 404, "Not Found")
      : { data: await enrichedResource(changeRequest) };
  })
  .get("/api/v2/workspaces/change-requests/:change_request_id", async ({ params, user, orgId, teamId, set }: Context): Promise<unknown> => {
    const changeRequest = await authorizedChangeRequest(params.change_request_id ?? "", user?.id, orgId ?? null, teamId ?? null);
    return changeRequest === undefined
      ? errorResponse(set, 404, "Not Found")
      : { data: await enrichedResource(changeRequest) };
  })
  .post("/api/v2/change-requests/:change_request_id/actions/approve", async ({ params, user, orgId, teamId, set }: Context): Promise<unknown> =>
    resolveChangeRequest(params.change_request_id ?? "", "approved", user?.id, orgId ?? null, teamId ?? null, set))
  .post("/api/v2/change-requests/:change_request_id/actions/discard", async ({ params, user, orgId, teamId, set }: Context): Promise<unknown> =>
    resolveChangeRequest(params.change_request_id ?? "", "discarded", user?.id, orgId ?? null, teamId ?? null, set))
  .patch("/api/v2/workspaces/change-requests/:change_request_id", async ({ params, user, orgId, teamId, set }: Context): Promise<unknown> =>
    resolveChangeRequest(params.change_request_id ?? "", "archived", user?.id, orgId ?? null, teamId ?? null, set, "apply", false));
