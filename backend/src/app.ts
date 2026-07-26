import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit } from "elysia-rate-limit";
import { db } from "./db";
import { users, apiTokens, organizations } from "./db/schema";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { authPlugin } from "./auth";

export const app = new Elysia()
  .use(authPlugin)
  .use(rateLimit({ max: 1000, duration: 60000 }))
  .onParse(async ({ request, contentType }) => {
    if (contentType === 'application/vnd.api+json') {
      const text = await request.text();
      try {
        return JSON.parse(text);
      } catch {
        return null; // Let the handler deal with invalid JSON
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
      return {
        errors: [{
          status: "404",
          title: "Not Found"
        }]
      };
    }

    // Default fallback
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
            return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON" }] };
        }
    } else {
        payload = body;
    }

    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
        set.status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    const user = await db.query.users.findFirst({
        where: eq(users.username, username)
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        set.status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid credentials" }] };
    }

    const tokenString = crypto.randomUUID() + "-" + crypto.randomUUID();
    const tokenId = crypto.randomUUID();

    await db.insert(apiTokens).values({
        id: tokenId,
        token: tokenString,
        userId: user.id,
        description: "Login token",
    });

    set.status = 201;
    return {
        data: {
            id: tokenId,
            type: "api-tokens",
            attributes: {
                token: tokenString,
            }
        }
    };
  })
  .get("/api/v2/account/details", async ({ user, set }) => {
    if (!user) {
        set.status = 401;
        return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    return {
        data: {
            id: user.id,
            type: "users",
            attributes: {
                username: user.username,
            }
        }
    };
  }, { isAuth: true })
  .post("/api/v2/tokens", async ({ body, set, user, orgId }) => {
    // Generate Team/Org Tokens (Simplification for MVP)
    const payload = body as any;

    const { description } = payload?.data?.attributes || {};
    const organizationId = payload?.data?.relationships?.organization?.data?.id;

    if (!organizationId) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "organization relationship missing" }] };
    }

    // Need to verify org exists
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId)
    });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    // In a real app we would check if the active `user` is an admin of this org here.
    // For MVP, if they are authenticated, let them create a token for the org.
    if (!user) {
       set.status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    const tokenString = crypto.randomUUID() + "-" + crypto.randomUUID();
    const tokenId = crypto.randomUUID();

    await db.insert(apiTokens).values({
        id: tokenId,
        token: tokenString,
        orgId: org.id,
        description: description || "Org token",
    });

    set.status = 201;
    return {
        data: {
            id: tokenId,
            type: "api-tokens",
            attributes: {
                token: tokenString,
            }
        }
    };
  }, { isAuth: true })
  .post("/api/v2/organizations", async ({ body, set, user }) => {
    const payload = body as any;

    const { name } = payload?.data?.attributes || {};

    if (!name) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }

    try {
        const id = crypto.randomUUID();
        await db.insert(organizations).values({ id, name });

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
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { workspaces } = await import("./db/schema");
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
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, body, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;

    const { name, "auto-apply": autoApply, "terraform-version": terraformVersion } = payload?.data?.attributes || {};

    if (!name) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }

    try {
        const id = crypto.randomUUID();
        // Dynamic import to avoid circular dependencies/use right schema if not imported
        const { workspaces } = await import("./db/schema");
        await db.insert(workspaces).values({
            id,
            name,
            orgId: org.id,
            autoApply: autoApply ?? false,
            terraformVersion: terraformVersion ?? "latest"
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

    const { workspaces } = await import("./db/schema");
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
    const { workspaces } = await import("./db/schema");
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
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
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, body, set }) => {
    const { workspaces, workspaceVariables } = await import("./db/schema");
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;

    const { key, value, category, sensitive, description, hcl } = payload?.data?.attributes || {};

    if (!key || value === undefined) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing key or value" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(workspaceVariables).values({
        id,
        workspaceId: workspace.id,
        key,
        value,
        category: category || "terraform",
        sensitive: sensitive || false,
        description
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "vars",
            attributes: {
                key,
                value: sensitive ? null : value,
                category: category || "terraform",
                sensitive: sensitive || false,
                hcl: hcl || false,
                description
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, set }) => {
    const { workspaces, workspaceVariables } = await import("./db/schema");
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const vars = await db.query.workspaceVariables.findMany({
        where: eq(workspaceVariables.workspaceId, workspace.id)
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
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params: { workspace_id }, set }) => {
    const { workspaces } = await import("./db/schema");
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
    const { workspaces } = await import("./db/schema");
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(workspaces).set({ locked: false }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: false } } };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params: { workspace_id }, set }) => {
    const { stateVersions } = await import("./db/schema");
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, workspace_id),
        orderBy: (states, { desc }) => [desc(states.serial)]
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
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, body, set }) => {
    const { workspaces, stateVersions } = await import("./db/schema");
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { serial, state } = payload?.data?.attributes || {};

    const id = crypto.randomUUID();
    await db.insert(stateVersions).values({
        id,
        workspaceId: workspace_id,
        serial: serial || 1,
        statePayload: state
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "state-versions",
            attributes: {
                serial: serial || 1
            }
        }
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, set }) => {
    const { workspaces, configurationVersions } = await import("./db/schema");
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(configurationVersions).values({
        id,
        workspaceId: workspace_id,
        status: "pending"
    });

    // Fire off worker task in background
    import("./worker").then(m => m.executeRun(id)).catch(console.error);

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
    const { configurationVersions } = await import("./db/schema");
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
                status: cv.status
            }
        }
    };
  }, { isAuth: true })
  .put("/api/v2/configuration-versions/:cv_id/upload", async ({ params: { cv_id }, set }) => {
    // In a real implementation this would stream the tar.gz to S3 or a local temp file.
    // For MVP, we will update the status to uploaded.
    const { configurationVersions } = await import("./db/schema");
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(configurationVersions).set({ status: "uploaded" }).where(eq(configurationVersions.id, cv_id));
    set.status = 200;
    return "Upload successful";
  }, { isAuth: true })
  .post("/api/v2/runs", async ({ body, set }) => {
    const payload = body as any;
    const { message } = payload?.data?.attributes || {};
    const workspaceId = payload?.data?.relationships?.workspace?.data?.id;

    if (!workspaceId) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] };
    }

    const { workspaces, runs } = await import("./db/schema");
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId)
    });

    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(runs).values({
        id,
        workspaceId,
        message: message || "Queued manually",
        status: "pending"
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "runs",
            attributes: {
                message: message || "Queued manually",
                status: "pending"
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
    const { runs } = await import("./db/schema");
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
                status: run.status
            }
        }
    };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params: { run_id }, set }) => {
    const { runs } = await import("./db/schema");
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    await db.update(runs).set({ status: "applying" }).where(eq(runs.id, run_id));
    set.status = 200;
    return { data: null }; // Typically empty response or run object
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params: { run_id }, set }) => {
    const { runs } = await import("./db/schema");
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    await db.update(runs).set({ status: "discarded" }).where(eq(runs.id, run_id));
    set.status = 200;
    return { data: null };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params: { run_id }, set }) => {
    const { runs } = await import("./db/schema");
    const run = await db.query.runs.findFirst({
        where: eq(runs.id, run_id)
    });
    if (!run) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    await db.update(runs).set({ status: "canceled" }).where(eq(runs.id, run_id));
    set.status = 200;
    return { data: null };
  }, { isAuth: true })
  .post("/api/v2/users", async ({ body, set }) => {
    let payload;
    if (typeof body === 'string') {
        try {
            payload = JSON.parse(body);
        } catch (e) {
            set.status = 400;
            return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON" }] };
        }
    } else {
        payload = body;
    }

    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
        set.status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    try {
        const id = crypto.randomUUID();
        const passwordHash = await bcrypt.hash(password, 10);

        await db.insert(users).values({
            id,
            username,
            passwordHash
        });

        set.status = 201;
        return {
            data: {
                id,
                type: "users",
                attributes: {
                    username
                }
            }
        };
    } catch (e: any) {
        if (
            e.message?.includes("UNIQUE constraint failed") ||
            e.message?.includes("SQLITE_CONSTRAINT") ||
            e.message?.includes("UNIQUE") ||
            e.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
            e.message?.includes("SQLITE_CONSTRAINT_UNIQUE") ||
            (e.cause && e.cause.message?.includes("UNIQUE constraint failed"))
        ) {
            set.status = 409;
            return { errors: [{ status: "409", title: "Conflict", detail: "Username already exists" }] };
        }
        throw e;
    }
  })
  .get("*", ({ request, set }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) {
        set.status = 404;
        set.headers["Content-Type"] = "application/vnd.api+json";
        return {
            errors: [{
                status: "404",
                title: "Not Found"
            }]
        };
    }

    // Serve static assets natively because Elysia static plugin seems finicky
    const frontendDir = import.meta.dir + "/../../frontend/dist";
    const file = Bun.file(frontendDir + url.pathname);
    if (url.pathname !== "/" && file.size > 0) {
       return file;
    }

    // Fallback for SPA routing
    return Bun.file(frontendDir + "/index.html");
  });

// Endpoints are not implemented yet to fulfill the TDD requirement.
// The tests will fail against this app instance.
