import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, organizationMemberships, apiTokens, workspaces, configurationVersions, stateVersions, workspaceVariables, workspaceTags, logs, runs, type users } from "../db/schema";
import { eq, and, asc, like, count, inArray } from "drizzle-orm";
import { organizationResource } from "../lib/response";
import { checkOrgPermission, pageRequest, pagination } from "../lib/utils";
import { isUniqueConstraintError } from "../lib/validation";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

export const organizationRoutes = new Elysia({ name: "organizations" })
  .use(authPlugin)
  .post("/api/v2/organizations", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const defaultIacBinary = typeof attributes["default-iac-binary"] === "string" ? attributes["default-iac-binary"] : "tofu";
    const defaultTerraformVersion = typeof attributes["default-terraform-version"] === "string" ? attributes["default-terraform-version"].trim() : "latest";
    if (name === "") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
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
      const org = { id, name, defaultIacBinary, defaultTerraformVersion };
      await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        await t.insert(organizations).values(org);
        await t.insert(organizationMemberships).values({
          id: crypto.randomUUID(), userId: user.id, orgId: id, role: "owner",
        });
      });
      (set as { status: number }).status = 201;
      return { data: organizationResource(org) };
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  })
  .get("/api/v2/organizations", async ({ user, orgId, request }: ParamCtx): Promise<unknown> => {
    const { number, size } = pageRequest(request);
    const urlParams = new URL(request.url).searchParams;
    const search = (urlParams.get("q[name]") ?? urlParams.get("q") ?? "").trim();
    const organizationIds = orgId !== null && orgId !== undefined
      ? [orgId]
      : user !== null && user !== undefined
        ? [...new Set((await db.query.organizationMemberships.findMany({
            where: eq(organizationMemberships.userId, user.id),
          })).map((membership: Readonly<{ readonly orgId: string }>): string => membership.orgId))]
        : [];
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
  .get("/api/v2/organizations/:org_name", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: organizationResource(org) };
  })
  .get("/api/v2/organizations/:org_name/entitlement-set", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: org.id, type: "entitlement-sets",
        attributes: {
          operations: true, "state-storage": true, teams: true, "vcs-integrations": false,
          "policy-enforcement": false, "cost-estimation": false, "private-module-registry": false,
          agents: false, sso: false, "run-tasks": false, "audit-logging": false,
          "self-serve-billing": false, "user-limit": null,
        },
        links: { self: `/api/v2/entitlement-sets/${org.id}` },
      },
    };
  })
  .patch("/api/v2/organizations/:org_name", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const newName = attributes.name === undefined ? org.name : (typeof attributes.name === "string" ? attributes.name.trim() : "");
    const defaultIacBinary = typeof attributes["default-iac-binary"] === "string" ? attributes["default-iac-binary"] : (org.defaultIacBinary ?? "tofu");
    const defaultTerraformVersion = typeof attributes["default-terraform-version"] === "string" ? attributes["default-terraform-version"] : (org.defaultTerraformVersion ?? "latest");
    if (newName === "" || !["tofu", "terraform"].includes(defaultIacBinary) || defaultTerraformVersion.trim() === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    try {
      const updated = { ...org, name: newName, defaultIacBinary, defaultTerraformVersion: defaultTerraformVersion.trim() };
      await db.update(organizations).set({ name: updated.name, defaultIacBinary: updated.defaultIacBinary, defaultTerraformVersion: updated.defaultTerraformVersion }).where(eq(organizations.id, org.id));
      return { data: organizationResource(updated) };
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  })
  .delete("/api/v2/organizations/:org_name", async ({ params, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
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
    (set as { status: number }).status = 204;
    return {};
  });
