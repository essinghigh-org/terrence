import { Elysia } from "elysia";
import { db } from "../db";
import { policySets, policySetVersions, policySetWorkspaces, policySetProjects, policySetExclusions, policySetParameters, policies, policyChecks, projects, runs, workspaces, organizations, oauthClients, oauthTokens, githubAppInstallations, type users } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { checkOrganizationPermission, checkWorkspacePermission, signedApiURL, validSignedApiURL } from "../lib/utils";
import { authPlugin } from "../auth";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const POLICY_ARCHIVE_DIR = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "policy-set-versions");

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: Readonly<typeof users.$inferSelect> | null;
  readonly orgId: string | null;
  readonly teamId: string | null;
  readonly request: Readonly<{ readonly url: string; readonly arrayBuffer: () => Promise<ArrayBuffer> }>;
  readonly set: SetObj;
}>;

type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type PsItem = DeepReadonly<typeof policySets.$inferSelect>;
type LinkProjItem = Readonly<{ readonly projectId: string }>;
type LinkExclItem = Readonly<{ readonly workspaceId: string }>;
type PolItem = DeepReadonly<typeof policies.$inferSelect>;
type PcItem = DeepReadonly<typeof policyChecks.$inferSelect>;
type ParamItem = DeepReadonly<typeof policySetParameters.$inferSelect>;
type PolicySetVersionItem = DeepReadonly<typeof policySetVersions.$inferSelect>;
type PolicySetVcsRepo = NonNullable<typeof policySets.$inferSelect.vcsRepo>;

function policyCheckResource(
  check: PcItem,
  policy: PolItem | undefined,
): Record<string, unknown> {
  return {
    id: check.id,
    type: "policy-checks",
    attributes: {
      status: check.status,
      result: check.result,
      "policy-name": policy?.name ?? null,
      "enforcement-level": policy?.enforcementLevel ?? null,
      "created-at": new Date(check.createdAt).toISOString(),
    },
  };
}

function vcsRepoResource(vcsRepo: DeepReadonly<PolicySetVcsRepo> | null): Record<string, unknown> | null {
  if (vcsRepo === null) return null;
  return {
    branch: vcsRepo.branch ?? null,
    identifier: vcsRepo.identifier ?? null,
    "oauth-token-id": vcsRepo.oauthTokenId ?? null,
    "github-app-installation-id": vcsRepo.githubAppInstallationId ?? null,
    "ingress-submodules": vcsRepo.ingressSubmodules ?? false,
  };
}

function policySetAttributes(policySet: PsItem): Record<string, unknown> {
  return {
    name: policySet.name,
    description: policySet.description,
    kind: policySet.kind,
    global: policySet.global,
    overridable: policySet.overridable,
    "agent-enabled": policySet.agentEnabled ?? false,
    "policy-tool-version": policySet.policyToolVersion,
    "policies-path": policySet.policiesPath,
    "policy-update-patterns": policySet.policyUpdatePatterns,
    "vcs-repo": vcsRepoResource(policySet.vcsRepo),
  };
}

