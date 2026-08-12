import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, organizationMemberships, organizationDataRetentionPolicies, reservedTagKeys, apiTokens, samlSettings, teams, workspaces, configurationVersions, stateVersions, workspaceVariables, workspaceTags, logs, runs, type users } from "../db/schema";
import { eq, and, asc, like, count, inArray } from "drizzle-orm";
import { organizationResource, organizationName } from "../lib/response";
import { applyDataRetentionGarbageCollection, auditLog, checkOrganizationPermissionsMany, checkOrgPermission, deleteWorkspaceData, pageRequest, pagination } from "../lib/utils";
import { currentTokenScopes } from "../lib/request-scope";
import { isUniqueConstraintError } from "../lib/validation";
import { invalidateOrganizationName } from "../lib/metadata-cache";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";
import { getSiteCapabilities } from "../lib/settings";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  teamId?: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

type ReservedTagKey = Readonly<typeof reservedTagKeys.$inferSelect>;
type OrganizationItem = Readonly<typeof organizations.$inferSelect>;

const RESERVED_ORGANIZATION_NAMES = new Set(["account", "admin"]);

function organizationNameError(name: string): string | null {
  if (RESERVED_ORGANIZATION_NAMES.has(name.toLowerCase())) return "Organization name is reserved";
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return "Organization name can only include letters, numbers, hyphens, and underscores";
  }
  return null;
}

async function organizationResourceForPrincipal(
  org: OrganizationItem,
  userId: string | undefined,
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
): Promise<Record<string, unknown>> {
  const [canManageOrganization, orgPermissionFlags, capabilities] = await Promise.all([
    checkOrgPermission(userId, org.id, "owner", tokenOrgId ?? null, tokenTeamId ?? null),
    checkOrganizationPermissionsMany(
      org.id,
      userId,
      tokenOrgId,
      tokenTeamId,
      ["manage-workspaces", "read-projects", "manage-projects", "manage-vcs-settings", "manage-agent-pools", "manage-teams", "manage-membership", "manage-organization-access", "manage-policies", "read-policies", "manage-providers"],
    ),
    getSiteCapabilities(),
  ]);
  const [
    canManageWorkspaces,
    canReadProjects,
    canManageProjects,
    canManageVcsSettings,
    canManageAgentPools,
    canCreateTeam,
    canManageUsers,
    canUpdateOrganizationAccess,
    canManagePolicies,
    canReadPolicies,
    canManageProviders,
  ] = orgPermissionFlags;
  const resource = organizationResource(org);
  return {
    ...resource,
    attributes: {
      ...(resource.attributes as Record<string, unknown>),
      permissions: {
        "can-update": canManageOrganization,
        "can-destroy": canManageOrganization,
        "can-create-team": canCreateTeam,
        "can-manage-users": canManageUsers,
        "can-update-organization-access": canUpdateOrganizationAccess,
        "can-manage-workspaces": canManageWorkspaces,
        "can-read-projects": canReadProjects,
        "can-manage-projects": canManageProjects,
        "can-manage-vcs-settings": canManageVcsSettings,
        "can-manage-agent-pools": canManageAgentPools,
        "can-manage-policies": canManagePolicies,
        "can-read-policies": canReadPolicies,
        "can-manage-auditing": canManageOrganization,
        "can-manage-providers": canManageProviders,
        "can-manage-organization-access": canUpdateOrganizationAccess,
      },
      capabilities,
    },
  };
}

function reservedTagKeyInput(body: unknown): Readonly<{ key: string; disableOverrides: boolean }> | Readonly<{ error: string }> {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const rawData = payload.data;
  const data = rawData !== null && typeof rawData === "object" ? rawData as Record<string, unknown> : {};
  const rawAttributes = data.attributes;
  const attributes = rawAttributes !== null && typeof rawAttributes === "object" ? rawAttributes as Record<string, unknown> : {};
  if (data.type !== "reserved-tag-keys") return { error: "data.type must be reserved-tag-keys" };
  const rawKey = attributes.key;
  if (typeof rawKey !== "string" || typeof attributes["disable-overrides"] !== "boolean") {
    return { error: "key and disable-overrides are required" };
  }
  const key = rawKey.trim();
  if (key.length === 0 || key.length > 128 || !/^[A-Za-z0-9 .=+@:_-]+$/.test(key)) {
    return { error: "key must be 1-128 characters and contain only letters, numbers, spaces, or .=+-@:_ characters" };
  }
  return { key, disableOverrides: attributes["disable-overrides"] };
}

