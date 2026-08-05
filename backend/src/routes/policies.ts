import { Elysia } from "elysia";
import { db } from "../db";
import { policySets, policySetVersions, policySetWorkspaces, policySetProjects, policySetExclusions, policySetParameters, policies, policyChecks, projects, runs, workspaces, organizations, oauthClients, oauthTokens, githubAppInstallations, type users } from "../db/schema";
import { eq, and, inArray, asc } from "drizzle-orm";
import { checkOrganizationPermission, checkWorkspacePermission, signedApiURL, validSignedApiURL } from "../lib/utils";
import { organizationName } from "../lib/response";
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

// Extract policy reference ids from a policy-set relationships payload. Accepts
// both go-tfe's Policies.Add shape ({ "policies": [{id}] }) and the standard
// { data: { relationships: { policies: { data: [{id}] } } } } shape.
function extractPolicyRefIds(body: unknown): string[] {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const collect = (refs: unknown): string[] => {
    const arr = Array.isArray(refs) ? refs : [];
    return arr.map((r): string => (typeof (r as { id?: unknown })?.id === "string" ? (r as { id: string }).id : "")).filter((id: string): boolean => id !== "");
  };
  if (Array.isArray(b.policies)) return collect(b.policies);
  const data = b.data as Record<string, unknown> | undefined;
  if (data !== null && typeof data === "object") {
    const rels = data.relationships as Record<string, unknown> | undefined;
    const pr = rels?.policies as Record<string, unknown> | undefined;
    if (pr !== null && typeof pr === "object" && Array.isArray(pr.data)) return collect(pr.data);
  }
  return [];
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

// Full TFE policy-set relationship shape. The provider's workspace/project
// policy-set resources read the attached workspaces/projects back from the
// policy-set resource, so these must be populated.
async function policySetRelationships(policySet: PsItem): Promise<Record<string, unknown>> {
  const [workspaceLinks, projLinks, exclLinks, policyRows] = await Promise.all([
    db.query.policySetWorkspaces.findMany({ where: eq(policySetWorkspaces.policySetId, policySet.id) }),
    db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, policySet.id) }),
    db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.policySetId, policySet.id) }),
    db.query.policies.findMany({ where: eq(policies.policySetId, policySet.id), columns: { id: true } }),
  ]);
  const orgName = await organizationName(policySet.orgId);
  return {
    organization: { data: { id: orgName ?? policySet.orgId, type: "organizations" } },
    workspaces: { data: workspaceLinks.map((l): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) },
    projects: { data: projLinks.map((l): Record<string, string> => ({ id: l.projectId, type: "projects" })) },
    "workspace-exclusions": { data: exclLinks.map((l): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) },
    policies: { data: policyRows.map((p): Record<string, string> => ({ id: p.id, type: "policies" })) },
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


type PolicyRow = Readonly<{
  id: string; orgId: string | null; policySetId: string | null; policySetVersionId: string | null;
  name: string; description: string | null; enforcementLevel: string | null; query: string | null;
  source: string | null; sourcePath: string | null; createdAt: number;
}>;

async function policyResource(pol: PolicyRow, orgName: string | null): Promise<Record<string, unknown>> {
  return {
    id: pol.id,
    type: "policies",
    attributes: {
      name: pol.name,
      description: pol.description,
      // Terrence stores the policy content in `query` and only supports
      // Sentinel policies today.
      kind: "sentinel",
      policy: pol.query ?? "",
      "enforcement-level": pol.enforcementLevel ?? "soft-mandatory",
      "created-at": new Date(pol.createdAt).toISOString(),
      "updated-at": new Date(pol.createdAt).toISOString(),
    },
    relationships: {
      organization: { data: { id: orgName ?? pol.orgId ?? "", type: "organizations" } },
      "policy-sets": {
        data: pol.policySetId === null ? [] : [{ id: pol.policySetId, type: "policy-sets" }],
      },
    },
    links: { self: `/api/v2/policies/${pol.id}` },
  };
}

// Policies historically created attached to a policy set may have a null
// org_id (the org is derivable from the set). Resolve org id through the set
// when the direct org_id column is absent.
async function resolvePolicyOrgId(pol: { orgId: string | null; policySetId: string | null }): Promise<string | null> {
  if (pol.orgId !== null) return pol.orgId;
  if (pol.policySetId === null) return null;
  const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
  return ps?.orgId ?? null;
}

export const policyRoutes = new Elysia({ name: "policies" })
  .use(authPlugin)
  // Org-scoped (standalone) policies — go-tfe Policies.Create/List hit these.
  .get("/api/v2/organizations/:org_name/policies", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "read-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const polList = (await db.query.policies.findMany({
      where: eq(policies.orgId, org.id),
      orderBy: [asc(policies.name)],
    })) as unknown as PolicyRow[];
    return { data: await Promise.all(polList.map((pol): Promise<Record<string, unknown>> => policyResource(pol, org.name))) };
  })
  .post("/api/v2/organizations/:org_name/policies", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const description = typeof attributes.description === "string" ? attributes.description : null;
    // The policies table has no stored kind column yet; policyResource always
    // reports "sentinel", so silently accepting "opa" would be a lie.
    const kind = typeof attributes.kind === "string" ? attributes.kind : "sentinel";
    if (kind !== "sentinel") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "kind must be sentinel" }] }; }
    const query = typeof attributes.policy === "string" ? attributes.policy : (typeof attributes.query === "string" ? attributes.query : null);
    const enforcementLevel = typeof attributes["enforcement-level"] === "string" ? attributes["enforcement-level"] : (typeof attributes["enforce_mode"] === "string" ? attributes["enforce_mode"] : "soft-mandatory");
    if (!["advisory", "soft-mandatory", "hard-mandatory"].includes(enforcementLevel)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "enforcement-level must be advisory, soft-mandatory, or hard-mandatory" }] };
    }
    const id = `pol-${crypto.randomUUID()}`;
    // Optional policy_sets relationship attaches this standalone policy to a set.
    let policySetId: string | null = null;
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const psRel = typeof rels["policy-sets"] === "object" && rels["policy-sets"] !== null ? (rels["policy-sets"] as Record<string, unknown>) : {};
    const psData = Array.isArray(psRel.data) ? (psRel.data as Record<string, string>[]) : [];
    if (psData.length > 0 && typeof psData[0]?.id === "string") {
      const targetSet = await db.query.policySets.findFirst({ where: eq(policySets.id, psData[0].id) });
      if (targetSet !== undefined && targetSet.orgId === org.id) policySetId = targetSet.id;
    }
    const createdAt = Date.now();
    await db.insert(policies).values({ id, orgId: org.id, policySetId, name, description, enforcementLevel, query, createdAt });
    (set as { status: number }).status = 201;
    return { data: await policyResource({ id, orgId: org.id, policySetId, policySetVersionId: null, name, description, enforcementLevel, query, source: null, sourcePath: null, createdAt }, org.name) };
  })
  .put("/api/v2/policies/:policy_id/upload", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    // go-tfe Policies.Upload PUTs the raw policy content to
    // /policies/:id/upload; store it as the policy body (`query`).
    const policyId = params.policy_id ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const resolvedOrgId = await resolvePolicyOrgId(pol);
    if (resolvedOrgId === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, resolvedOrgId) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    // VCS-backed policy sets own their policy content in the repository.
    const parentSet = pol.policySetId !== null ? await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) }) : undefined;
    if (parentSet !== undefined && parentSet.vcsRepo !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Policy content is managed by VCS" }] };
    }
    // Elysia has already consumed the raw request body into `body`; coerce it
    // to text without touching request.arrayBuffer() (would throw "already used").
    const content = typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : ArrayBuffer.isView(body)
          ? new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
          : body instanceof ArrayBuffer
            ? new TextDecoder().decode(body)
            : body === null || body === undefined
              ? ""
              : null;
    if (content === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Policy content must be uploaded as text or binary data" }] };
    }
    await db.update(policies).set({ query: content.trim() === "" ? null : content }).where(eq(policies.id, policyId));
    (set as { status: number }).status = 200;
    return {};
  })
  .get("/api/v2/policies/:policy_id/download", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Response | { errors: { status: string; title: string }[] }> => {
    // go-tfe Policies.Download GETs the raw policy content from
    // /policies/:id/download.
    const policyId = params.policy_id ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const resolvedOrgId = await resolvePolicyOrgId(pol);
    if (resolvedOrgId === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, resolvedOrgId) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "read-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return new Response(pol.query ?? "", { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  })
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

    // The org-global sets above were already loaded in full; only re-fetch the
    // direct/project-bound ids so we don't read the same policy_sets rows twice.
    const globalSetIds = new Set(globalSets.map((policySet: PsItem): string => policySet.id));
    const reFetchIds = effectiveIds.filter((policySetId: string): boolean => !globalSetIds.has(policySetId));
    const [reFetchedSets, effectivePolicies] = await Promise.all([
      reFetchIds.length === 0
        ? Promise.resolve([] as PsItem[])
        : db.query.policySets.findMany({ where: inArray(policySets.id, reFetchIds) }),
      db.query.policies.findMany({ where: inArray(policies.policySetId, effectiveIds) }),
    ]);
    const setsById = new Map<string, PsItem>();
    for (const policySet of globalSets) setsById.set(policySet.id, policySet);
    for (const policySet of reFetchedSets) setsById.set(policySet.id, policySet);
    const effectiveSets = effectiveIds
      .map((policySetId: string): PsItem | undefined => setsById.get(policySetId))
      .filter((policySet: PsItem | undefined): policySet is PsItem => policySet !== undefined);
    const policyCounts = new Map<string, number>();
    for (const policy of effectivePolicies) {
      if (policy.policySetId !== null) policyCounts.set(policy.policySetId, (policyCounts.get(policy.policySetId) ?? 0) + 1);
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
    if (psList.length === 0) return { data: [] };
    const psIds = psList.map((ps: PsItem): string => ps.id);
    // Batch the per-set relationships (workspaces/projects/exclusions/policies).
    const [wsRows, projRows, exclRows, policyRows] = await Promise.all([
      db.query.policySetWorkspaces.findMany({ where: inArray(policySetWorkspaces.policySetId, psIds) }),
      db.query.policySetProjects.findMany({ where: inArray(policySetProjects.policySetId, psIds) }),
      db.query.policySetExclusions.findMany({ where: inArray(policySetExclusions.policySetId, psIds) }),
      db.query.policies.findMany({ where: inArray(policies.policySetId, psIds), columns: { id: true, policySetId: true } }),
    ]);
    const projBySet = new Map<string, Readonly<{ projectId: string }>[]>();
    for (const link of projRows) {
      const list = projBySet.get(link.policySetId) ?? [];
      list.push(link);
      projBySet.set(link.policySetId, list);
    }
    const exclBySet = new Map<string, Readonly<{ workspaceId: string }>[]>();
    for (const link of exclRows) {
      const list = exclBySet.get(link.policySetId) ?? [];
      list.push(link);
      exclBySet.set(link.policySetId, list);
    }
    const wsBySet = new Map<string, Readonly<{ workspaceId: string }>[]>();
    for (const link of wsRows) {
      const list = wsBySet.get(link.policySetId) ?? [];
      list.push(link);
      wsBySet.set(link.policySetId, list);
    }
    const polBySet = new Map<string, Readonly<{ id: string }>[]>();
    for (const pol of policyRows) {
      if (pol.policySetId === null) continue;
      const list = polBySet.get(pol.policySetId) ?? [];
      list.push(pol);
      polBySet.set(pol.policySetId, list);
    }
    const data = psList.map((ps: PsItem): Record<string, unknown> => ({
      id: ps.id,
      type: "policy-sets",
      attributes: policySetAttributes(ps),
      relationships: {
        organization: { data: { id: org.name, type: "organizations" } },
        workspaces: { data: (wsBySet.get(ps.id) ?? []).map((l): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) },
        projects: { data: (projBySet.get(ps.id) ?? []).map((l): Record<string, string> => ({ id: l.projectId, type: "projects" })) },
        "workspace-exclusions": { data: (exclBySet.get(ps.id) ?? []).map((l): Record<string, string> => ({ id: l.workspaceId, type: "workspaces" })) },
        policies: { data: (polBySet.get(ps.id) ?? []).map((p): Record<string, string> => ({ id: p.id, type: "policies" })) },
      },
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
    // Attach any policy_ids supplied at create so the policies relationship
    // round-trips (otherwise the provider sees drift on every re-apply).
    if (Array.isArray(policyRelationship.data)) {
      const validPolicyIds = policyRelationship.data
        .map((ref: unknown): string => (ref !== null && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string" ? (ref as { id: string }).id : ""))
        .filter((pid: string): boolean => pid !== "");
      const validated = validPolicyIds.length === 0
        ? []
        : await db.query.policies.findMany({ where: and(eq(policies.orgId, org.id), inArray(policies.id, validPolicyIds)), columns: { id: true } });
      if (validated.length > 0) {
        await db.update(policies).set({ policySetId: id })
          .where(and(eq(policies.orgId, org.id), inArray(policies.id, validated.map((p): string => p.id))));
      }
    }
    (set as { status: number }).status = 201;
    return { data: { id, type: "policy-sets", attributes: policySetAttributes(created), relationships: await policySetRelationships(created) } };
  })
  .get("/api/v2/policy-sets/:policy_set_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ps.id, type: "policy-sets", attributes: policySetAttributes(ps), relationships: await policySetRelationships(ps) } };
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
    return { data: { id: updated.id, type: "policy-sets", attributes: policySetAttributes(updated), relationships: await policySetRelationships(updated) } };
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
  .post("/api/v2/policy-sets/:policy_set_id/relationships/policies", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (ps.vcsRepo !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const policyIds = extractPolicyRefIds(body);
    if (policyIds.length > 0) {
      await db.update(policies).set({ policySetId })
        .where(and(eq(policies.orgId, ps.orgId), inArray(policies.id, policyIds)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/policy-sets/:policy_set_id/relationships/policies", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policySetId = params.policy_set_id ?? "";
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policySetId) });
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const policyIds = extractPolicyRefIds(body);
    if (policyIds.length === 0) {
      // go-tfe's RemovePolicies with a set detaches everything when no ids given.
      await db.update(policies).set({ policySetId: null }).where(eq(policies.policySetId, policySetId));
    } else {
      await db.update(policies).set({ policySetId: null }).where(and(eq(policies.policySetId, policySetId), inArray(policies.id, policyIds)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
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
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
    if (!["advisory", "soft-mandatory", "hard-mandatory"].includes(enforcementLevel)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "enforcement-level must be advisory, soft-mandatory, or hard-mandatory" }] };
    }
    const query = typeof attributes.query === "string" ? attributes.query : (typeof attributes.policy === "string" ? attributes.policy : null);
    const createdAt = Date.now();
    await db.insert(policies).values({ id, orgId: ps.orgId, policySetId, name, description, enforcementLevel, query, createdAt });
    (set as { status: number }).status = 201;
    return { data: await policyResource({ id, orgId: ps.orgId, policySetId, policySetVersionId: null, name, description, enforcementLevel, query, source: null, sourcePath: null, createdAt }, await organizationName(ps.orgId)) };
  })
  .get("/api/v2/policies/:policy_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policyId = params.policy_id ?? "";
        const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
        if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
        const resolvedOrgId = await resolvePolicyOrgId(pol);
        if (resolvedOrgId === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
        const org = await db.query.organizations.findFirst({ where: eq(organizations.id, resolvedOrgId) });
        if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "read-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
        return { data: await policyResource(pol, org.name) };
  })
  .patch("/api/v2/policies/:policy_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const policyId = params.policy_id ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const resolvedOrgId = await resolvePolicyOrgId(pol);
    if (resolvedOrgId === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, resolvedOrgId) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = pol.policySetId !== null ? await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) }) : undefined;
    if (ps !== undefined && ps.vcsRepo !== null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof policies.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    if (attributes.policy !== undefined) updates.query = typeof attributes.policy === "string" ? attributes.policy : null;
    if (typeof attributes["enforcement-level"] === "string") {
      const lev = attributes["enforcement-level"];
      if (!["advisory", "soft-mandatory", "hard-mandatory"].includes(lev)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "enforcement-level must be advisory, soft-mandatory, or hard-mandatory" }] };
      }
      updates.enforcementLevel = lev;
    }
    if (Object.keys(updates).length > 0) await db.update(policies).set(updates).where(eq(policies.id, policyId));
    const updated = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await policyResource(updated as unknown as PolicyRow, org.name) };
  })
  .delete("/api/v2/policies/:policy_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const policyId = params.policy_id ?? "";
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policyId) });
    if (pol === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const resolvedOrgId = await resolvePolicyOrgId(pol);
    if (resolvedOrgId === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, resolvedOrgId) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ps = pol.policySetId !== null ? await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) }) : undefined;
    if (ps !== undefined && ps.vcsRepo !== null) {
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
    if (ps === undefined || !(await checkOrganizationPermission(ps.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-policies"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