async function normalizePolicySetVcsRepo(
  input: unknown,
  orgId: string,
  existing?: DeepReadonly<PolicySetVcsRepo>,
): Promise<Readonly<{ value: PolicySetVcsRepo | null }> | Readonly<{ error: string }>> {
  if (input === null) return { value: null };
  if (input === undefined) return { value: existing === undefined ? null : { ...existing } };
  if (typeof input !== "object" || Array.isArray(input)) return { error: "vcs-repo must be an object or null" };
  const raw = input as Record<string, unknown>;

  const rawIdentifier = raw.identifier;
  if (rawIdentifier !== undefined && typeof rawIdentifier !== "string") return { error: "vcs-repo.identifier must be a string" };
  const identifier = typeof rawIdentifier === "string" ? rawIdentifier.trim() : existing?.identifier ?? "";
  const repositoryParts = identifier.split("/");
  if (
    repositoryParts.length < 2
    || repositoryParts.some((part: string): boolean => !/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(part))
  ) return { error: "vcs-repo.identifier must identify a repository as namespace/name" };

  const rawOAuthTokenId = raw["oauth-token-id"] ?? raw.oauthTokenId;
  if (rawOAuthTokenId !== undefined && rawOAuthTokenId !== null && typeof rawOAuthTokenId !== "string") {
    return { error: "vcs-repo.oauth-token-id must be a string or null" };
  }
  const oauthTokenId = rawOAuthTokenId === null
    ? undefined
    : typeof rawOAuthTokenId === "string" ? rawOAuthTokenId.trim() : existing?.oauthTokenId;

  const rawInstallationId = raw["github-app-installation-id"] ?? raw.githubAppInstallationId;
  if (rawInstallationId !== undefined && rawInstallationId !== null && typeof rawInstallationId !== "string") {
    return { error: "vcs-repo.github-app-installation-id must be a string or null" };
  }
  const githubAppInstallationId = rawInstallationId === null
    ? undefined
    : typeof rawInstallationId === "string" ? rawInstallationId.trim() : existing?.githubAppInstallationId;
  const hasOAuthToken = oauthTokenId !== undefined && oauthTokenId !== "";
  const hasInstallation = githubAppInstallationId !== undefined && githubAppInstallationId !== "";
  if (hasOAuthToken === hasInstallation) {
    return { error: "vcs-repo requires exactly one OAuth token or GitHub App installation" };
  }

  if (hasOAuthToken) {
    const token = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, oauthTokenId) });
    const client = token === undefined
      ? undefined
      : await db.query.oauthClients.findFirst({
        where: and(eq(oauthClients.id, token.oauthClientId), eq(oauthClients.orgId, orgId)),
      });
    if (
      client === undefined
      || !["github", "github_enterprise", "gitlab", "gitlab_ce", "gitlab_ee", "bitbucket"].includes(client.serviceProvider)
    ) return { error: "vcs-repo OAuth token is not available in this organization" };
  }
  if (hasInstallation) {
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, githubAppInstallationId),
        eq(githubAppInstallations.orgId, orgId),
      ),
    });
    if (installation === undefined) return { error: "vcs-repo GitHub App installation is not available in this organization" };
  }

  const rawBranch = raw.branch;
  if (rawBranch !== undefined && rawBranch !== null && typeof rawBranch !== "string") {
    return { error: "vcs-repo.branch must be a string or null" };
  }
  const branch = rawBranch === null
    ? undefined
    : typeof rawBranch === "string" ? rawBranch.trim() : existing?.branch;
  const rawIngressSubmodules = raw["ingress-submodules"] ?? raw.ingressSubmodules;
  if (rawIngressSubmodules !== undefined && typeof rawIngressSubmodules !== "boolean") {
    return { error: "vcs-repo.ingress-submodules must be a boolean" };
  }
  const ingressSubmodules = typeof rawIngressSubmodules === "boolean"
    ? rawIngressSubmodules
    : existing?.ingressSubmodules ?? false;
  return {
    value: {
      identifier,
      ...(branch === undefined || branch === "" ? {} : { branch }),
      ...(hasOAuthToken ? { oauthTokenId } : {}),
      ...(hasInstallation ? { githubAppInstallationId } : {}),
      ingressSubmodules,
    },
  };
}

function normalizePolicyUpdatePatterns(input: unknown): Readonly<{ value: string[] }> | Readonly<{ error: string }> {
  if (!Array.isArray(input)) return { error: "policy-update-patterns must be an array" };
  if (input.length > 100) return { error: "policy-update-patterns supports at most 100 patterns" };
  const patterns: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") return { error: "policy-update-patterns entries must be strings" };
    const pattern = value.trim().replaceAll("\\", "/");
    if (
      pattern === ""
      || pattern.length > 512
      || pattern.startsWith("/")
      || pattern.split("/").includes("..")
      || pattern.includes("\0")
    ) return { error: "policy-update-patterns entries must be non-empty repository-relative globs" };
    try {
      new Bun.Glob(pattern);
    } catch {
      return { error: `policy-update-patterns contains an invalid glob: ${pattern}` };
    }
    patterns.push(pattern);
  }
  return { value: [...new Set(patterns)] };
}

