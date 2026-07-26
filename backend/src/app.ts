import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit } from "elysia-rate-limit";
import { db } from "./db";
import { users, apiTokens, organizations, workspaces, organizationMemberships, runs, logs, stateVersions, workspaceVariables, workspaceTags, configurationVersions } from "./db/schema";
import { eq, desc, asc, inArray } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { authPlugin } from "./auth";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { validateVersion } from "./binaryManager";
import { startWorkerQueue, executeRun, executeApply } from "./worker";

// Initialize persistent worker queue loop
startWorkerQueue();

const CV_STORAGE_DIR = join(import.meta.dir, "../storage/cv");

async function checkOrgPermission(userId: string | undefined, orgId: string, requiredRole: "owner" | "member" = "member"): Promise<boolean> {
  if (!userId) return false;
  const membership = await db.query.organizationMemberships.findFirst({
    where: (m, { and, eq }) => and(eq(m.userId, userId), eq(m.orgId, orgId)),
  });
  if (!membership) return false;
  if (requiredRole === "owner" && membership.role !== "owner") return false;
  return true;
}

async function findWorkspaceVar(workspaceId: string, varId: string) {
  return db.query.workspaceVariables.findFirst({
    where: (vars, { and, eq }) => and(eq(vars.id, varId), eq(vars.workspaceId, workspaceId)),
  });
}

