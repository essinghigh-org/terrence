import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, organizationMemberships, users, apiTokens, workspaces, configurationVersions, stateVersions, workspaceVariables, workspaceTags, logs, runs, variableSets } from "../db/schema";
import { eq, and, asc, like, count, inArray } from "drizzle-orm";
import { organizationResource } from "../lib/response";
import { checkOrgPermission, pageRequest, pagination } from "../lib/utils";
import { authPlugin } from "../auth";

export const organizationRoutes = new Elysia({ name: "organizations" })
  .use(authPlugin)
  .post("/api/v2/organizations", async ({ user, body, set }) => {
    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const defaultIacBinary = attributes["default-iac-binary"] ?? "tofu";
    const defaultTerraformVersion = attributes["default-terraform-version"] ?? "latest";
    if (!name) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }
    if (!user) {
      set.status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    if (!["tofu", "terraform"].includes(defaultIacBinary) || typeof defaultTerraformVersion !== "string" || !defaultTerraformVersion.trim()) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    try {
        const id = crypto.randomUUID();
        const org = { id, name, defaultIacBinary, defaultTerraformVersion: defaultTerraformVersion.trim() };
        await db.transaction(async tx => {
          await tx.insert(organizations).values(org);
          await tx.insert(organizationMemberships).values({
            id: crypto.randomUUID(), userId: user.id, orgId: id, role: "owner",
          });
        });
        set.status = 201;
        return { data: organizationResource(org) };
    } catch (e: any) {
        if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
            set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
        }
        throw e;
    }
  })
  .get("/api/v2/organizations", async ({ user, orgId, request }) => {
    const { number, size } = pageRequest(request);
    const params = new URL(request.url).searchParams;
    const search = (params.get("q[name]") ?? params.get("q") ?? "").trim();
    const organizationIds = orgId
      ? [orgId]
      : user
        ? [...new Set((await db.query.organizationMemberships.findMany({
            where: eq(organizationMemberships.userId, user.id),
          })).map(membership => membership.orgId))]
        : [];
    if (organizationIds.length === 0) {
      return { data: [], ...pagination(request, number, size, 0) };
    }
    const scope = inArray(organizations.id, organizationIds);
    const where = search ? and(scope, like(organizations.name, `%${search}%`)) : scope;
    const [orgs, [{ total }]] = await Promise.all([
      db.query.organizations.findMany({ where, orderBy: [asc(organizations.name)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(organizations).where(where),
    ]);
    return { data: orgs.map(organizationResource), ...pagination(request, number, size, total) };
  })
  .get("/api/v2/organizations/:org_name", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
        set.status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: organizationResource(org) };
  })
  .get("/api/v2/organizations/:org_name/entitlement-set", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404;
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
  .patch("/api/v2/organizations/:org_name", async ({ params: { org_name }, body, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const newName = attributes.name === undefined ? org.name : typeof attributes.name === "string" ? attributes.name.trim() : "";
    const defaultIacBinary = attributes["default-iac-binary"] ?? org.defaultIacBinary ?? "tofu";
    const defaultTerraformVersion = attributes["default-terraform-version"] ?? org.defaultTerraformVersion ?? "latest";
    if (!newName || !["tofu", "terraform"].includes(defaultIacBinary) || typeof defaultTerraformVersion !== "string" || !defaultTerraformVersion.trim()) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    try {
      const updated = { ...org, name: newName, defaultIacBinary, defaultTerraformVersion: defaultTerraformVersion.trim() };
      await db.update(organizations).set({ name: updated.name, defaultIacBinary: updated.defaultIacBinary, defaultTerraformVersion: updated.defaultTerraformVersion }).where(eq(organizations.id, org.id));
      return { data: organizationResource(updated) };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
        set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  })
  .delete("/api/v2/organizations/:org_name", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.transaction(async (tx) => {
      const orgWsList = await tx.query.workspaces.findMany({ where: eq(workspaces.orgId, org.id) });
      const wsIds = orgWsList.map(w => w.id);
      if (wsIds.length > 0) {
        const orgRuns = await tx.query.runs.findMany({ where: inArray(runs.workspaceId, wsIds) });
        const runIds = orgRuns.map(r => r.id);
        if (runIds.length > 0) {
          await tx.delete(logs).where(inArray(logs.runId, runIds));
          await tx.delete(runs).where(inArray(runs.workspaceId, wsIds));
        }
        await tx.delete(configurationVersions).where(inArray(configurationVersions.workspaceId, wsIds));
        await tx.delete(stateVersions).where(inArray(stateVersions.workspaceId, wsIds));
        await tx.delete(workspaceVariables).where(inArray(workspaceVariables.workspaceId, wsIds));
        await tx.delete(workspaceTags).where(inArray(workspaceTags.workspaceId, wsIds));
        await tx.delete(workspaces).where(eq(workspaces.orgId, org.id));
      }
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.orgId, org.id));
      await tx.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
      await tx.delete(organizations).where(eq(organizations.id, org.id));
    });
    set.status = 204;
    return;
  });