function normalizePoliciesPath(input: unknown): Readonly<{ value: string | null }> | Readonly<{ error: string }> {
  if (input === null) return { value: null };
  if (typeof input !== "string") return { error: "policies-path must be a string or null" };
  const value = input.trim().replaceAll("\\", "/").replace(/\/+$/g, "");
  const relativePath = value.replace(/^\/+/, "");
  if (relativePath.split("/").includes("..") || value.includes("\0")) {
    return { error: "policies-path must stay within the repository" };
  }
  return { value: value === "" || relativePath === "" ? null : value };
}

function policySetVersionResource(version: PolicySetVersionItem, request: Readonly<{ readonly url: string }>): Record<string, unknown> {
  const uploadPath = `/api/v2/policy-set-versions/${version.id}/upload`;
  return {
    id: version.id,
    type: "policy-set-versions",
    attributes: {
      source: version.source,
      status: version.status,
      "status-timestamps": {
        "uploaded-at": version.statusTimestamps.uploadedAt ?? null,
        "ready-at": version.statusTimestamps.readyAt ?? null,
        "errored-at": version.statusTimestamps.erroredAt ?? null,
      },
      "ingress-attributes": version.ingressAttributes,
      error: version.error,
      "created-at": new Date(version.createdAt).toISOString(),
      "updated-at": new Date(version.updatedAt).toISOString(),
    },
    relationships: {
      "policy-set": { data: { id: version.policySetId, type: "policy-sets" } },
    },
    links: {
      self: `/api/v2/policy-set-versions/${version.id}`,
      ...(version.status === "pending" && version.source === "tfe-api" ? { upload: signedApiURL(request, uploadPath, "PUT", 3600) } : {}),
    },
  };
}


