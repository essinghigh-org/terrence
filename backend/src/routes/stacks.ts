import { Elysia } from "elysia";
import { eq, and } from "drizzle-orm";
import { authPlugin } from "../auth";
import { db } from "../db";
import { organizations, projects, stacks, agentPools } from "../db/schema";
import { checkOrganizationPermission } from "../lib/utils";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
    ? readonly DeepReadonly<R>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: DeepReadonly<typeof import("../db/schema").users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly teamId?: string | null;
  readonly request: Readonly<{ readonly url: string; readonly arrayBuffer: () => Promise<ArrayBuffer> }>;
  readonly set: SetObj;
}>;

type StackItem = Readonly<typeof stacks.$inferSelect>;

function stackResource(stack: StackItem, _projectName: string | null): Record<string, unknown> {
  const vcsRepo: Record<string, unknown> = {};
  if (stack.vcsIdentifier !== null) {
    vcsRepo.identifier = stack.vcsIdentifier;
    if (stack.vcsBranch !== null) vcsRepo.branch = stack.vcsBranch;
    if (stack.vcsOAuthTokenId !== null) vcsRepo["oauth-token-id"] = stack.vcsOAuthTokenId;
    if (stack.vcsGhaInstallationId !== null) vcsRepo["github-app-installation-id"] = stack.vcsGhaInstallationId;
  }
  const relationships: Record<string, unknown> = {};
  if (stack.projectId !== null) {
    relationships.project = { data: { id: stack.projectId, type: "projects" } };
  }
  if (stack.agentPoolId !== null) {
    relationships["agent-pool"] = { data: { id: stack.agentPoolId, type: "agent-pools" } };
  }
  return {
    id: stack.id,
    type: "stacks",
    attributes: {
      name: stack.name,
      description: stack.description ?? "",
      "speculative-enabled": stack.speculativeEnabled,
      "working-directory": stack.workingDirectory,
      "trigger-patterns": Array.isArray(stack.triggerPatterns) ? stack.triggerPatterns : [],
      "created-at": new Date(stack.createdAt).toISOString(),
      "updated-at": new Date(stack.updatedAt).toISOString(),
      ...(Object.keys(vcsRepo).length > 0 ? { "vcs-repo": vcsRepo } : {}),
    },
    relationships,
  };
}

function stackVcsRepoAttributes(attributes: Record<string, unknown>): { vcsIdentifier: string | null; vcsBranch: string | null; vcsOAuthTokenId: string | null; vcsGhaInstallationId: string | null } {
  const vcs = attributes["vcs-repo"];
  if (vcs === null || typeof vcs !== "object" || Array.isArray(vcs)) {
    return { vcsIdentifier: null, vcsBranch: null, vcsOAuthTokenId: null, vcsGhaInstallationId: null };
  }
  const repo = vcs as Record<string, unknown>;
  const identifier = typeof repo.identifier === "string" ? repo.identifier.trim() : "";
  const branch = typeof repo.branch === "string" ? repo.branch : "";
  const oauthTokenId = typeof repo["oauth-token-id"] === "string" ? repo["oauth-token-id"] : "";
  const ghaId = typeof repo["github-app-installation-id"] === "string" ? repo["github-app-installation-id"] : "";
  return {
    vcsIdentifier: identifier === "" ? null : identifier,
    vcsBranch: branch === "" ? null : branch,
    vcsOAuthTokenId: oauthTokenId === "" ? null : oauthTokenId,
    vcsGhaInstallationId: ghaId === "" ? null : ghaId,
  };
}

async function stackDetails(stackId: string): Promise<{ stack: StackItem; orgName: string; projectName: string | null } | undefined> {
  const stack = await db.query.stacks.findFirst({ where: eq(stacks.id, stackId) });
  if (stack === undefined) return undefined;
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, stack.orgId) });
  const projectName = stack.projectId === null
    ? null
    : (await db.query.projects.findFirst({ where: eq(projects.id, stack.projectId) }))?.name ?? null;
  return { stack, orgName: org?.name ?? stack.orgId, projectName };
}