async function reservedTagKeyResource(tag: ReservedTagKey): Promise<Record<string, unknown>> {
  return {
    id: tag.id,
    type: "reserved-tag-keys",
    attributes: {
      key: tag.key,
      "disable-overrides": tag.disableOverrides,
      "created-at": new Date(tag.createdAt).toISOString(),
      "updated-at": new Date(tag.updatedAt).toISOString(),
    },
    relationships: {
      organization: { data: { id: (await organizationName(tag.orgId)) ?? tag.orgId, type: "organizations" } },
    },
    links: { self: `/api/v2/reserved-tags/${tag.id}` },
  };
}

export const organizationRoutes = new Elysia({ name: "organizations" })
  .use(authPlugin)
  .post("/api/v2/organizations", async ({ user, orgId: tokenOrgId, teamId: tokenTeamId, body, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const defaultIacBinary = typeof attributes["default-iac-binary"] === "string" ? attributes["default-iac-binary"] : "tofu";
    const defaultTerraformVersion = typeof attributes["default-terraform-version"] === "string" ? attributes["default-terraform-version"].trim() : "latest";
    const assessmentsEnforced = attributes["assessments-enforced"] === true;
    const email = attributes.email === undefined
      ? null
      : typeof attributes.email === "string"
        ? attributes.email.trim() === "" ? null : attributes.email.trim()
        : null;
    const allowForceDeleteWorkspaces = attributes["allow-force-delete-workspaces"] !== false;
    const stacksEnabled = attributes["stacks-enabled"] === true;
    const showPreReleases = attributes["show-pre-releases"] === true;
    const defaultExecutionMode = typeof attributes["default-execution-mode"] === "string"
      && ["remote", "local", "agent"].includes(attributes["default-execution-mode"])
      ? attributes["default-execution-mode"]
      : "remote";
    if (name === "") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }
    const nameError = organizationNameError(name);
    if (nameError !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: nameError }] };
    }
    if (user === null || user === undefined) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    if (!["tofu", "terraform"].includes(defaultIacBinary) || defaultTerraformVersion === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    try {
      const id = crypto.randomUUID();
      const saml = await db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") });
      const org = {
        id,
        name,
        email,
        defaultIacBinary,
        defaultTerraformVersion,
        assessmentsEnforced,
        globalModuleSharing: false,
        globalProviderSharing: false,
        accessBetaTools: false,
        workspaceLimit: null,
        samlEnabled: saml?.enabled ?? false,
        ownersTeamSamlRoleId: null,
        allowForceDeleteWorkspaces,
        stacksEnabled,
        showPreReleases,
        defaultExecutionMode,
        aggregatedCommitStatusEnabled: true,
        sendPassingStatusesForUntriggeredSpeculativePlans: false,
      };
      await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        await t.insert(organizations).values(org);
        await t.insert(organizationMemberships).values({
          id: crypto.randomUUID(), userId: user.id, orgId: id, role: "owner",
        });
      });
      await auditLog("create", "organizations", id, user.id, id, { name });
      (set as { status: number }).status = 201;
      return { data: await organizationResourceForPrincipal(org, user.id, tokenOrgId, tokenTeamId) };
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  })
  .get("/api/v2/organizations", async ({ user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    if ((user === null || user === undefined) && (orgId === null || orgId === undefined)) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const { number, size } = pageRequest(request);
    const urlParams = new URL(request.url).searchParams;
    const search = (urlParams.get("q[name]") ?? urlParams.get("q") ?? "").trim();
    let organizationIds = orgId !== null && orgId !== undefined
      ? [orgId]
      : user !== null && user !== undefined
        ? [...new Set((await db.query.organizationMemberships.findMany({
            where: and(
              eq(organizationMemberships.userId, user.id),
              eq(organizationMemberships.status, "active"),
            ),
          })).map((membership: Readonly<{ readonly orgId: string }>): string => membership.orgId))]
        : [];
    // Fine-grained token: intersect with declared org scope.
    const scopes = currentTokenScopes();
    if (scopes !== null && scopes.orgs.length > 0) {
      const scopeSet = new Set(scopes.orgs);
      organizationIds = organizationIds.filter((id): boolean => scopeSet.has(id));
    }
    if (organizationIds.length === 0) {
      return { data: [], ...pagination(request, number, size, 0) };
    }
    const scope = inArray(organizations.id, organizationIds);
    const where = search !== "" ? and(scope, like(organizations.name, `%${search}%`)) : scope;
    const [orgs, countRows] = await Promise.all([
      db.query.organizations.findMany({ where, orderBy: [asc(organizations.name)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(organizations).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: orgs.map((o: Readonly<typeof organizations.$inferSelect>): Record<string, unknown> => organizationResource(o)), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organizations/:org_name/reserved-tag-keys", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId, null, "settings:read"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const [tags, countRows] = await Promise.all([
      db.query.reservedTagKeys.findMany({
        where: eq(reservedTagKeys.orgId, org.id),
        orderBy: [asc(reservedTagKeys.key)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(reservedTagKeys).where(eq(reservedTagKeys.orgId, org.id)),
    ]);
    return {
      data: await Promise.all(tags.map(async (tag: ReservedTagKey): Promise<Record<string, unknown>> => reservedTagKeyResource(tag))),
      ...pagination(request, number, size, countRows[0]?.total ?? 0),
    };
  })
  .post("/api/v2/organizations/:org_name/reserved-tag-keys", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const input = reservedTagKeyInput(body);
    if ("error" in input) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] };
    }
    const now = Date.now();
    const tag = {
      id: `rtk-${crypto.randomUUID()}`,
      orgId: org.id,
      key: input.key,
      disableOverrides: input.disableOverrides,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof reservedTagKeys.$inferInsert;
    try {
      await db.insert(reservedTagKeys).values(tag);
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Reserved tag key already exists" }] };
      }
      throw error;
    }
    (set as { status: number }).status = 201;
    return { data: await reservedTagKeyResource(tag) };
  })
  .patch("/api/v2/reserved-tags/:reserved_tag_key_id", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const tagId = params.reserved_tag_key_id ?? "";
    const tag = await db.query.reservedTagKeys.findFirst({ where: eq(reservedTagKeys.id, tagId) });
    if (tag === undefined || !(await checkOrgPermission(user?.id, tag.orgId, "owner", orgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const input = reservedTagKeyInput(body);
    if ("error" in input) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: input.error }] };
    }
    const updated = { ...tag, key: input.key, disableOverrides: input.disableOverrides, updatedAt: Date.now() };
    try {
      await db.update(reservedTagKeys).set({
        key: updated.key,
        disableOverrides: updated.disableOverrides,
        updatedAt: updated.updatedAt,
      }).where(eq(reservedTagKeys.id, tag.id));
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Reserved tag key already exists" }] };
      }
      throw error;
    }
    return { data: await reservedTagKeyResource(updated) };
  })
  .delete("/api/v2/reserved-tags/:reserved_tag_key_id", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const tagId = params.reserved_tag_key_id ?? "";
    const tag = await db.query.reservedTagKeys.findFirst({ where: eq(reservedTagKeys.id, tagId) });
    if (tag === undefined || !(await checkOrgPermission(user?.id, tag.orgId, "owner", orgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(reservedTagKeys).where(eq(reservedTagKeys.id, tag.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/organizations/:org_name", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId ?? null, teamId ?? null, "settings:read"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: await organizationResourceForPrincipal(org, user?.id, orgId, teamId) };
  })
  .get("/api/v2/organizations/:org_name/entitlement-set", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId, null, "settings:read"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: org.id, type: "entitlement-sets",
        attributes: {
          operations: true, "state-storage": true, teams: true, "vcs-integrations": false,
          "policy-enforcement": false, "cost-estimation": false, "private-module-registry": false,
          agents: false, sso: false, "run-tasks": true, "global-run-tasks": true, "audit-logging": false,
          "self-serve-billing": false, "user-limit": null,
        },
        links: { self: `/api/v2/entitlement-sets/${org.id}` },
      },
    };
  })
  .get("/api/v2/organizations/:org_name/relationships/data-retention-policy", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId, null, "settings:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const policy = await db.query.organizationDataRetentionPolicies.findFirst({
      where: eq(organizationDataRetentionPolicies.organizationId, org.id),
    });
    if (policy === undefined) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: policy.id,
        type: policy.deleteOlderThanNDays === null ? "data-retention-policy-dont-deletes" : "data-retention-policy-delete-olders",
        attributes: {
          "state-versions-count": policy.stateVersionsCount,
          "delete-older-than-n-days": policy.deleteOlderThanNDays,
        },
      },
    };
  })
  .post("/api/v2/organizations/:org_name/relationships/data-retention-policy", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null
      ? data.attributes as Record<string, unknown>
      : {};
    const policyType = typeof data?.type === "string" ? data.type : null;
    const rawDeleteOlderThanNDays = attributes["delete-older-than-n-days"] ?? attributes.deleteOlderThanNDays;
    if (
      policyType === "data-retention-policy-delete-olders"
      && !(typeof rawDeleteOlderThanNDays === "number" && Number.isInteger(rawDeleteOlderThanNDays) && rawDeleteOlderThanNDays > 0)
    ) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const existing = await db.query.organizationDataRetentionPolicies.findFirst({
      where: eq(organizationDataRetentionPolicies.organizationId, org.id),
    });
    const stateVersionsCount = typeof attributes["state-versions-count"] === "number"
      ? attributes["state-versions-count"]
      : existing?.stateVersionsCount ?? null;
    const deleteOlderThanNDays = policyType === "data-retention-policy-dont-deletes"
      ? null
      : typeof rawDeleteOlderThanNDays === "number"
        ? rawDeleteOlderThanNDays
        : existing?.deleteOlderThanNDays ?? null;
    const values = {
      id: existing?.id ?? `drp-${crypto.randomUUID()}`,
      organizationId: org.id,
      stateVersionsCount,
      deleteOlderThanNDays,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    if (existing === undefined) {
      await db.insert(organizationDataRetentionPolicies).values(values);
    } else {
      await db.update(organizationDataRetentionPolicies).set(values).where(eq(organizationDataRetentionPolicies.id, existing.id));
    }
    const organizationWorkspaces = await db.query.workspaces.findMany({
      where: eq(workspaces.orgId, org.id),
      columns: { id: true },
    });
    const gc: Record<string, unknown> = {};
    for (const workspace of organizationWorkspaces) {
      gc[workspace.id] = await applyDataRetentionGarbageCollection(workspace.id);
    }
    (set as { status: number }).status = 201;
    return {
      data: {
        id: values.id,
        type: deleteOlderThanNDays === null ? "data-retention-policy-dont-deletes" : "data-retention-policy-delete-olders",
        attributes: {
          "state-versions-count": stateVersionsCount,
          "delete-older-than-n-days": deleteOlderThanNDays,
        },
        meta: { gc },
      },
    };
  })
  .delete("/api/v2/organizations/:org_name/relationships/data-retention-policy", async ({ params, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(organizationDataRetentionPolicies).where(eq(organizationDataRetentionPolicies.organizationId, org.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .patch("/api/v2/organizations/:org_name", async ({ params, body, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const newName = attributes.name === undefined ? org.name : (typeof attributes.name === "string" ? attributes.name.trim() : "");
    const defaultIacBinary = typeof attributes["default-iac-binary"] === "string" ? attributes["default-iac-binary"] : (org.defaultIacBinary ?? "tofu");
    const defaultTerraformVersion = typeof attributes["default-terraform-version"] === "string" ? attributes["default-terraform-version"] : (org.defaultTerraformVersion ?? "latest");
    const assessmentsEnforced = attributes["assessments-enforced"] === undefined
      ? org.assessmentsEnforced
      : attributes["assessments-enforced"] === true;
    const ownersTeamSamlRoleId = attributes["owners-team-saml-role-id"] === undefined
      ? org.ownersTeamSamlRoleId
      : typeof attributes["owners-team-saml-role-id"] === "string"
        ? attributes["owners-team-saml-role-id"].trim()
        : attributes["owners-team-saml-role-id"] === null
          ? null
          : undefined;
    const email = attributes.email === undefined
      ? org.email
      : typeof attributes.email === "string"
        ? attributes.email.trim() === "" ? null : attributes.email.trim()
        : attributes.email === null
          ? null
          : undefined;
    const allowForceDeleteWorkspaces = attributes["allow-force-delete-workspaces"] === undefined
      ? org.allowForceDeleteWorkspaces
      : attributes["allow-force-delete-workspaces"] === true;
    const stacksEnabled = attributes["stacks-enabled"] === undefined
      ? org.stacksEnabled
      : attributes["stacks-enabled"] === true;
    const showPreReleases = attributes["show-pre-releases"] === undefined
      ? org.showPreReleases
      : attributes["show-pre-releases"] === true;
    const aggregatedCommitStatusEnabled = attributes["aggregated-commit-status-enabled"] === undefined
      ? org.aggregatedCommitStatusEnabled
      : attributes["aggregated-commit-status-enabled"] === true;
    const sendPassingStatusesForUntriggeredSpeculativePlans = attributes["send-passing-statuses-for-untriggered-speculative-plans"] === undefined
      ? org.sendPassingStatusesForUntriggeredSpeculativePlans
      : attributes["send-passing-statuses-for-untriggered-speculative-plans"] === true;
    const defaultExecutionMode = attributes["default-execution-mode"] === undefined
      ? org.defaultExecutionMode
      : typeof attributes["default-execution-mode"] === "string"
        ? attributes["default-execution-mode"]
        : undefined;
    if (newName === "" || !["tofu", "terraform"].includes(defaultIacBinary) || defaultTerraformVersion.trim() === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    if (email === undefined || defaultExecutionMode === undefined || (defaultExecutionMode !== "remote" && defaultExecutionMode !== "local" && defaultExecutionMode !== "agent")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid organization settings" }] };
    }
    const nameError = organizationNameError(newName);
    if (nameError !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: nameError }] };
    }
    if (ownersTeamSamlRoleId === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "owners-team-saml-role-id must be a string or null" }] };
    }
    if (ownersTeamSamlRoleId !== null && ownersTeamSamlRoleId !== "") {
      const conflictingTeam = await db.query.teams.findFirst({
        where: and(eq(teams.orgId, org.id), eq(teams.name, ownersTeamSamlRoleId)),
      });
      if (conflictingTeam !== undefined && conflictingTeam.name !== "owners") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "owners-team-saml-role-id conflicts with an existing team name" }] };
      }
    }
    try {
      const updated = {
        ...org,
        name: newName,
        email,
        defaultIacBinary,
        defaultTerraformVersion: defaultTerraformVersion.trim(),
        assessmentsEnforced,
        ownersTeamSamlRoleId: ownersTeamSamlRoleId === "" ? null : ownersTeamSamlRoleId,
        allowForceDeleteWorkspaces,
        stacksEnabled,
        showPreReleases,
        defaultExecutionMode: defaultExecutionMode as string,
        aggregatedCommitStatusEnabled,
        sendPassingStatusesForUntriggeredSpeculativePlans,
      };
      await db.update(organizations).set({
        name: updated.name,
        email: updated.email,
        defaultIacBinary: updated.defaultIacBinary,
        defaultTerraformVersion: updated.defaultTerraformVersion,
        assessmentsEnforced: updated.assessmentsEnforced,
        ownersTeamSamlRoleId: updated.ownersTeamSamlRoleId,
        allowForceDeleteWorkspaces: updated.allowForceDeleteWorkspaces,
        stacksEnabled: updated.stacksEnabled,
        showPreReleases: updated.showPreReleases,
        defaultExecutionMode: updated.defaultExecutionMode,
        aggregatedCommitStatusEnabled: updated.aggregatedCommitStatusEnabled,
        sendPassingStatusesForUntriggeredSpeculativePlans: updated.sendPassingStatusesForUntriggeredSpeculativePlans,
      }).where(eq(organizations.id, org.id));
      // The cached org name would otherwise stay stale for the TTL window.
      invalidateOrganizationName(org.id);
      return { data: await organizationResourceForPrincipal(updated, user?.id, orgId, teamId) };
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  })
  .delete("/api/v2/organizations/:org_name", async ({ params, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const organizationWorkspaces = await db.query.workspaces.findMany({
      where: eq(workspaces.orgId, org.id),
      columns: { id: true },
    });
    for (const workspace of organizationWorkspaces) {
      await deleteWorkspaceData(workspace.id);
    }
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      const orgWsList = await t.query.workspaces.findMany({ where: eq(workspaces.orgId, org.id) });
      const wsIds = orgWsList.map((w: Readonly<{ readonly id: string }>): string => w.id);
      if (wsIds.length > 0) {
        const orgRuns = await t.query.runs.findMany({ where: inArray(runs.workspaceId, wsIds) });
        const runIds = orgRuns.map((r: Readonly<{ readonly id: string }>): string => r.id);
        if (runIds.length > 0) {
          await t.delete(logs).where(inArray(logs.runId, runIds));
          await t.delete(runs).where(inArray(runs.workspaceId, wsIds));
        }
        await t.delete(configurationVersions).where(inArray(configurationVersions.workspaceId, wsIds));
        await t.delete(stateVersions).where(inArray(stateVersions.workspaceId, wsIds));
        await t.delete(workspaceVariables).where(inArray(workspaceVariables.workspaceId, wsIds));
        await t.delete(workspaceTags).where(inArray(workspaceTags.workspaceId, wsIds));
        await t.delete(workspaces).where(eq(workspaces.orgId, org.id));
      }
      await t.delete(organizationMemberships).where(eq(organizationMemberships.orgId, org.id));
      await t.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
      await t.delete(organizations).where(eq(organizations.id, org.id));
    });
    invalidateOrganizationName(org.id);
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/organizations/:org_name/tags", async ({ params, user, request, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const wsList = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, org.id), columns: { id: true } });
    const wsIds = wsList.map((w) => w.id);
    if (wsIds.length === 0) return { data: [] };

    const tags = await db.query.workspaceTags.findMany({ where: inArray(workspaceTags.workspaceId, wsIds) });
    const tagCounts = new Map<string, number>();
    for (const t of tags) {
      tagCounts.set(t.key, (tagCounts.get(t.key) ?? 0) + 1);
    }

    const query = new URL(request.url).searchParams.get("q")?.toLocaleLowerCase() ?? "";
    let items = [...tagCounts.entries()].map(([name, countVal]): { id: string; type: string; attributes: { name: string; "created-at": string; "instance-count": number }; relationships: { organization: { data: { id: string; type: string } } } } => ({
      id: `tag-${org.name}-${name}`,
      type: "tags",
      attributes: {
        name,
        "created-at": new Date().toISOString(),
        "instance-count": countVal,
      },
      relationships: {
        organization: { data: { id: org.name, type: "organizations" } },
      },
    }));

    if (query !== "") {
      items = items.filter((i) => i.attributes.name.toLocaleLowerCase().includes(query));
    }

    const { number, size } = pageRequest(request);
    const total = items.length;
    const paginated = items.slice((number - 1) * size, number * size);
    return { data: paginated, ...pagination(request, number, size, total) };
  })
  .delete("/api/v2/organizations/:org_name/tags", async ({ params, user, body, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const dataList = Array.isArray(payload.data) ? payload.data : [];
    const tagIds = dataList.map((item) => (item as Record<string, unknown>)?.id).filter((id): id is string => typeof id === "string");

    if (tagIds.length > 0) {
      const wsList = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, org.id), columns: { id: true } });
      const wsIds = wsList.map((w) => w.id);
      if (wsIds.length > 0) {
        const prefix = `tag-${org.name}-`;
        const tagKeys = tagIds.map((id) => id.startsWith(prefix) ? id.slice(prefix.length) : id);
        await db.delete(workspaceTags).where(and(inArray(workspaceTags.workspaceId, wsIds), inArray(workspaceTags.key, tagKeys)));
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/organizations/:org_name/vcs-events", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId, null, "settings:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    return { data: [], ...pagination(request, number, size, 0) };
  });