export const policyRoutes = new Elysia({ name: "policies" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/policy-sets", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (workspace === undefined || !(await checkWorkspacePermission(workspace, user?.id, tokenOrgId, tokenTeamId ?? null, "read"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const [directLinks, projectLinks, globalSets, exclusions] = await Promise.all([
      db.query.policySetWorkspaces.findMany({ where: eq(policySetWorkspaces.workspaceId, workspaceId) }),
      workspace.projectId === null
        ? Promise.resolve([])
        : db.query.policySetProjects.findMany({ where: eq(policySetProjects.projectId, workspace.projectId) }),
      db.query.policySets.findMany({ where: and(eq(policySets.orgId, workspace.orgId), eq(policySets.global, true)) }),
      db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.workspaceId, workspaceId) }),
    ]);
    const directIds = new Set(directLinks.map((link: Readonly<{ policySetId: string }>): string => link.policySetId));
    const projectIds = new Set(projectLinks.map((link: Readonly<{ policySetId: string }>): string => link.policySetId));
    const excludedIds = new Set(exclusions.map((link: Readonly<{ policySetId: string }>): string => link.policySetId));
    const effectiveIds = [...new Set([
      ...directIds,
      ...projectIds,
      ...globalSets.map((policySet: PsItem): string => policySet.id),
    ])].filter((policySetId: string): boolean => !excludedIds.has(policySetId));
    if (effectiveIds.length === 0) return { data: [] };

    const [effectiveSets, effectivePolicies] = await Promise.all([
      db.query.policySets.findMany({ where: inArray(policySets.id, effectiveIds) }),
      db.query.policies.findMany({ where: inArray(policies.policySetId, effectiveIds) }),
    ]);
    const policyCounts = new Map<string, number>();
    for (const policy of effectivePolicies) {
      policyCounts.set(policy.policySetId, (policyCounts.get(policy.policySetId) ?? 0) + 1);
    }

    return {
      data: effectiveSets.map((policySet: PsItem): Record<string, unknown> => ({
        id: policySet.id,
        type: "policy-sets",
        attributes: {
          ...policySetAttributes(policySet),
          "policy-count": policyCounts.get(policySet.id) ?? 0,
          scope: policySet.global === true ? "global" : directIds.has(policySet.id) ? "workspace" : "project",
        },
      })),
    };
  })
  .get("/api/v2/organizations/:org_name/policy-sets", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "read-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const psList = await db.query.policySets.findMany({ where: eq(policySets.orgId, org.id) });
    const data = await Promise.all(psList.map(async (ps: PsItem): Promise<Record<string, unknown>> => {
      const [projLinks, exclLinks] = await Promise.all([
        db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, ps.id) }),
        db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.policySetId, ps.id) }),
      ]);
      return { id: ps.id, type: "policy-sets", attributes: policySetAttributes(ps), relationships: { projects: { data: projLinks.map((l: LinkProjItem): Record<string, string> => ({ id: l.projectId, type: "projects" })) }, "workspace-exclusions": { data: exclLinks.map((l: LinkExclItem): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) } } };
    }));
    return { data };
  })
  .post("/api/v2/organizations/:org_name/policy-sets", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `polset-${crypto.randomUUID()}`;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const kind = typeof attributes.kind === "string" ? attributes.kind : "sentinel";
    if (!["sentinel", "opa"].includes(kind)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "kind must be sentinel or opa" }] };
    }
    const global = typeof attributes.global === "boolean" ? attributes.global : false;
    const overridable = typeof attributes.overridable === "boolean" ? attributes.overridable : true;
    const agentEnabled = typeof attributes["agent-enabled"] === "boolean" ? attributes["agent-enabled"] : false;
    const policyToolVersion = typeof attributes["policy-tool-version"] === "string" ? attributes["policy-tool-version"] : null;
    const normalizedVcsRepo = await normalizePolicySetVcsRepo(attributes["vcs-repo"], org.id);
    if ("error" in normalizedVcsRepo) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalizedVcsRepo.error }] };
    }
    const normalizedPath = normalizePoliciesPath(attributes["policies-path"] ?? null);
    if ("error" in normalizedPath) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalizedPath.error }] };
    }
    const normalizedPatterns = normalizePolicyUpdatePatterns(attributes["policy-update-patterns"] ?? []);
    if ("error" in normalizedPatterns) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalizedPatterns.error }] };
    }
    if (
      normalizedVcsRepo.value === null
      && (normalizedPath.value !== null || normalizedPatterns.value.length > 0)
    ) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "policies-path and policy-update-patterns require vcs-repo" }] };
    }
    const relationships = data?.relationships !== null && typeof data?.relationships === "object"
      ? data.relationships as Record<string, unknown>
      : {};
    const policyRelationship = relationships.policies !== null && typeof relationships.policies === "object"
      ? relationships.policies as Record<string, unknown>
      : {};
    if (normalizedVcsRepo.value !== null && Array.isArray(policyRelationship.data) && policyRelationship.data.length > 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "vcs-repo and policies relationships are mutually exclusive" }] };
    }
    await db.insert(policySets).values({
      id,
      orgId: org.id,
      name,
      description,
      kind,
      global,
      overridable,
      agentEnabled,
      policyToolVersion,
      policiesPath: normalizedPath.value,
      vcsRepo: normalizedVcsRepo.value,
      policyUpdatePatterns: normalizedPatterns.value,
      createdAt: Date.now(),
    });
    const created = await db.query.policySets.findFirst({ where: eq(policySets.id, id) });
    if (created === undefined) throw new Error("Policy set disappeared after creation");
    (set as { status: number }).status = 201;
    return { data: { id, type: "policy-sets", attributes: policySetAttributes(created) } };
  })
  .get("/api/v2/policy-sets/:policy_set_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const [projLinks, exclLinks] = await Promise.all([
      db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, policySetId) }),
      db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.policySetId, policySetId) }),
    ]);
    return { data: { id: ps.id, type: "policy-sets", attributes: policySetAttributes(ps), relationships: { projects: { data: projLinks.map((l: LinkProjItem): Record<string, string> => ({ id: l.projectId, type: "projects" })) }, "workspace-exclusions": { data: exclLinks.map((l: LinkExclItem): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) } } } };
  })
  .patch("/api/v2/policy-sets/:policy_set_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof policySets.$inferInsert> = {};
    const normalizedVcsRepo = await normalizePolicySetVcsRepo(attributes["vcs-repo"], ps.orgId, ps.vcsRepo ?? undefined);
    if ("error" in normalizedVcsRepo) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalizedVcsRepo.error }] };
    }
    const normalizedPath = attributes["policies-path"] === undefined
      ? { value: ps.policiesPath }
      : normalizePoliciesPath(attributes["policies-path"]);
    if ("error" in normalizedPath) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalizedPath.error }] };
    }
    const normalizedPatterns = attributes["policy-update-patterns"] === undefined
      ? { value: [...ps.policyUpdatePatterns] }
      : normalizePolicyUpdatePatterns(attributes["policy-update-patterns"]);
    if ("error" in normalizedPatterns) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: normalizedPatterns.error }] };
    }
    if (
      normalizedVcsRepo.value === null
      && (normalizedPath.value !== null || normalizedPatterns.value.length > 0)
    ) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "policies-path and policy-update-patterns require vcs-repo" }] };
    }
    const relationships = data?.relationships !== null && typeof data?.relationships === "object"
      ? data.relationships as Record<string, unknown>
      : {};
    const policyRelationship = relationships.policies !== null && typeof relationships.policies === "object"
      ? relationships.policies as Record<string, unknown>
      : {};
    if (normalizedVcsRepo.value !== null && Array.isArray(policyRelationship.data) && policyRelationship.data.length > 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "vcs-repo and policies relationships are mutually exclusive" }] };
    }
    if (attributes["vcs-repo"] !== undefined && normalizedVcsRepo.value !== null && ps.vcsRepo === null) {
      const attachedPolicy = await db.query.policies.findFirst({ where: eq(policies.policySetId, policySetId) });
      if (attachedPolicy !== undefined) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Remove individually managed policies before configuring vcs-repo" }] };
      }
    }
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    if (typeof attributes.kind === "string") {
      if (!["sentinel", "opa"].includes(attributes.kind)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "kind must be sentinel or opa" }] };
      }
      updates.kind = attributes.kind;
    }
    if (typeof attributes.global === "boolean") updates.global = attributes.global;
    if (typeof attributes.overridable === "boolean") updates.overridable = attributes.overridable;
    if (typeof attributes["agent-enabled"] === "boolean") updates.agentEnabled = attributes["agent-enabled"];
    if (attributes["policy-tool-version"] !== undefined) updates.policyToolVersion = typeof attributes["policy-tool-version"] === "string" ? attributes["policy-tool-version"] : null;
    if (attributes["policies-path"] !== undefined) updates.policiesPath = normalizedPath.value;
    if (attributes["policy-update-patterns"] !== undefined) updates.policyUpdatePatterns = normalizedPatterns.value;
    if (attributes["vcs-repo"] !== undefined) updates.vcsRepo = normalizedVcsRepo.value;
    if (Object.keys(updates).length > 0) await db.update(policySets).set(updates).where(eq(policySets.id, policySetId));
    const updated = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "policy-sets", attributes: policySetAttributes(updated) } };
  })
  .delete("/api/v2/policy-sets/:policy_set_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const versions = await db.query.policySetVersions.findMany({ where: eq(policySetVersions.policySetId, policySetId) });
    await db.delete(policySets).where(eq(policySets.id, policySetId));
    await Promise.all(versions.map(async (version: PolicySetVersionItem): Promise<void> => {
      if (version.archivePath !== null) await rm(version.archivePath, { force: true });
    }));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Policy Set Versions ---
  .post("/api/v2/policy-sets/:policy_set_id/versions", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const policySet = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (policySet === undefined || !(await checkOrganizationPermission(policySet.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attachedPolicy = await db.query.policies.findFirst({ where: eq(policies.policySetId, policySetId) });
    if (policySet.vcsRepo !== null || attachedPolicy !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Policy set does not support direct version uploads" }] };
    }
    const now = Date.now();
    const version = {
      id: `polsetver-${crypto.randomUUID()}`,
      policySetId,
      source: "tfe-api",
      status: "pending",
      statusTimestamps: {},
      ingressAttributes: null,
      error: null,
      archivePath: null,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof policySetVersions.$inferInsert;
    await db.insert(policySetVersions).values(version);
    (set as { status: number }).status = 201;
    return { data: policySetVersionResource(version, request) };
  })
  .get("/api/v2/policy-set-versions/:version_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, request, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const version = await db.query.policySetVersions.findFirst({ where: eq(policySetVersions.id, versionId) });
    if (version === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const policySet = await db.query.policySets.findFirst({ where: eq(policySets.id, version.policySetId) });
    if (policySet === undefined || !(await checkOrganizationPermission(policySet.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: policySetVersionResource(version, request) };
  })
  .put("/api/v2/policy-set-versions/:version_id/upload", async ({ params, body, request, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    const uploadPath = `/api/v2/policy-set-versions/${versionId}/upload`;
    if (!validSignedApiURL(request, uploadPath, "PUT")) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Upload URL is invalid or expired" }] };
    }
    const version = await db.query.policySetVersions.findFirst({ where: eq(policySetVersions.id, versionId) });
    if (version === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (version.source !== "tfe-api" || version.status !== "pending" || version.archivePath !== null) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Policy set version content was already uploaded" }] };
    }
    const archive = body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : ArrayBuffer.isView(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : body instanceof Blob
          ? new Uint8Array(await body.arrayBuffer())
          : new Uint8Array(await request.arrayBuffer());
    if (archive.byteLength < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A non-empty tar.gz archive is required" }] };
    }
    await mkdir(POLICY_ARCHIVE_DIR, { recursive: true, mode: 0o700 });
    const archivePath = join(POLICY_ARCHIVE_DIR, `${versionId}.tar.gz`);
    const temporaryPath = `${archivePath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, archive, { mode: 0o600 });
      await rename(temporaryPath, archivePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    const readyAt = new Date().toISOString();
    await db.update(policySetVersions).set({
      status: "ready",
      statusTimestamps: { uploadedAt: readyAt, readyAt },
      archivePath,
      updatedAt: Date.now(),
    }).where(eq(policySetVersions.id, versionId));
    const updated = await db.query.policySetVersions.findFirst({ where: eq(policySetVersions.id, versionId) });
    if (updated === undefined) throw new Error("Policy set version disappeared after upload");
    return { data: policySetVersionResource(updated, request) };
  })
  // --- Policy Set Relationships ---
  .post("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) {
      const workspaceIds = wsItems
        .map((item: unknown): string => item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          ? (item as Record<string, unknown>).id as string
          : "")
        .filter((id: string): boolean => id !== "");
      const workspacesInOrg = workspaceIds.length === 0
        ? []
        : await db.query.workspaces.findMany({
          where: and(eq(workspaces.orgId, ps.orgId), inArray(workspaces.id, workspaceIds)),
        });
      const batch = workspacesInOrg.map((workspace): { id: string; policySetId: string; workspaceId: string } => ({
        id: `psw-${crypto.randomUUID()}`,
        policySetId,
        workspaceId: workspace.id,
      }));
      if (batch.length > 0) await db.insert(policySetWorkspaces).values(batch).onConflictDoNothing();
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/policy-sets/:policy_set_id/relationships/projects", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const projItems = payload.data;
    if (Array.isArray(projItems)) {
      const projectIds = projItems
        .map((item: unknown): string => item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          ? (item as Record<string, unknown>).id as string
          : "")
        .filter((id: string): boolean => id !== "");
      const projectsInOrg = projectIds.length === 0
        ? []
        : await db.query.projects.findMany({
          where: and(eq(projects.orgId, ps.orgId), inArray(projects.id, projectIds)),
        });
      const batch = projectsInOrg.map((project): { id: string; policySetId: string; projectId: string } => ({
        id: `pspj-${crypto.randomUUID()}`,
        policySetId,
        projectId: project.id,
      }));
      if (batch.length > 0) await db.insert(policySetProjects).values(batch).onConflictDoNothing();
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/projects", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const projItems = payload.data;
    if (Array.isArray(projItems)) { const projIds = projItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== ""); if (projIds.length > 0) await db.delete(policySetProjects).where(and(eq(policySetProjects.policySetId, policySetId), inArray(policySetProjects.projectId, projIds))); }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/policy-sets/:policy_set_id/relationships/workspace-exclusions", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) {
      const workspaceIds = wsItems
        .map((item: unknown): string => item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          ? (item as Record<string, unknown>).id as string
          : "")
        .filter((id: string): boolean => id !== "");
      const workspacesInOrg = workspaceIds.length === 0
        ? []
        : await db.query.workspaces.findMany({
          where: and(eq(workspaces.orgId, ps.orgId), inArray(workspaces.id, workspaceIds)),
        });
      const batch = workspacesInOrg.map((workspace): { id: string; policySetId: string; workspaceId: string } => ({
        id: `psex-${crypto.randomUUID()}`,
        policySetId,
        workspaceId: workspace.id,
      }));
      if (batch.length > 0) await db.insert(policySetExclusions).values(batch).onConflictDoNothing();
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/workspace-exclusions", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) { const wsIds = wsItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== ""); if (wsIds.length > 0) await db.delete(policySetExclusions).where(and(eq(policySetExclusions.policySetId, policySetId), inArray(policySetExclusions.workspaceId, wsIds))); }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const wsItems = payload.data;
    if (Array.isArray(wsItems)) { const wsIds = wsItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== ""); if (wsIds.length > 0) await db.delete(policySetWorkspaces).where(and(eq(policySetWorkspaces.policySetId, policySetId), inArray(policySetWorkspaces.workspaceId, wsIds))); }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Policies ---
  .get("/api/v2/policy-sets/:policy_set_id/policies", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const polList = await db.query.policies.findMany({ where: eq(policies.policySetId, policySetId) });
    return { data: polList.map((p: PolItem): Record<string, unknown> => ({ id: p.id, type: "policies", attributes: { name: p.name, description: p.description, "enforcement-level": p.enforcementLevel, query: p.query } })) };
  })
  .post("/api/v2/policy-sets/:policy_set_id/policies", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ps.vcsRepo !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `pol-${crypto.randomUUID()}`;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const enforcementLevel = typeof attributes["enforcement-level"] === "string" ? attributes["enforcement-level"] : "soft-mandatory";
    const query = typeof attributes.query === "string" ? attributes.query : null;
    await db.insert(policies).values({ id, policySetId, name, description, enforcementLevel, query, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "policies", attributes: { name, description, "enforcement-level": enforcementLevel, query } } };
  })
  .get("/api/v2/policies/:policy_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policyId = params.policy_id ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: pol.id, type: "policies", attributes: { name: pol.name, description: pol.description, "enforcement-level": pol.enforcementLevel, query: pol.query } } };
  })
  .patch("/api/v2/policies/:policy_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policyId = params.policy_id ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ps.vcsRepo !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof policies.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    if (typeof attributes["enforcement-level"] === "string") updates.enforcementLevel = attributes["enforcement-level"];
    if (attributes.query !== undefined) updates.query = typeof attributes.query === "string" ? attributes.query : null;
    if (Object.keys(updates).length > 0) await db.update(policies).set(updates).where(eq(policies.id, policyId));
    const updated = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "policies", attributes: { name: updated.name, description: updated.description, "enforcement-level": updated.enforcementLevel, query: updated.query } } };
  })
  .delete("/api/v2/policies/:policy_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policyId = params.policy_id ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ps.vcsRepo !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    await db.delete(policies).where(eq(policies.id, policyId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Policy Checks ---
  .get("/api/v2/runs/:run_id/policy-checks", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const pcList = await db.query.policyChecks.findMany({ where: eq(policyChecks.runId, runId) });
    const policyIds = [...new Set(pcList.flatMap((check): string[] =>
      check.policyId === null ? [] : [check.policyId]))];
    const policyList = policyIds.length === 0
      ? []
      : await db.query.policies.findMany({ where: inArray(policies.id, policyIds) });
    const policiesById = new Map(policyList.map((policy): [string, PolItem] => [policy.id, policy]));
    return {
      data: pcList.map((check: PcItem): Record<string, unknown> =>
        policyCheckResource(check, check.policyId === null ? undefined : policiesById.get(check.policyId))),
    };
  })
  .get("/api/v2/policy-checks/:check_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const checkId = params.check_id ?? "";
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, checkId) });
    if (pc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, pc.runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const policy = pc.policyId === null
      ? undefined
      : await db.query.policies.findFirst({ where: eq(policies.id, pc.policyId) });
    return { data: policyCheckResource(pc, policy) };
  })
  .post("/api/v2/policy-checks/:check_id/actions/override", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const checkId = params.check_id ?? "";
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, checkId) });
    if (pc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, pc.runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "policy-override"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(policyChecks).set({ status: "overridden" }).where(eq(policyChecks.id, checkId));
    return { data: { id: pc.id, type: "policy-checks", attributes: { status: "overridden", result: pc.result } } };
  })
  // --- Policy Set Parameters ---
  .get("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const paramsList = await db.query.policySetParameters.findMany({ where: eq(policySetParameters.policySetId, policySetId) });
    return { data: paramsList.map((p: ParamItem): Record<string, unknown> => ({ id: p.id, type: "vars", attributes: { key: p.key, value: p.sensitive === true ? null : p.value, sensitive: p.sensitive, hcl: p.hcl } })) };
  })
  .post("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const key = typeof attrs.key === "string" ? attrs.key : "";
    if (key === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `psparam-${crypto.randomUUID()}`;
    const value = typeof attrs.value === "string" ? attrs.value : "";
    const sensitive = typeof attrs.sensitive === "boolean" ? attrs.sensitive : false;
    const hcl = typeof attrs.hcl === "boolean" ? attrs.hcl : false;
    await db.insert(policySetParameters).values({ id, policySetId, key, value, sensitive, hcl });
    (set as { status: number }).status = 201;
    return { data: { id, type: "vars", attributes: { key, value: sensitive ? null : value, sensitive, hcl } } };
  })
  .patch("/api/v2/policy-sets/:policy_set_id/parameters/:param_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const paramId = params.param_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const param = await db.query.policySetParameters.findFirst({ where: and(eq(policySetParameters.id, paramId), eq(policySetParameters.policySetId, policySetId)) });
    if (param === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof policySetParameters.$inferInsert> = {};
    if (typeof attrs.key === "string") updates.key = attrs.key;
    if (typeof attrs.value === "string") updates.value = attrs.value;
    if (typeof attrs.sensitive === "boolean") updates.sensitive = attrs.sensitive;
    if (typeof attrs.hcl === "boolean") updates.hcl = attrs.hcl;
    if (Object.keys(updates).length > 0) await db.update(policySetParameters).set(updates).where(eq(policySetParameters.id, paramId));
    const updated = await db.query.policySetParameters.findFirst({ where: eq(policySetParameters.id, paramId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "vars", attributes: { key: updated.key, value: updated.sensitive === true ? null : updated.value, sensitive: updated.sensitive, hcl: updated.hcl } } };
  })
  .delete("/api/v2/policy-sets/:policy_set_id/parameters/:param_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const paramId = params.param_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const param = await db.query.policySetParameters.findFirst({ where: and(eq(policySetParameters.id, paramId), eq(policySetParameters.policySetId, policySetId)) });
    if (param === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(policySetParameters).where(eq(policySetParameters.id, paramId));
    (set as { status: number }).status = 204;
    return {};
  });