export const app = new Elysia()
  .use(authPlugin)
  .use(rateLimit({ max: 1000, duration: 60000 }))
  .onParse(async ({ request, contentType }) => {
    if (contentType === 'application/vnd.api+json') {
      const text = await request.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
  })
  .use(staticPlugin({
    assets: "../frontend/dist",
    prefix: ""
  }))
  .onError(({ code, error, set }) => {
    set.headers["Content-Type"] = "application/vnd.api+json";
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    set.status = 500;
    return {
      errors: [{
        status: "500",
        title: "Internal Server Error",
        detail: error.message || "An unexpected error occurred"
      }]
    };
  })
  .get("/.well-known/terraform.json", () => ({
    "tfe.v2.1": "/api/v2/",
    "tfe.v2.2": "/api/v2/",
    "state.v2": "/api/v2/",
  }))
  .get("/api", () => "Terrence API")
  .post("/api/v2/users/login", async ({ body, set }) => {
    let payload;
    if (typeof body === 'string') {
        try {
            payload = JSON.parse(body);
        } catch (e) {
            set.status = 400;
            return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON string" }] };
        }
    } else {
        payload = body;
    }

    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing credentials" }] };
    }

    const user = await db.query.users.findFirst({
      where: eq(users.username, username)
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
    }

    const tokenStr = `user-${crypto.randomUUID()}`;
    const tokenId = crypto.randomUUID();

    await db.insert(apiTokens).values({
      id: tokenId,
      token: tokenStr,
      userId: user.id,
      description: "User login token"
    });

    return {
      data: {
        id: tokenId,
        type: "tokens",
        attributes: {
          token: tokenStr
        }
      }
    };
  })
  .post("/api/v2/users", async ({ body, set }) => {
    const payload = body as any;
    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.username, username)
    });
    if (existing) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();

    try {
      await db.insert(users).values({ id, username, passwordHash });
      set.status = 201;
      return {
        data: {
          id,
          type: "users",
          attributes: { username }
        }
      };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
        set.status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
      }
      throw e;
    }
  })
  .post("/api/v2/tokens", async ({ body, user, set }) => {
    if (!user) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    const payload = body as any;
    const descAttr = payload?.data?.attributes?.description || "API token";
    const orgId = payload?.data?.relationships?.organization?.data?.id;

    if (orgId) {
      if (!(await checkOrgPermission(user.id, orgId, "owner"))) {
        set.status = 403;
        return { errors: [{ status: "403", title: "Forbidden" }] };
      }
    }

    const tokenStr = `user-${crypto.randomUUID()}`;
    const tokenId = crypto.randomUUID();

    await db.insert(apiTokens).values({
      id: tokenId,
      token: tokenStr,
      userId: user.id,
      orgId: orgId || null,
      description: descAttr
    });

    set.status = 201;
    return {
      data: {
        id: tokenId,
        type: "tokens",
        attributes: {
          token: tokenStr
        }
      }
    };
  }, { isAuth: true })
  .post("/api/v2/organizations", async ({ user, body, set }) => {
    const payload = body as any;
    const { name } = payload?.data?.attributes || {};

    if (!name) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }

    try {
        const id = crypto.randomUUID();
        await db.insert(organizations).values({ id, name });

        if (user?.id) {
          await db.insert(organizationMemberships).values({
            id: crypto.randomUUID(),
            userId: user.id,
            orgId: id,
            role: "owner",
          });
        }

        set.status = 201;
        return {
            data: {
                id,
                type: "organizations",
                attributes: { name }
            }
        };
    } catch (e: any) {
        if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
            set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
        }
        throw e;
    }
  }, { isAuth: true })
  .get("/api/v2/organizations", async ({ user }) => {
    const orgs = await db.query.organizations.findMany();
    return {
        data: orgs.map(org => ({
            id: org.id,
            type: "organizations",
            attributes: { name: org.name }
        }))
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name", async ({ params: { org_name }, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });

    if (!org) {
        set.status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return {
        data: {
            id: org.id,
            type: "organizations",
            attributes: { name: org.name }
        }
    };
  }, { isAuth: true })
  .patch("/api/v2/organizations/:org_name", async ({ params: { org_name }, body, user, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, org.id, "owner"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const payload = body as any;
    const { name } = payload?.data?.attributes || {};
    const newName = name || org.name;

    try {
      await db.update(organizations).set({ name: newName }).where(eq(organizations.id, org.id));
      return {
          data: {
              id: org.id,
              type: "organizations",
              attributes: { name: newName }
          }
      };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
        set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name", async ({ params: { org_name }, user, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, org.id, "owner"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
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
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const orgWorkspaces = await db.query.workspaces.findMany({
        where: eq(workspaces.orgId, org.id)
    });

    return {
        data: orgWorkspaces.map(ws => ({
            id: ws.id,
            type: "workspaces",
            attributes: {
                name: ws.name,
                "auto-apply": ws.autoApply,
                "terraform-version": ws.terraformVersion,
                "iac-binary": ws.iacBinary,
                "execution-mode": ws.iacBinary || org.defaultIacBinary || "tofu",
                locked: ws.locked
            },
            relationships: {
                organization: {
                    data: { id: org.id, type: "organizations" }
                }
            }
        }))
    };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, body, user, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, org.id, "member"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const payload = body as any;
    const { name, "auto-apply": autoApply, "terraform-version": terraformVersion, "iac-binary": iacBinary, "execution-mode": executionMode } = payload?.data?.attributes || {};

    if (!name) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }

    if (terraformVersion && terraformVersion !== "latest" && !validateVersion(terraformVersion)) {
        set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
    }

    try {
        const id = crypto.randomUUID();
        const chosenTool = iacBinary || executionMode || null;
        await db.insert(workspaces).values({
            id,
            name,
            orgId: org.id,
            autoApply: autoApply ?? false,
            terraformVersion: terraformVersion ?? "latest",
            iacBinary: chosenTool
        });

        set.status = 201;
        return {
            data: {
                id,
                type: "workspaces",
                attributes: {
                    name,
                    "auto-apply": autoApply ?? false,
                    "terraform-version": terraformVersion ?? "latest",
                    "iac-binary": chosenTool,
                    "execution-mode": chosenTool || org.defaultIacBinary || "tofu",
                    locked: false
                },
                relationships: {
                    organization: {
                        data: { id: org.id, type: "organizations" }
                    }
                }
            }
        };
    } catch (e: any) {
        if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
            set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
        }
        throw e;
    }
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const workspace = await db.query.workspaces.findFirst({
        where: (ws, { and, eq }) => and(eq(ws.name, workspace_name), eq(ws.orgId, org.id))
    });

    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return {
        data: {
            id: workspace.id,
            type: "workspaces",
            attributes: {
                name: workspace.name,
                "auto-apply": workspace.autoApply,
                "terraform-version": workspace.terraformVersion,
                "iac-binary": workspace.iacBinary,
                "execution-mode": workspace.iacBinary || org.defaultIacBinary || "tofu",
                locked: workspace.locked
            },
            relationships: {
                organization: {
                    data: { id: org.id, type: "organizations" }
                }
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });

    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, workspace.orgId)
    });

    return {
        data: {
            id: workspace.id,
            type: "workspaces",
            attributes: {
                name: workspace.name,
                "auto-apply": workspace.autoApply,
                "terraform-version": workspace.terraformVersion,
                "iac-binary": workspace.iacBinary,
                "execution-mode": workspace.iacBinary || org?.defaultIacBinary || "tofu",
                locked: workspace.locked
            },
            relationships: {
                organization: {
                    data: { id: workspace.orgId, type: "organizations" }
                }
            }
        }
    };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, body, user, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    if (user?.id && !(await checkOrgPermission(user.id, workspace.orgId, "member"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, workspace.orgId)
    });

    const payload = body as any;
    const { name, "auto-apply": autoApply, "terraform-version": terraformVersion, "iac-binary": iacBinary, "execution-mode": executionMode } = payload?.data?.attributes || {};
    const chosenTool = iacBinary !== undefined ? iacBinary : executionMode !== undefined ? executionMode : workspace.iacBinary;

    if (terraformVersion !== undefined && terraformVersion !== "latest" && !validateVersion(terraformVersion)) {
        set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
    }

    const updated = {
        name: name !== undefined ? name : workspace.name,
        autoApply: autoApply !== undefined ? autoApply : workspace.autoApply,
        terraformVersion: terraformVersion !== undefined ? terraformVersion : workspace.terraformVersion,
        iacBinary: chosenTool
    };

    await db.update(workspaces).set(updated).where(eq(workspaces.id, workspace_id));

    return {
        data: {
            id: workspace.id,
            type: "workspaces",
            attributes: {
                name: updated.name,
                "auto-apply": updated.autoApply,
                "terraform-version": updated.terraformVersion,
                "iac-binary": updated.iacBinary,
                "execution-mode": updated.iacBinary || org?.defaultIacBinary || "tofu",
                locked: workspace.locked
            },
            relationships: {
                organization: {
                    data: { id: workspace.orgId, type: "organizations" }
                }
            }
        }
    };
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, user, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    if (user?.id && !(await checkOrgPermission(user.id, workspace.orgId, "owner"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    await db.transaction(async (tx) => {
      const wsRuns = await tx.query.runs.findMany({ where: eq(runs.workspaceId, workspace_id) });
      const runIds = wsRuns.map(r => r.id);
      if (runIds.length > 0) {
        await tx.delete(logs).where(inArray(logs.runId, runIds));
        await tx.delete(runs).where(eq(runs.workspaceId, workspace_id));
      }
      await tx.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspace_id));
      await tx.delete(stateVersions).where(eq(stateVersions.workspaceId, workspace_id));
      await tx.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspace_id));
      await tx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspace_id));
      await tx.delete(workspaces).where(eq(workspaces.id, workspace_id));
    });

    set.status = 204;
    return;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tags = await db.query.workspaceTags.findMany({
        where: eq(workspaceTags.workspaceId, workspace_id)
    });

    return {
        data: tags.map(t => ({
            id: t.id,
            type: "tags",
            attributes: { key: t.key }
        }))
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, body, user, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, workspace.orgId, "member"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const payload = body as any;
    const tagsData = payload?.data || [];
    const created = [];

    for (const tagItem of tagsData) {
      const key = tagItem?.attributes?.key || tagItem?.id;
      if (!key || typeof key !== "string" || !key.trim()) continue;
      const id = crypto.randomUUID();
      try {
        await db.insert(workspaceTags).values({ id, workspaceId: workspace_id, key: key.trim() });
        created.push({ id, type: "tags", attributes: { key: key.trim() } });
      } catch (err) {}
    }

    if (created.length === 0) {
      set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "No valid tags provided" }] };
    }

    set.status = 201;
    return { data: created };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, user, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, workspace.orgId, "member"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const vars = await db.query.workspaceVariables.findMany({
        where: eq(workspaceVariables.workspaceId, workspace_id)
    });

    return {
        data: vars.map(v => ({
            id: v.id,
            type: "vars",
            attributes: {
                key: v.key,
                value: v.sensitive ? null : v.value,
                category: v.category,
                sensitive: v.sensitive,
                description: v.description,
                hcl: false
            }
        }))
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, body, user, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, workspace.orgId, "member"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const payload = body as any;
    const { key, value, category, sensitive, description } = payload?.data?.attributes || {};

    if (!key || value === undefined) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Key and value are required" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(workspaceVariables).values({
        id,
        workspaceId: workspace_id,
        key,
        value: String(value),
        category: category || "terraform",
        sensitive: sensitive ?? false,
        description: description || null
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "vars",
            attributes: {
                key,
                value: sensitive ? null : String(value),
                category: category || "terraform",
                sensitive: sensitive ?? false,
                description: description || null,
                hcl: false
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, set }) => {
    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: v.id,
            type: "vars",
            attributes: {
                key: v.key,
                value: v.sensitive ? null : v.value,
                category: v.category,
                sensitive: v.sensitive,
                description: v.description,
                hcl: false
            }
        }
    };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, body, user, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, workspace.orgId, "member"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { key, value, category, sensitive, description } = payload?.data?.attributes || {};

    let newSensitive = sensitive !== undefined ? sensitive : v.sensitive;
    let newValue = value !== undefined ? String(value) : v.value;

    if (v.sensitive && !newSensitive && value === undefined) {
      newSensitive = true;
    }

    const updated = {
        key: key !== undefined ? key : v.key,
        value: newValue,
        category: category !== undefined ? category : v.category,
        sensitive: newSensitive,
        description: description !== undefined ? description : v.description,
    };

    await db.update(workspaceVariables).set(updated).where(eq(workspaceVariables.id, var_id));

    return {
        data: {
            id: v.id,
            type: "vars",
            attributes: {
                key: updated.key,
                value: updated.sensitive ? null : updated.value,
                category: updated.category,
                sensitive: updated.sensitive,
                description: updated.description,
                hcl: false
            }
        }
    };
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, user, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user?.id && !(await checkOrgPermission(user.id, workspace.orgId, "member"))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, var_id));
    set.status = 204;
    return;
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params: { workspace_id }, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(workspaces).set({ locked: true }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: true } } };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/unlock", async ({ params: { workspace_id }, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(workspaces).set({ locked: false }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: false } } };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, query, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const pageQuery = query as any;
    const pageNumber = Math.max(1, parseInt(pageQuery?.["page[number]"] || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(pageQuery?.["page[size]"] || "20", 10)));
    const offset = (pageNumber - 1) * pageSize;

    const list = await db.query.stateVersions.findMany({
        where: eq(stateVersions.workspaceId, workspace_id),
        orderBy: [desc(stateVersions.serial)],
        limit: pageSize,
        offset
    });

    return {
        data: list.map(s => ({
            id: s.id,
            type: "state-versions",
            attributes: {
                serial: s.serial
            }
        }))
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params: { workspace_id }, set }) => {
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, workspace_id),
        orderBy: [desc(stateVersions.serial)]
    });
    if (!state) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: state.id,
            type: "state-versions",
            attributes: {
                serial: state.serial,
                state: state.statePayload
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id", async ({ params: { state_version_id }, set }) => {
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.id, state_version_id)
    });
    if (!state) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: state.id,
            type: "state-versions",
            attributes: {
                serial: state.serial,
                state: state.statePayload
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params: { state_version_id }, user, set }) => {
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.id, state_version_id)
    });
    if (!state) {
        set.status = 404; return "Not Found";
    }

    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, state.workspaceId) });
    if (user?.id && workspace && !(await checkOrgPermission(user.id, workspace.orgId, "member"))) {
      set.status = 403; return "Forbidden";
    }

    set.headers["Content-Type"] = "application/json";
    return state.statePayload || "{}";
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, body, set }) => {
    const payload = body as any;
    const { serial, state } = payload?.data?.attributes || {};
    if (serial === undefined || !state) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    const id = crypto.randomUUID();
    await db.insert(stateVersions).values({
        id,
        workspaceId: workspace_id,
        serial,
        statePayload: typeof state === 'string' ? state : JSON.stringify(state)
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "state-versions",
            attributes: {
                serial,
                state: typeof state === 'string' ? state : JSON.stringify(state)
            }
        }
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, set }) => {
    const id = crypto.randomUUID();
    await db.insert(configurationVersions).values({
        id,
        workspaceId: workspace_id,
        status: "pending"
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "configuration-versions",
            attributes: {
                status: "pending",
                "upload-url": `/api/v2/configuration-versions/${id}/upload`
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/configuration-versions/:cv_id", async ({ params: { cv_id }, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: cv.id,
            type: "configuration-versions",
            attributes: {
                status: cv.status,
                "upload-url": `/api/v2/configuration-versions/${cv.id}/upload`
            }
        }
    };
  }, { isAuth: true })
  .put("/api/v2/configuration-versions/:cv_id/upload", async ({ params: { cv_id }, request, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    await mkdir(CV_STORAGE_DIR, { recursive: true });
    const archivePath = join(CV_STORAGE_DIR, `${cv_id}.tar.gz`);

    const buffer = await request.arrayBuffer();
    await writeFile(archivePath, Buffer.from(buffer));

    await db.update(configurationVersions).set({ status: "uploaded", archivePath }).where(eq(configurationVersions.id, cv_id));
    set.status = 200;
    return "Upload successful";
  }, { isAuth: true })
  .get("/api/v2/configuration-versions/:cv_id/download", async ({ params: { cv_id }, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv || !cv.archivePath) {
        set.status = 404; return "Not Found";
    }
    return Bun.file(cv.archivePath);
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/runs", async ({ params: { workspace_id }, query, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const pageQuery = query as any;
    const pageSize = Math.min(100, Math.max(1, parseInt(pageQuery?.["page[size]"] || "50", 10)));

    const workspaceRuns = await db.query.runs.findMany({
        where: eq(runs.workspaceId, workspace_id),
        orderBy: [desc(runs.createdAt)],
        limit: pageSize
    });
    return {
        data: workspaceRuns.map(r => ({
            id: r.id,
            type: "runs",
            attributes: {
                message: r.message,
                status: r.status,
                "is-destroy": r.isDestroy,
                "created-at": r.createdAt
            }
        }))
    };
  }, { isAuth: true })
  .post("/api/v2/runs", async ({ body, set }) => {
    const payload = body as any;
    const { message, "is-destroy": isDestroy } = payload?.data?.attributes || {};
    const workspaceId = payload?.data?.relationships?.workspace?.data?.id;
    const cvId = payload?.data?.relationships?.["configuration-version"]?.data?.id || payload?.data?.attributes?.["configuration-version-id"];

    if (!workspaceId) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] };
    }

    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId)
    });

    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();

    await db.insert(runs).values({
        id,
        workspaceId,
        configurationVersionId: cvId || null,
        message: message || "Queued manually",
        status: "pending",
        isDestroy: isDestroy || false,
        createdAt,
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "runs",
            attributes: {
                message: message || "Queued manually",
                status: "pending",
                "is-destroy": isDestroy || false,
                "created-at": createdAt
            },
            relationships: {
                workspace: {
                    data: { id: workspaceId, type: "workspaces" }
                }
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return {
        data: {
            id: run.id,
            type: "runs",
            attributes: {
                message: run.message,
                status: run.status,
                "is-destroy": run.isDestroy,
                "created-at": run.createdAt
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/plan", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: `plan-${run.id}`,
            type: "plans",
            attributes: {
                status: run.status === "planned" || run.status === "applying" || run.status === "applied" ? "finished" : run.status,
                "log-read-url": `/api/v2/runs/${run.id}/plan/log`
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/logs", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const runLogs = await db.query.logs.findMany({
        where: eq(logs.runId, run_id),
        orderBy: [asc(logs.createdAt)]
    });
    return {
        data: runLogs.map(l => ({
            id: l.id,
            type: "logs",
            attributes: {
                phase: l.phase,
                "output-text": l.outputText,
                "created-at": l.createdAt
            }
        }))
    };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/plan/log", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const planLogs = await db.query.logs.findMany({
        where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "plan")),
        orderBy: [asc(logs.createdAt)]
    });
    set.headers["Content-Type"] = "text/plain";
    return planLogs.map(l => l.outputText).join("\n");
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/apply/log", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const applyLogs = await db.query.logs.findMany({
        where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "apply")),
        orderBy: [asc(logs.createdAt)]
    });
    set.headers["Content-Type"] = "text/plain";
    return applyLogs.map(l => l.outputText).join("\n");
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    executeApply(run.id).catch(console.error);

    return {
        data: {
            id: run.id,
            type: "runs",
            attributes: { status: "applying" }
        }
    };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(runs).set({ status: "discarded" }).where(eq(runs.id, run_id));
    return { data: { id: run_id, type: "runs", attributes: { status: "discarded" } } };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params: { run_id }, set }) => {
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(runs).set({ status: "canceled" }).where(eq(runs.id, run_id));
    return { data: { id: run_id, type: "runs", attributes: { status: "canceled" } } };
  }, { isAuth: true });