export const stackRoutes = new Elysia({ name: "stacks" })
  .use(authPlugin)
  .post("/api/v2/stacks", async ({ body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data;
    if (data === null || typeof data !== "object") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data is required" }] }; }
    const attributes = (data as Record<string, unknown>).attributes;
    const attrs = attributes !== null && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
    const relationships = (data as Record<string, unknown>).relationships;
    const rels = relationships !== null && typeof relationships === "object" ? relationships as Record<string, unknown> : {};
    const name = typeof attrs.name === "string" ? attrs.name.trim() : "";
    const description = typeof attrs.description === "string" ? attrs.description : "";
    const projectData = (rels.project as { data?: { id?: unknown } } | undefined)?.data;
    const projectId = typeof projectData?.id === "string" ? projectData.id : "";
    const agentPoolData = (rels["agent-pool"] as { data?: { id?: unknown } } | undefined)?.data;
    const agentPoolId = typeof agentPoolData?.id === "string" ? agentPoolData.id : undefined;
    const workingDirectory = typeof attrs["working-directory"] === "string" ? attrs["working-directory"] : undefined;
    const speculative = attrs["speculative-enabled"] === true;
    const triggerPatterns = Array.isArray(attrs["trigger-patterns"]) ? (attrs["trigger-patterns"] as unknown[]).filter((item): item is string => typeof item === "string") : [];
    if (name === "" || projectId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "name and project are required" }] }; }
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (project === undefined || !(await checkOrganizationPermission(project.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (agentPoolId !== undefined) {
      const pool = await db.query.agentPools.findFirst({
        where: and(eq(agentPools.id, agentPoolId), eq(agentPools.orgId, project.orgId)),
      });
      if (pool === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    }
    const vcs = stackVcsRepoAttributes(attrs);
    const id = `st-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    const row: typeof stacks.$inferInsert = {
      id, orgId: project.orgId, projectId, agentPoolId: agentPoolId ?? null, name, description: description === "" ? null : description,
      speculativeEnabled: speculative, workingDirectory: workingDirectory ?? null, triggerPatterns,
      vcsIdentifier: vcs.vcsIdentifier, vcsBranch: vcs.vcsBranch, vcsOAuthTokenId: vcs.vcsOAuthTokenId, vcsGhaInstallationId: vcs.vcsGhaInstallationId,
      createdAt: now, updatedAt: now,
    };
    await db.insert(stacks).values(row);
    (set as { status: number }).status = 201;
    return { data: stackResource(row as StackItem, project.name) };
  })
  .get("/api/v2/stacks/:stack_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stackResource(details.stack, details.projectName) };
  })
  .get("/api/v2/organizations/:org_name/stacks", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const rows = await db.query.stacks.findMany({ where: eq(stacks.orgId, org.id) });
    return { data: rows.map((stack): Record<string, unknown> => stackResource(stack, null)) };
  })
  .patch("/api/v2/stacks/:stack_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const raw = body;
    const payload = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const data = payload.data;
    const attrs = (data !== null && typeof data === "object" ? (data as Record<string, unknown>).attributes : null);
    const attributes = attrs !== null && typeof attrs === "object" ? attrs as Record<string, unknown> : {};
    const updates: Partial<typeof stacks.$inferInsert> = { updatedAt: Date.now() };
    if (typeof attributes.name === "string" && attributes.name.trim() !== "") updates.name = attributes.name.trim();
    if (typeof attributes.description === "string") updates.description = attributes.description;
    if (typeof attributes["speculative-enabled"] === "boolean") updates.speculativeEnabled = attributes["speculative-enabled"];
    if (typeof attributes["working-directory"] === "string") updates.workingDirectory = attributes["working-directory"];
    if (Array.isArray(attributes["trigger-patterns"])) updates.triggerPatterns = (attributes["trigger-patterns"] as unknown[]).filter((item): item is string => typeof item === "string");
    // vcs-repo updates replace the stored VCS attributes (empty/null clears).
    // A present-but-malformed vcs-repo is a client error, not a silent clear.
    if (attributes["vcs-repo"] !== undefined) {
      const vcs = attributes["vcs-repo"];
      if (vcs !== null && (typeof vcs !== "object" || Array.isArray(vcs))) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "vcs-repo must be an object or null" }] };
      }
      const v = stackVcsRepoAttributes(attributes);
      updates.vcsIdentifier = v.vcsIdentifier;
      updates.vcsBranch = v.vcsBranch;
      updates.vcsOAuthTokenId = v.vcsOAuthTokenId;
      updates.vcsGhaInstallationId = v.vcsGhaInstallationId;
    }
    await db.update(stacks).set(updates).where(eq(stacks.id, details.stack.id));
    const updated = await db.query.stacks.findFirst({ where: eq(stacks.id, params.stack_id ?? "") });
    return { data: updated === undefined ? undefined : stackResource(updated, details.projectName) };
  })
  .delete("/api/v2/stacks/:stack_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(stacks).where(eq(stacks.id, details.stack.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/stacks/:stack_id/fetch-latest-from-vcs", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const details = await stackDetails(params.stack_id ?? "");
    if (details === undefined || !(await checkOrganizationPermission(details.stack.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-projects"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // Terrence has no outbound VCS integration, so there is nothing to fetch:
    // return the current stack state (a no-op) rather than claim a fetch
    // happened. go-tfe callers only observe the returned resource.
    return { data: stackResource(details.stack, details.projectName) };
  });