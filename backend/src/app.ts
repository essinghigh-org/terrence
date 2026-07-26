import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit } from "elysia-rate-limit";
import { db } from "./db";
import { users, apiTokens, organizations, workspaces, organizationMemberships, runs, logs, stateVersions, workspaceVariables, workspaceTags, configurationVersions, variableSets, variableSetWorkspaces, variableSetVariables } from "./db/schema";
import { and, eq, desc, asc, count, gte, inArray, like, lt, notInArray, or, sql } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { authPlugin } from "./auth";
import { oauthPlugin } from "./oauth";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { validateVersion } from "./binaryManager";
import { startWorkerQueue, executeRun, executeApply } from "./worker";
import { normalizeWorkingDirectory } from "./workspace";

// Initialize persistent worker queue loop
startWorkerQueue();

const CV_STORAGE_DIR = join(process.env.STORAGE_DIR || join(import.meta.dir, "../storage"), "cv");
const FRONTEND_INDEX = join(import.meta.dir, "../../frontend/dist/index.html");
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
const serveFrontend = () => Bun.file(FRONTEND_INDEX);

async function checkOrgPermission(
  userId: string | undefined,
  orgId: string,
  requiredRole: "owner" | "member" = "member",
  tokenOrgId: string | null = null,
): Promise<boolean> {
  if (tokenOrgId) return tokenOrgId === orgId && requiredRole === "member";
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

function validVariableAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attributes);
  const { key, value, category, sensitive, hcl, description } = attributes;
  return fields.every(field => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && (partial || value !== undefined)
    && (partial && key === undefined || typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || typeof hcl === "boolean")
    && (description === undefined || description === null || typeof description === "string");
}

function validVariableSetVariableAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const { key, value, category, sensitive, hcl, description } = attributes;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attributes);
  return fields.every(field => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && (partial && key === undefined || typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || hcl === false)
    && (description === undefined || description === null || typeof description === "string");
}

function validVariableSetAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const { name, description, global } = attributes;
  const fields = Object.keys(attributes);
  return fields.length > 0
    && fields.every(field => ["name", "description", "global"].includes(field))
    && (partial && name === undefined || typeof name === "string" && Boolean(name.trim()))
    && (description === undefined || description === null || typeof description === "string")
    && (global === undefined || typeof global === "boolean");
}

async function findAuthorizedVariableSet(
  variableSetId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
) {
  const variableSet = await db.query.variableSets.findFirst({ where: eq(variableSets.id, variableSetId) });
  return variableSet && await checkOrgPermission(userId, variableSet.orgId, "member", tokenOrgId)
    ? variableSet
    : undefined;
}

function variableSetVariableResource(variable: typeof variableSetVariables.$inferSelect) {
  return {
    id: variable.id,
    type: "vars",
    attributes: {
      key: variable.key,
      value: variable.sensitive ? null : variable.value,
      category: variable.category,
      sensitive: variable.sensitive,
      hcl: false,
      description: variable.description,
    },
    relationships: {
      varset: { data: { id: variable.variableSetId, type: "varsets" } },
    },
  };
}

function variableSetVariableUpdate(
  variable: typeof variableSetVariables.$inferSelect,
  attributes: any,
) {
  let sensitive = attributes.sensitive === undefined ? variable.sensitive : attributes.sensitive;
  if (variable.sensitive && sensitive === false && attributes.value === undefined) sensitive = true;
  return {
    key: attributes.key === undefined ? variable.key : attributes.key,
    value: attributes.value === undefined ? variable.value : attributes.value,
    category: attributes.category === undefined ? variable.category : attributes.category,
    sensitive,
    description: attributes.description === undefined ? variable.description : attributes.description,
  };
}

async function variableSetResource(variableSet: typeof variableSets.$inferSelect) {
  // ponytail: one pair of relationship queries per set; batch if large organizations make this measurable.
  const [workspaceLinks, variables] = await Promise.all([
    db.query.variableSetWorkspaces.findMany({
      where: eq(variableSetWorkspaces.variableSetId, variableSet.id),
    }),
    db.query.variableSetVariables.findMany({
      where: eq(variableSetVariables.variableSetId, variableSet.id),
    }),
  ]);
  return {
    id: variableSet.id,
    type: "varsets",
    attributes: {
      name: variableSet.name,
      description: variableSet.description,
      global: variableSet.global,
      "var-count": variables.length,
      "workspace-count": workspaceLinks.length,
    },
    relationships: {
      organization: { data: { id: variableSet.orgId, type: "organizations" } },
      parent: { data: { id: variableSet.orgId, type: "organizations" } },
      workspaces: {
        data: workspaceLinks.map(link => ({ id: link.workspaceId, type: "workspaces" })),
      },
      vars: {
        data: variables.map(variable => ({ id: variable.id, type: "vars" })),
      },
    },
    links: { self: `/api/v2/varsets/${variableSet.id}` },
  };
}

function workspaceRelationshipIds(body: unknown) {
  const data = (body as any)?.data;
  if (!Array.isArray(data) || data.length === 0) return;
  if (data.some(item => item?.type !== "workspaces" || typeof item?.id !== "string" || !item.id)) return;
  return [...new Set(data.map(item => item.id as string))];
}

function variableRelationshipResources(body: unknown) {
  const data = (body as any)?.data;
  const many = Array.isArray(data);
  const resources = many ? data : [data];
  if (
    resources.length === 0
    || resources.some(item => item?.type !== "vars" || typeof item?.id !== "string" || !item.id)
    || new Set(resources.map(item => item.id)).size !== resources.length
  ) return;
  return { many, resources };
}

function isUniqueConstraintError(error: any) {
  return [error, error?.cause].some(item =>
    item?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || item?.message?.includes("UNIQUE constraint failed")
  );
}

async function findWorkspaceByName(orgId: string, name: string) {
  return db.query.workspaces.findFirst({
    where: and(eq(workspaces.orgId, orgId), eq(workspaces.name, name)),
  });
}

async function findAuthorizedWorkspace(
  workspaceId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
) {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  return workspace && await checkOrgPermission(userId, workspace.orgId, "member", tokenOrgId)
    ? workspace
    : undefined;
}

async function findAuthorizedRun(runId: string, userId: string | undefined, tokenOrgId: string | null) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return;
  const workspace = await findAuthorizedWorkspace(run.workspaceId, userId, tokenOrgId);
  return workspace ? { run, workspace } : undefined;
}

async function findLogCapability(runId: string, token: string) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run || !run.logToken) return;
  const expected = Buffer.from(run.logToken);
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? run : undefined;
}

async function workspaceResource(
  workspace: typeof workspaces.$inferSelect,
  defaultIacBinary: string | null | undefined,
  canRun: boolean,
) {
  // ponytail: one tag query per serialized workspace; batch if large workspace lists make this measurable.
  const tags = await db.query.workspaceTags.findMany({
    where: eq(workspaceTags.workspaceId, workspace.id),
    orderBy: [asc(workspaceTags.key)],
  });
  return {
    id: workspace.id,
    type: "workspaces",
    attributes: {
      actions: { "is-destroyable": canRun },
      "allow-destroy-plan": true,
      name: workspace.name,
      description: workspace.description,
      "auto-apply": workspace.autoApply,
      "terraform-version": workspace.terraformVersion,
      "working-directory": workspace.workingDirectory,
      "source-name": workspace.sourceName,
      "source-url": workspace.sourceUrl,
      "tag-names": tags.map(tag => tag.key),
      "iac-binary": workspace.iacBinary || defaultIacBinary || "tofu",
      "execution-mode": "remote",
      locked: workspace.locked,
      "locked-reason": workspace.locked ? "Locked manually" : null,
      operations: true,
      permissions: {
        "can-destroy": canRun,
        "can-force-unlock": canRun,
        "can-lock": canRun,
        "can-manage-run-tasks": false,
        "can-queue-apply": canRun,
        "can-queue-destroy": canRun,
        "can-queue-run": canRun,
        "can-read-settings": true,
        "can-read-state-versions": true,
        "can-read-variable": true,
        "can-unlock": canRun,
        "can-update": canRun,
        "can-update-variable": canRun,
        "can-force-delete": canRun,
      },
      source: "tfe-api",
      "structured-run-output-enabled": false,
    },
    relationships: {
      organization: {
        data: { id: workspace.orgId, type: "organizations" },
      },
      "tag-bindings": {
        links: { related: `/api/v2/workspaces/${workspace.id}/tag-bindings` },
      },
      "effective-tag-bindings": {
        links: { related: `/api/v2/workspaces/${workspace.id}/effective-tag-bindings` },
      },
    },
  };
}

function tagBindingResource(tag: typeof workspaceTags.$inferSelect, effective = false) {
  return {
    id: tag.id,
    type: effective ? "effective-tag-bindings" : "tag-bindings",
    attributes: { key: tag.key, value: tag.value || "" },
  };
}

function parseTagBindings(data: unknown) {
  if (!Array.isArray(data)) return;
  const bindings = new Map<string, { key: string; value: string }>();
  for (const item of data) {
    const { key, value = "" } = item?.attributes || {};
    if (item?.type !== "tag-bindings" || typeof key !== "string" || !key.trim() || typeof value !== "string") {
      return;
    }
    bindings.set(key.trim(), { key: key.trim(), value });
  }
  return [...bindings.values()];
}

async function deleteWorkspaceData(workspaceId: string) {
  await db.transaction(async (tx) => {
    const wsRuns = await tx.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) });
    const runIds = wsRuns.map(run => run.id);
    if (runIds.length > 0) {
      await tx.delete(logs).where(inArray(logs.runId, runIds));
      await tx.delete(runs).where(eq(runs.workspaceId, workspaceId));
    }
    await tx.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await tx.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await tx.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId));
    await tx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspaceId));
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });
}

async function safeDeleteWorkspace(workspaceId: string) {
  const state = await db.query.stateVersions.findFirst({
    where: eq(stateVersions.workspaceId, workspaceId),
    orderBy: [desc(stateVersions.serial)],
  });

  if (state?.statePayload) {
    try {
      const resources = JSON.parse(decodeStatePayload(state.statePayload))?.resources;
      if (Array.isArray(resources) && resources.some(resource => resource?.mode === "managed")) return false;
    } catch {
      return false;
    }
  }

  await deleteWorkspaceData(workspaceId);
  return true;
}

async function updateWorkspaceResponse(
  workspace: typeof workspaces.$inferSelect,
  defaultIacBinary: string | null | undefined,
  canRun: boolean,
  body: unknown,
  set: any,
) {
  const attributes = (body as any)?.data?.attributes || {};
  const rawTagBindings = (body as any)?.data?.relationships?.["tag-bindings"]?.data;
  const tagBindings = rawTagBindings === undefined ? undefined : parseTagBindings(rawTagBindings);
  const {
    name,
    description,
    "auto-apply": autoApply,
    "terraform-version": terraformVersion,
    "working-directory": workingDirectory,
    "source-name": sourceName,
    "source-url": sourceUrl,
    "iac-binary": iacBinary,
    "execution-mode": executionMode,
  } = attributes;

  if (rawTagBindings !== undefined && tagBindings === undefined) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] };
  }
  if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] };
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] };
  }
  if (
    (sourceName !== undefined && sourceName !== null && typeof sourceName !== "string")
    || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")
  ) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-name and source-url must be strings or null" }] };
  }
  if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
  }
  if (executionMode !== undefined && executionMode !== "remote") {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] };
  }
  if (iacBinary !== undefined && iacBinary !== null && !["tofu", "terraform"].includes(iacBinary)) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] };
  }

  let normalizedWorkingDirectory = workspace.workingDirectory;
  if (workingDirectory !== undefined) {
    try {
      normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);
    } catch (error: any) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error.message }] };
    }
  }

  if (name !== undefined && name !== workspace.name) {
    const duplicate = await findWorkspaceByName(workspace.orgId, name);
    if (duplicate && duplicate.id !== workspace.id) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] };
    }
  }

  const updated = {
    name: name ?? workspace.name,
    description: description !== undefined ? description : workspace.description,
    autoApply: autoApply !== undefined ? autoApply : workspace.autoApply,
    terraformVersion: terraformVersion ?? workspace.terraformVersion,
    workingDirectory: normalizedWorkingDirectory,
    sourceName: sourceName !== undefined ? sourceName : workspace.sourceName,
    sourceUrl: sourceUrl !== undefined ? sourceUrl : workspace.sourceUrl,
    iacBinary: iacBinary !== undefined ? iacBinary : workspace.iacBinary,
  };

  await db.update(workspaces).set(updated).where(eq(workspaces.id, workspace.id));
  if (tagBindings) {
    await db.transaction(async tx => {
      await tx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspace.id));
      if (tagBindings.length > 0) {
        await tx.insert(workspaceTags).values(tagBindings.map(binding => ({
          id: crypto.randomUUID(),
          workspaceId: workspace.id,
          ...binding,
        })));
      }
    });
  }
  return { data: await workspaceResource({ ...workspace, ...updated }, defaultIacBinary, canRun) };
}

function userResource(user: { id: string; username: string; email?: string | null }, authenticatedResource = { id: user.id, type: "users" }) {
  return {
    id: user.id,
    type: "users",
    attributes: {
      username: user.username,
      email: user.email ?? null,
      "is-service-account": authenticatedResource.type !== "users",
      "auth-method": "local",
      "avatar-url": null,
      "v2-only": false,
      permissions: {
        "can-create-organizations": authenticatedResource.type === "users",
        "can-change-email": authenticatedResource.type === "users",
        "can-change-username": authenticatedResource.type === "users",
      },
    },
    relationships: {
      "authentication-tokens": {
        links: { related: `/api/v2/users/${user.id}/authentication-tokens` },
      },
      "authenticated-resource": {
        data: authenticatedResource,
        links: { related: `/api/v2/${authenticatedResource.type}/${authenticatedResource.id}` },
      },
    },
    links: { self: `/api/v2/users/${user.id}` },
  };
}

function tokenResource(token: typeof apiTokens.$inferSelect, includeSecret = false) {
  const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();

  return {
    id: token.id,
    type: "authentication-tokens",
    attributes: {
      "created-at": iso(token.createdAt),
      "last-used-at": iso(token.lastUsedAt),
      description: token.description,
      token: includeSecret ? token.token : null,
      "expired-at": iso(token.expiresAt),
    },
    relationships: {
      "created-by": {
        data: token.userId ? { id: token.userId, type: "users" } : null,
      },
    },
  };
}

function tokenExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return Number.NaN;
  return Date.parse(value);
}

function organizationResource(org: typeof organizations.$inferSelect) {
  const name = encodeURIComponent(org.name);
  return {
    id: org.id,
    type: "organizations",
    attributes: {
      name: org.name,
      "external-id": org.id,
      email: null,
      "session-timeout": null,
      "session-remember": null,
      "collaborator-auth-policy": "password",
      "cost-estimation-enabled": false,
      "send-passing-statuses-for-untriggered-speculative-plans": false,
      "aggregated-commit-status-enabled": false,
      "speculative-plan-management-enabled": true,
      "allow-force-delete-workspaces": true,
      "default-execution-mode": "remote",
      "user-tokens-enabled": true,
      "default-iac-binary": org.defaultIacBinary ?? "tofu",
      "default-terraform-version": org.defaultTerraformVersion ?? "latest",
    },
    relationships: {
      "oauth-tokens": { links: { related: `/api/v2/organizations/${name}/oauth-tokens` } },
      "authentication-token": { links: { related: `/api/v2/organizations/${name}/authentication-token` } },
      "entitlement-set": { links: { related: `/api/v2/organizations/${name}/entitlement-set` } },
      subscription: { links: { related: `/api/v2/organizations/${name}/subscription` } },
      "default-agent-pool": { data: null },
    },
    links: { self: `/api/v2/organizations/${name}` },
  };
}

function pageRequest(request: Request) {
  const params = new URL(request.url).searchParams;
  const number = Number.parseInt(params.get("page[number]") ?? "1", 10);
  const size = Number.parseInt(params.get("page[size]") ?? "20", 10);
  return {
    number: Number.isSafeInteger(number) && number > 0 ? number : 1,
    size: Number.isSafeInteger(size) && size > 0 ? Math.min(size, 100) : 20,
  };
}

function pagination(request: Request, currentPage: number, pageSize: number, totalCount: number) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const pageLink = (page: number) => {
    const url = new URL(request.url);
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("page[size]", String(pageSize));
    return url.toString();
  };

  return {
    links: {
      self: pageLink(currentPage),
      first: pageLink(1),
      prev: currentPage > 1 ? pageLink(currentPage - 1) : null,
      next: currentPage < totalPages ? pageLink(currentPage + 1) : null,
      last: pageLink(Math.max(1, totalPages)),
    },
    meta: {
      pagination: {
        "current-page": currentPage,
        "page-size": pageSize,
        "prev-page": currentPage > 1 ? currentPage - 1 : null,
        "next-page": currentPage < totalPages ? currentPage + 1 : null,
        "total-pages": totalPages,
        "total-count": totalCount,
      },
    },
  };
}

function apiURL(request: Request, path: string) {
  return new URL(path, PUBLIC_URL || request.url).toString();
}

function decodeStatePayload(state: unknown) {
  if (typeof state !== "string") return JSON.stringify(state);
  try {
    JSON.parse(state);
    return state;
  } catch {
    try {
      const decoded = Buffer.from(state, "base64").toString("utf8");
      JSON.parse(decoded);
      return decoded;
    } catch {
      return state;
    }
  }
}

function parseStatePayload(payload: string | null) {
  try {
    const state = JSON.parse(payload || "{}");
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

function stateOutputResources(state: typeof stateVersions.$inferSelect) {
  const outputs = parseStatePayload(state.statePayload)?.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return [];

  return Object.entries(outputs).map(([name, raw]) => {
    const id = `wsout-${createHash("sha256").update(`${state.id}\0${name}`).digest("hex").slice(0, 16)}`;
    const output = raw && typeof raw === "object" ? raw as any : { value: raw };
    const value = output.value;
    const detailedType = output.type ?? (
      Array.isArray(value) ? ["tuple", value.map(item => typeof item)] :
      value === null ? "null" :
      typeof value === "object" ? "object" :
      typeof value
    );
    const type = typeof detailedType === "string"
      ? detailedType
      : Array.isArray(value) ? "array" : "object";

    return {
      id,
      type: "state-version-outputs",
      attributes: {
        name,
        value,
        sensitive: output.sensitive === true,
        type,
        "detailed-type": detailedType,
      },
      links: {
        self: `/api/v2/state-version-outputs/${id}`,
      },
    };
  });
}

function stateVersionResource(
  state: typeof stateVersions.$inferSelect,
  request: Request,
  includeState = false,
) {
  const parsed = parseStatePayload(state.statePayload);
  const rawResources = Array.isArray(parsed?.resources) ? parsed.resources : [];
  const resources = rawResources
    .filter(resource => resource && typeof resource.type === "string" && typeof resource.name === "string")
    .map(resource => ({
      name: resource.name,
      type: `${resource.mode === "data" ? "data." : ""}${resource.type}`,
      count: Array.isArray(resource.instances) ? resource.instances.length : 0,
      module: typeof resource.module === "string" ? resource.module : "root",
      provider: typeof resource.provider === "string" ? resource.provider : null,
    }));
  const modules: Record<string, Record<string, number>> = {};
  const providers: Record<string, Record<string, number>> = {};

  for (const resource of resources) {
    const kind = resource.type.replaceAll("_", "-");
    modules[resource.module] ||= {};
    modules[resource.module][kind] = (modules[resource.module][kind] || 0) + resource.count;
    if (resource.provider) {
      providers[resource.provider] ||= {};
      providers[resource.provider][kind] = (providers[resource.provider][kind] || 0) + resource.count;
    }
  }

  const outputResources = stateOutputResources(state);
  const payload = state.statePayload || "";
  return {
    id: state.id,
    type: "state-versions",
    attributes: {
      ...(includeState ? { state: state.statePayload } : {}),
      serial: state.serial,
      md5: createHash("md5").update(payload).digest("hex"),
      lineage: typeof parsed?.lineage === "string" ? parsed.lineage : null,
      "terraform-version": typeof parsed?.terraform_version === "string" ? parsed.terraform_version : null,
      "resources-processed": parsed !== null,
      resources,
      modules,
      providers,
      "state-version": Number.isInteger(parsed?.version) ? parsed.version : null,
      status: "finalized",
      intermediate: false,
      size: Buffer.byteLength(payload),
      "vcs-commit-sha": null,
      "vcs-commit-url": null,
      "hosted-state-download-url": apiURL(request, `/api/v2/state-versions/${state.id}/download`),
      "hosted-state-upload-url": null,
      "hosted-json-state-upload-url": null,
    },
    relationships: {
      workspace: { data: { id: state.workspaceId, type: "workspaces" } },
      run: { data: null },
      outputs: {
        data: outputResources.map(output => ({ id: output.id, type: output.type })),
      },
    },
    links: { self: `/api/v2/state-versions/${state.id}` },
  };
}

const FINAL_RUN_STATUSES = [
  "applied",
  "planned_and_finished",
  "policy_soft_failed",
  "discarded",
  "errored",
  "canceled",
  "force_canceled",
];
const CAPACITY_PENDING_STATUSES = ["pending", "queuing", "plan_queued", "apply_queued"];
const CAPACITY_RUNNING_STATUSES = ["planning", "applying"];
const DISCARDABLE_RUN_STATUSES = [
  "planned",
  "planned_and_saved",
  "cost_estimated",
  "policy_checked",
  "policy_override",
  "post_plan_running",
  "post_plan_completed",
];

function workspaceRunHistoryWhere(request: Request, workspaceId: string) {
  const params = new URL(request.url).searchParams;
  const csv = (name: string) => params.get(name)?.split(",").map(value => value.trim()).filter(Boolean);
  const conditions = [eq(runs.workspaceId, workspaceId)];
  const statuses = csv("filter[status]");
  if (statuses?.length) conditions.push(inArray(runs.status, statuses));

  const operations = csv("filter[operation]");
  if (operations?.length) {
    const destroy = operations.includes("destroy");
    const planAndApply = operations.includes("plan_and_apply");
    if (destroy !== planAndApply) conditions.push(eq(runs.isDestroy, destroy));
    else if (!destroy) conditions.push(sql`false`);
  }

  const sources = csv("filter[source]");
  if (sources?.length && !sources.includes("tfe-api")) conditions.push(sql`false`);

  const statusGroup = params.get("filter[status_group]");
  if (statusGroup === "final") conditions.push(inArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "non_final") conditions.push(notInArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "discardable") conditions.push(inArray(runs.status, DISCARDABLE_RUN_STATUSES));
  else if (statusGroup) conditions.push(sql`false`);

  const timeframe = params.get("filter[timeframe]");
  if (timeframe === "year") {
    conditions.push(gte(runs.createdAt, Date.now() - 365 * 24 * 60 * 60 * 1000));
  } else if (timeframe && /^\d{4}$/.test(timeframe)) {
    const year = Number(timeframe);
    conditions.push(gte(runs.createdAt, Date.UTC(year, 0, 1)));
    conditions.push(lt(runs.createdAt, Date.UTC(year + 1, 0, 1)));
  } else if (timeframe) {
    conditions.push(sql`false`);
  }

  const basic = params.get("search[basic]")?.trim();
  if (basic) conditions.push(or(like(runs.id, `%${basic}%`), like(runs.message, `%${basic}%`))!);
  return and(...conditions)!;
}

function runResource(run: typeof runs.$inferSelect, canRun: boolean) {
  const isPlanned = run.status === "planned";
  const isRunning = ["pending", "planning", "applying"].includes(run.status);
  const hasChanges = ["planned", "planned_and_finished", "applying", "applied"].includes(run.status);

  return {
    id: run.id,
    type: "runs",
    attributes: {
      actions: {
        "is-cancelable": canRun && isRunning,
        "is-confirmable": canRun && isPlanned,
        "is-discardable": canRun && isPlanned,
        "is-force-cancelable": canRun && isRunning,
      },
      "auto-apply": run.autoApply,
      "has-changes": hasChanges,
      message: run.message,
      operation: run.isDestroy
        ? "destroy"
        : run.refreshOnly
          ? "refresh_only"
          : run.planOnly
            ? "plan_only"
            : "plan_and_apply",
      "plan-only": run.planOnly,
      refresh: run.refresh,
      "refresh-only": run.refreshOnly,
      "replace-addrs": run.replaceAddrs,
      source: "tfe-api",
      status: run.status,
      "target-addrs": run.targetAddrs,
      "terraform-version": run.terraformVersion,
      "debugging-mode": run.debuggingMode,
      "is-destroy": run.isDestroy,
      "created-at": new Date(run.createdAt).toISOString(),
      "trigger-reason": "manual",
      variables: run.variables || [],
      permissions: {
        "can-apply": canRun && isPlanned,
        "can-cancel": canRun && isRunning,
        "can-discard": canRun && isPlanned,
        "can-force-cancel": canRun && isRunning,
        "can-force-execute": false,
        "can-override-policy-check": false,
      },
    },
    relationships: {
      workspace: {
        data: { id: run.workspaceId, type: "workspaces" },
        links: { related: `/api/v2/workspaces/${run.workspaceId}` },
      },
      "configuration-version": {
        data: run.configurationVersionId
          ? { id: run.configurationVersionId, type: "configuration-versions" }
          : null,
        links: run.configurationVersionId
          ? { related: `/api/v2/configuration-versions/${run.configurationVersionId}` }
          : undefined,
      },
      plan: {
        data: { id: `plan-${run.id}`, type: "plans" },
        links: { related: `/api/v2/runs/${run.id}/plan` },
      },
      apply: {
        data: { id: `apply-${run.id}`, type: "applies" },
        links: { related: `/api/v2/applies/apply-${run.id}` },
      },
      "run-events": {
        links: { related: `/api/v2/runs/${run.id}/run-events` },
      },
      "created-by": {
        data: run.createdBy ? { id: run.createdBy, type: "users" } : null,
      },
    },
  };
}

function planResource(run: typeof runs.$inferSelect, request: Request) {
  const status = run.status === "planning"
    ? "running"
    : ["planned", "planned_and_finished", "applying", "applied"].includes(run.status)
      ? "finished"
      : run.status === "errored"
        ? "errored"
        : ["canceled", "discarded", "force_canceled"].includes(run.status)
          ? "canceled"
          : "pending";

  return {
    id: `plan-${run.id}`,
    type: "plans",
    attributes: {
      status,
      "has-changes": ["planned", "planned_and_finished", "applying", "applied"].includes(run.status),
      "generated-configuration": false,
      "execution-details": { mode: "remote" },
      "log-read-url": run.logToken ? apiURL(request, `/api/v2/runs/${run.id}/plan/log/${run.logToken}`) : null,
    },
  };
}

function applyResource(run: typeof runs.$inferSelect, request: Request) {
  const status = run.status === "applying"
    ? "running"
    : run.status === "applied"
      ? "finished"
      : run.status === "errored"
        ? "errored"
        : ["canceled", "discarded", "force_canceled"].includes(run.status)
          ? "canceled"
          : "pending";

  return {
    id: `apply-${run.id}`,
    type: "applies",
    attributes: {
      status,
      "log-read-url": run.logToken ? apiURL(request, `/api/v2/runs/${run.id}/apply/log/${run.logToken}`) : null,
    },
  };
}

function logChunk(output: string, request: Request) {
  const params = new URL(request.url).searchParams;
  const parsedOffset = Number.parseInt(params.get("offset") || "0", 10);
  const parsedLimit = Number.parseInt(params.get("limit") || "", 10);
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const bytes = Buffer.from(output);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : bytes.length;
  return bytes.subarray(offset, offset + limit);
}

export const app = new Elysia()
  .use(authPlugin)
  .use(rateLimit({
    max: 30,
    duration: 1000,
    generator: async (request, server) => {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (bearer) {
        return `token:${Bun.hash(bearer)}`;
      }
      return `ip:${server?.requestIP(request)?.address || "unknown"}`;
    },
  }))
  .use(oauthPlugin)
  .onRequest(({ set }) => {
    const allowOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === "production" ? undefined : "*");
    if (allowOrigin) {
      set.headers["Access-Control-Allow-Origin"] = allowOrigin;
    }
    set.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    set.headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    set.headers["Access-Control-Expose-Headers"] = "TFP-API-Version,X-RateLimit-Limit,X-RateLimit-Remaining";
  })
  .onAfterHandle(({ request, response, set }) => {
    const isJsonDocument = response !== null
      && typeof response === "object"
      && (Array.isArray(response) || Object.getPrototypeOf(response) === Object.prototype);
    if (new URL(request.url).pathname.startsWith("/api/") && isJsonDocument) {
      set.headers["Content-Type"] = "application/vnd.api+json";
    }
    const limit = set.headers["RateLimit-Limit"];
    const remaining = set.headers["RateLimit-Remaining"];
    if (limit) set.headers["X-RateLimit-Limit"] = limit;
    if (remaining) set.headers["X-RateLimit-Remaining"] = remaining;
  })
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
  .get("/login", serveFrontend)
  .get("/register", serveFrontend)
  .get("/app", serveFrontend)
  .get("/app/*", serveFrontend)
  .options("/*", ({ set }) => {
    set.status = 204;
  })
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
    "login.v1": {
      client: "terraform-cli",
      grant_types: ["authz_code"],
      authz: "/oauth/authorization",
      token: "/oauth/token",
      ports: [10000, 10010],
    },
    "tfe.v2": "/api/v2/",
    "tfe.v2.1": "/api/v2/",
    "tfe.v2.2": "/api/v2/",
    "state.v2": "/api/v2/",
  }))
  .get("/api", () => "Terrence API")
  .get("/api/v2/ping", ({ set }) => {
    set.headers["TFP-API-Version"] = "2.5";
    set.headers["TFP-AppName"] = "Terraform Enterprise";
    return {};
  })
  .get("/healthz", () => "ok")
  .get("/readyz", async ({ set }) => {
    try {
      await db.query.users.findFirst();
      return "ready";
    } catch {
      set.status = 503;
      return "not ready";
    }
  })
  .get("/api/v1/ping", () => "pong", { isAuth: true })
  .get("/api/v1/readiness", async ({ set }) => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      set.status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/health/readiness", async ({ set }) => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      set.status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/metadata", () => ({
    version: process.env.BUILD_VERSION || "dev",
    build: process.env.BUILD_SHA || "unknown",
  }), { isAuth: true })
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
      description: "User login token",
      createdAt: Date.now(),
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
    const { username, password, email } = payload?.data?.attributes || {};

    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    if (password.length < 10) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Password must be at least 10 characters" }] };
    }
    if (email !== undefined && email !== null && typeof email !== "string") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string" }] };
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
    const normalizedEmail = typeof email === "string" && email.trim() ? email.trim() : null;

    try {
      await db.insert(users).values({ id, username, email: normalizedEmail, passwordHash });
      set.status = 201;
      return {
        data: {
          id,
          type: "users",
          attributes: { username, email: normalizedEmail }
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
  .get("/api/v2/account/details", async ({ user, orgId, set }) => {
    if (user) return { data: userResource(user) };

    const org = orgId
      ? await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })
      : null;
    if (!org) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const synthetic = { id: `service-user-${org.id}`, username: `${org.name}-service-user` };
    return { data: userResource(synthetic, { id: org.id, type: "organizations" }) };
  }, { isAuth: true })
  .patch("/api/v2/account/update", async ({ user, body, set }) => {
    if (!user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes;
    if (!attributes || typeof attributes !== "object") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    const changes: { username?: string; email?: string | null } = {};
    if (Object.hasOwn(attributes, "username")) {
      if (typeof attributes.username !== "string" || !attributes.username.trim()) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username cannot be empty" }] };
      }
      changes.username = attributes.username.trim();
    }
    if (Object.hasOwn(attributes, "email")) {
      if (attributes.email !== null && (typeof attributes.email !== "string" || !attributes.email.trim())) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string or null" }] };
      }
      changes.email = attributes.email === null ? null : attributes.email.trim();
    }
    if (Object.keys(changes).length === 0) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No account fields provided" }] };
    }

    try {
      await db.update(users).set(changes).where(eq(users.id, user.id));
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        set.status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Username is already in use" }] };
      }
      throw error;
    }

    return { data: userResource({ ...user, ...changes }) };
  }, { isAuth: true })
  .patch("/api/v2/account/password", async ({ user, body, set }) => {
    if (!user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes || {};
    const currentPassword = attributes.current_password ?? attributes["current-password"];
    const password = attributes.password;
    const confirmation = attributes.password_confirmation ?? attributes["password-confirmation"];
    if (!currentPassword || !password || password !== confirmation || password.length < 10) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid password change request" }] };
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Current password is incorrect" }] };
    }

    await db.update(users).set({ passwordHash: await bcrypt.hash(password, 10) }).where(eq(users.id, user.id));
    return { data: userResource(user) };
  }, { isAuth: true })
  .get("/api/v2/users/:user_id", async ({ params: { user_id }, user, set }) => {
    if (!user || user.id !== user_id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: userResource(user) };
  }, { isAuth: true })
  .get("/api/v2/users/:user_id/authentication-tokens", async ({ params: { user_id }, user, request, set }) => {
    const target = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!target || !user || user.id !== user_id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);

    const where = eq(apiTokens.userId, user_id);
    const [tokens, [{ total }]] = await Promise.all([
      db.query.apiTokens.findMany({
        where,
        orderBy: [desc(apiTokens.createdAt)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(apiTokens).where(where),
    ]);
    return {
      data: tokens.map(token => tokenResource(token)),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/authentication-tokens/:token_id", async ({ params: { token_id }, user, set }) => {
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, token_id) });
    if (!token || !user || token.userId !== user.id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  }, { isAuth: true })
  .delete("/api/v2/authentication-tokens/:token_id", async ({ params: { token_id }, user, set }) => {
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, token_id) });
    if (!token || !user || token.userId !== user.id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(eq(apiTokens.id, token_id));
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/tokens", async ({ body, user, set }) => {
    if (!user) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const description = attributes.description ?? "API token";
    const orgId = payload?.data?.relationships?.organization?.data?.id;
    const expiresAt = tokenExpiry(attributes["expired-at"]);

    if (typeof description !== "string" || (orgId !== undefined && typeof orgId !== "string") || Number.isNaN(expiresAt)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    if (orgId) {
      if (!(await checkOrgPermission(user.id, orgId, "owner"))) {
        set.status = 403;
        return { errors: [{ status: "403", title: "Forbidden" }] };
      }
    }

    const createdToken: typeof apiTokens.$inferSelect = {
      id: crypto.randomUUID(),
      token: `${orgId ? "org" : "user"}-${crypto.randomUUID()}`,
      userId: orgId ? null : user.id,
      orgId: orgId || null,
      description,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
    };

    if (orgId) {
      await db.transaction(async tx => {
        await tx.delete(apiTokens).where(eq(apiTokens.orgId, orgId));
        await tx.insert(apiTokens).values(createdToken);
      });
    } else {
      await db.insert(apiTokens).values(createdToken);
    }

    set.status = 201;
    return { data: tokenResource(createdToken, true) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.orgId, org.id) });
    if (!token) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, body, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes || {};
    const expiresAt = tokenExpiry(attributes["expired-at"]);
    if (Number.isNaN(expiresAt)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    const createdToken: typeof apiTokens.$inferSelect = {
      id: crypto.randomUUID(),
      token: `org-${crypto.randomUUID()}`,
      userId: null,
      orgId: org.id,
      description: null,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
    };
    await db.transaction(async tx => {
      await tx.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
      await tx.insert(apiTokens).values(createdToken);
    });

    set.status = 201;
    return { data: tokenResource(createdToken, true) };
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    await db.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
    set.status = 204;
  }, { isAuth: true })
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
        const org = {
          id,
          name,
          defaultIacBinary,
          defaultTerraformVersion: defaultTerraformVersion.trim(),
        };
        await db.transaction(async tx => {
          await tx.insert(organizations).values(org);
          await tx.insert(organizationMemberships).values({
            id: crypto.randomUUID(),
            userId: user.id,
            orgId: id,
            role: "owner",
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
  }, { isAuth: true })
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
      db.query.organizations.findMany({
        where,
        orderBy: [asc(organizations.name)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(organizations).where(where),
    ]);
    return {
      data: orgs.map(organizationResource),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });

    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
        set.status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return { data: organizationResource(org) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/entitlement-set", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return {
      data: {
        id: org.id,
        type: "entitlement-sets",
        attributes: {
          operations: true,
          "state-storage": true,
          teams: true,
          "vcs-integrations": false,
          "policy-enforcement": false,
          "cost-estimation": false,
          "private-module-registry": false,
          agents: false,
          sso: false,
          "run-tasks": false,
          "audit-logging": false,
          "self-serve-billing": false,
          "user-limit": null,
        },
        links: { self: `/api/v2/entitlement-sets/${org.id}` },
      },
    };
  }, { isAuth: true })
  .patch("/api/v2/organizations/:org_name", async ({ params: { org_name }, body, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
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
      const updated = {
        ...org,
        name: newName,
        defaultIacBinary,
        defaultTerraformVersion: defaultTerraformVersion.trim(),
      };
      await db.update(organizations).set({
        name: updated.name,
        defaultIacBinary: updated.defaultIacBinary,
        defaultTerraformVersion: updated.defaultTerraformVersion,
      }).where(eq(organizations.id, org.id));
      return { data: organizationResource(updated) };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
        set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
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
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/varsets", async ({ params: { org_name }, user, orgId, request, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const search = new URL(request.url).searchParams.get("q")?.trim();
    const scope = eq(variableSets.orgId, org.id);
    const where = search ? and(scope, like(variableSets.name, `%${search}%`)) : scope;
    const [records, [{ total }]] = await Promise.all([
      db.query.variableSets.findMany({
        where,
        orderBy: [asc(variableSets.name)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(variableSets).where(where),
    ]);
    return {
      data: await Promise.all(records.map(variableSetResource)),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/varsets", async ({ params: { org_name }, user, orgId, body, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "varsets" || !validVariableSetAttributes(attributes)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }

    const record = {
      id: `varset-${crypto.randomUUID()}`,
      orgId: org.id,
      name: attributes.name.trim(),
      description: attributes.description ?? null,
      global: attributes.global ?? false,
    };
    await db.insert(variableSets).values(record);
    set.status = 201;
    return { data: await variableSetResource(record) };
  }, { isAuth: true })
  .get("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: await variableSetResource(record) };
  }, { isAuth: true })
  .patch("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "varsets" || !validVariableSetAttributes(attributes, true)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }

    const updated = {
      name: attributes.name === undefined ? record.name : attributes.name.trim(),
      description: attributes.description === undefined ? record.description : attributes.description,
      global: attributes.global === undefined ? record.global : attributes.global,
    };
    await db.update(variableSets).set(updated).where(eq(variableSets.id, record.id));
    return { data: await variableSetResource({ ...record, ...updated }) };
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(variableSets).where(eq(variableSets.id, record.id));
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] };
    }
    const targets = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (targets.length !== workspaceIds.length || targets.some(workspace => workspace.orgId !== record.orgId)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Workspaces must belong to the variable set organization" }] };
    }

    await db.insert(variableSetWorkspaces).values(workspaceIds.map(workspaceId => ({
      id: crypto.randomUUID(),
      variableSetId: record.id,
      workspaceId,
    }))).onConflictDoNothing();
    set.status = 204;
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] };
    }
    const targets = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (targets.length !== workspaceIds.length || targets.some(workspace => workspace.orgId !== record.orgId)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Workspaces must belong to the variable set organization" }] };
    }

    await db.delete(variableSetWorkspaces).where(and(
      eq(variableSetWorkspaces.variableSetId, record.id),
      inArray(variableSetWorkspaces.workspaceId, workspaceIds),
    ));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, request, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const where = eq(variableSetVariables.variableSetId, record.id);
    const [variables, [{ total }]] = await Promise.all([
      db.query.variableSetVariables.findMany({
        where,
        orderBy: [asc(variableSetVariables.key)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(variableSetVariables).where(where),
    ]);
    return {
      data: variables.map(variableSetVariableResource),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record
      ? await db.query.variableSetVariables.findFirst({
          where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)),
        })
      : undefined;
    if (!variable) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: variableSetVariableResource(variable) };
  }, { isAuth: true })
  .post("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

    const variable = {
      id: `var-${crypto.randomUUID()}`,
      variableSetId: record.id,
      key: attributes.key,
      value: attributes.value ?? "",
      category: attributes.category ?? "terraform",
      sensitive: attributes.sensitive ?? false,
      description: attributes.description ?? null,
    };
    try {
      await db.insert(variableSetVariables).values(variable);
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] };
      }
      throw error;
    }
    return { data: variableSetVariableResource(variable) };
  }, { isAuth: true })
  .patch("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const relationship = variableRelationshipResources(body);
    if (!relationship || relationship.resources.some(item =>
      !validVariableSetVariableAttributes(item.attributes, true)
    )) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }

    const ids = relationship.resources.map(item => item.id as string);
    const variables = await db.query.variableSetVariables.findMany({
      where: and(
        eq(variableSetVariables.variableSetId, record.id),
        inArray(variableSetVariables.id, ids),
      ),
    });
    if (variables.length !== ids.length) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const byId = new Map(variables.map(variable => [variable.id, variable]));
    const updates = relationship.resources.map(item => {
      const variable = byId.get(item.id)!;
      return { variable, values: variableSetVariableUpdate(variable, item.attributes) };
    });
    try {
      await db.transaction(async tx => {
        for (const update of updates) {
          await tx.update(variableSetVariables)
            .set(update.values)
            .where(eq(variableSetVariables.id, update.variable.id));
        }
      });
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] };
      }
      throw error;
    }

    const resources = updates.map(update =>
      variableSetVariableResource({ ...update.variable, ...update.values })
    );
    return { data: relationship.many ? resources : resources[0] };
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const relationship = variableRelationshipResources(body);
    if (!relationship) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }
    const ids = relationship.resources.map(item => item.id as string);
    const variables = await db.query.variableSetVariables.findMany({
      where: and(
        eq(variableSetVariables.variableSetId, record.id),
        inArray(variableSetVariables.id, ids),
      ),
    });
    if (variables.length !== ids.length) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(variableSetVariables).where(and(
      eq(variableSetVariables.variableSetId, record.id),
      inArray(variableSetVariables.id, ids),
    ));
    set.status = 204;
  }, { isAuth: true })
  .patch("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record
      ? await db.query.variableSetVariables.findFirst({
          where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)),
        })
      : undefined;
    if (!record || !variable) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes, true)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

    const updated = variableSetVariableUpdate(variable, attributes);
    try {
      await db.update(variableSetVariables).set(updated).where(eq(variableSetVariables.id, variable.id));
    } catch (error: any) {
      if (error.message?.includes("UNIQUE") || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] };
      }
      throw error;
    }
    return { data: variableSetVariableResource({ ...variable, ...updated }) };
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record
      ? await db.query.variableSetVariables.findFirst({
          where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)),
        })
      : undefined;
    if (!record || !variable) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(variableSetVariables).where(eq(variableSetVariables.id, variable.id));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, user, orgId: principalOrgId, request, set }) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.name, org_name),
    });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const { number, size } = pageRequest(request);
    const params = new URL(request.url).searchParams;
    const csv = (name: string) => [...new Set(
      (params.get(name) || "").split(",").map(value => value.trim()).filter(Boolean)
    )];
    const included = csv("search[tags]");
    const excluded = csv("search[exclude-tags]");
    const tagged = new Map<string, { key?: string; value?: string }>();
    for (const [name, value] of params) {
      const match = name.match(/^filter\[tagged]\[(\d+)]\[(key|value)]$/);
      if (!match) continue;
      const filter = tagged.get(match[1]) || {};
      filter[match[2] as "key" | "value"] = value;
      tagged.set(match[1], filter);
    }
    const taggedFilters = [...tagged.values()].filter(
      (filter): filter is { key: string; value: string } =>
        filter.key !== undefined && filter.value !== undefined,
    );
    const [includedRows, excludedRows, taggedRows] = await Promise.all([
      included.length === 0
        ? []
        : db.select({ workspaceId: workspaceTags.workspaceId, key: workspaceTags.key })
            .from(workspaceTags)
            .innerJoin(workspaces, eq(workspaceTags.workspaceId, workspaces.id))
            .where(and(eq(workspaces.orgId, org.id), inArray(workspaceTags.key, included))),
      excluded.length === 0
        ? []
        : db.select({ workspaceId: workspaceTags.workspaceId })
            .from(workspaceTags)
            .innerJoin(workspaces, eq(workspaceTags.workspaceId, workspaces.id))
            .where(and(eq(workspaces.orgId, org.id), inArray(workspaceTags.key, excluded))),
      taggedFilters.length === 0
        ? []
        : db.select({
            workspaceId: workspaceTags.workspaceId,
            key: workspaceTags.key,
            value: workspaceTags.value,
          })
            .from(workspaceTags)
            .innerJoin(workspaces, eq(workspaceTags.workspaceId, workspaces.id))
            .where(and(
              eq(workspaces.orgId, org.id),
              or(...taggedFilters.map(filter =>
                and(eq(workspaceTags.key, filter.key), eq(workspaceTags.value, filter.value))
              ))!
            )),
    ]);
    const conditions = [eq(workspaces.orgId, org.id)];
    const nameSearch = (params.get("search[name]") || params.get("search[wildcard-name]"))?.trim();
    if (nameSearch) conditions.push(like(workspaces.name, `%${nameSearch}%`));
    if (included.length > 0) {
      const matches = new Map<string, Set<string>>();
      for (const row of includedRows) {
        const keys = matches.get(row.workspaceId) || new Set<string>();
        keys.add(row.key);
        matches.set(row.workspaceId, keys);
      }
      const ids = [...matches].filter(([, keys]) => keys.size === included.length).map(([id]) => id);
      conditions.push(ids.length > 0 ? inArray(workspaces.id, ids) : sql`false`);
    }
    if (excludedRows.length > 0) {
      conditions.push(notInArray(workspaces.id, [...new Set(excludedRows.map(row => row.workspaceId))]));
    }
    if (taggedFilters.length > 0) {
      const matches = new Map<string, Set<string>>();
      for (const row of taggedRows) {
        const pairs = matches.get(row.workspaceId) || new Set<string>();
        pairs.add(`${row.key}\0${row.value}`);
        matches.set(row.workspaceId, pairs);
      }
      const ids = [...matches]
        .filter(([, pairs]) => pairs.size === taggedFilters.length)
        .map(([id]) => id);
      conditions.push(ids.length > 0 ? inArray(workspaces.id, ids) : sql`false`);
    }
    const where = and(...conditions)!;
    const [orgWorkspaces, [{ total }]] = await Promise.all([
      db.query.workspaces.findMany({
        where,
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(workspaces).where(where),
    ]);

    return {
      data: await Promise.all(orgWorkspaces.map(workspace =>
        workspaceResource(workspace, org.defaultIacBinary, Boolean(user))
      )),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, body, user, orgId: principalOrgId, request, set }) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.name, org_name),
    });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const attributes = (body as any)?.data?.attributes || {};
    const rawTagBindings = (body as any)?.data?.relationships?.["tag-bindings"]?.data;
    const tagBindings = rawTagBindings === undefined ? [] : parseTagBindings(rawTagBindings);
    const {
      name,
      description,
      "auto-apply": autoApply,
      "terraform-version": terraformVersion,
      "working-directory": workingDirectory,
      "source-name": sourceName,
      "source-url": sourceUrl,
      "iac-binary": iacBinary,
      "execution-mode": executionMode,
    } = attributes;

    if (tagBindings === undefined) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] };
    }
    if (!name) {
      set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] };
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] };
    }
    if (
      (sourceName !== undefined && sourceName !== null && typeof sourceName !== "string")
      || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")
    ) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-name and source-url must be strings or null" }] };
    }
    if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
    }
    if (executionMode !== undefined && executionMode !== "remote") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] };
    }
    if (iacBinary !== undefined && iacBinary !== null && !["tofu", "terraform"].includes(iacBinary)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] };
    }
    if (await findWorkspaceByName(org.id, name)) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] };
    }

    let normalizedWorkingDirectory: string | null;
    try {
      normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);
    } catch (error: any) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error.message }] };
    }

    const workspace = await db.transaction(async tx => {
      const [created] = await tx.insert(workspaces).values({
        id: crypto.randomUUID(),
        name,
        description: description ?? null,
        orgId: org.id,
        autoApply: autoApply ?? false,
        terraformVersion: terraformVersion ?? "latest",
        workingDirectory: normalizedWorkingDirectory,
        sourceName: sourceName ?? null,
        sourceUrl: sourceUrl ?? null,
        iacBinary: iacBinary || (request.headers.get("Terraform-Version") ? "terraform" : null),
      }).returning();
      if (tagBindings.length > 0) {
        await tx.insert(workspaceTags).values(tagBindings.map(binding => ({
          id: crypto.randomUUID(),
          workspaceId: created.id,
          ...binding,
        })));
      }
      return created;
    });

    set.status = 201;
    return { data: await workspaceResource(workspace, org.defaultIacBinary, Boolean(user)) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.name, org_name),
    });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const workspace = await findWorkspaceByName(org.id, workspace_name);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return { data: await workspaceResource(workspace, org.defaultIacBinary, Boolean(user)) };
  }, { isAuth: true })
  .patch("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, body, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const workspace = await findWorkspaceByName(org.id, workspace_name);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return updateWorkspaceResponse(workspace, org.defaultIacBinary, Boolean(user), body, set);
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    const workspace = org ? await findWorkspaceByName(org.id, workspace_name) : null;
    if (!org || !workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "owner", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    await deleteWorkspaceData(workspace.id);
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/workspaces/:workspace_name/actions/safe-delete", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    const workspace = org ? await findWorkspaceByName(org.id, workspace_name) : null;
    if (!org || !workspace || !(await checkOrgPermission(user?.id, org.id, "owner", principalOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await safeDeleteWorkspace(workspace.id))) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is managing resources" }] };
    }
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspace_id),
    });

    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, workspace.orgId),
    });

    return { data: await workspaceResource(workspace, org?.defaultIacBinary, Boolean(user)) };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspace_id),
    });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, workspace.orgId),
    });
    return updateWorkspaceResponse(workspace, org?.defaultIacBinary, Boolean(user), body, set);
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspace_id),
    });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "owner", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    await deleteWorkspaceData(workspace_id);
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/safe-delete", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace || !(await checkOrgPermission(user?.id, workspace?.orgId || "", "owner", principalOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await safeDeleteWorkspace(workspace_id))) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is managing resources" }] };
    }
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedWorkspace(workspace_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const tags = await db.query.workspaceTags.findMany({
      where: eq(workspaceTags.workspaceId, workspace_id),
      orderBy: [asc(workspaceTags.key)],
    });
    return {
      data: tags.slice((number - 1) * size, number * size).map(tag => tagBindingResource(tag)),
      ...pagination(request, number, size, tags.length),
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/effective-tag-bindings", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedWorkspace(workspace_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const tags = await db.query.workspaceTags.findMany({
      where: eq(workspaceTags.workspaceId, workspace_id),
      orderBy: [asc(workspaceTags.key)],
    });
    return {
      data: tags.slice((number - 1) * size, number * size).map(tag => tagBindingResource(tag, true)),
      ...pagination(request, number, size, tags.length),
    };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params: { workspace_id }, body, user, orgId, set }) => {
    if (!(await findAuthorizedWorkspace(workspace_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const bindings = parseTagBindings((body as any)?.data);
    if (!bindings?.length) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "At least one valid tag binding is required" }] };
    }
    const updated = [];
    for (const binding of bindings) {
      const existing = await db.query.workspaceTags.findFirst({
        where: and(eq(workspaceTags.workspaceId, workspace_id), eq(workspaceTags.key, binding.key)),
      });
      if (existing) {
        await db.update(workspaceTags).set({ value: binding.value }).where(eq(workspaceTags.id, existing.id));
        updated.push({ ...existing, value: binding.value });
      } else {
        const tag = { id: crypto.randomUUID(), workspaceId: workspace_id, ...binding };
        await db.insert(workspaceTags).values(tag);
        updated.push(tag);
      }
    }
    return { data: updated.map(tag => tagBindingResource(tag)) };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
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
  .post("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
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
  .delete("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const data = (body as any)?.data;
    const ids: string[] = [];
    const names: string[] = [];
    if (Array.isArray(data)) {
      for (const tag of data) {
        if (tag?.type !== "tags") continue;
        if (typeof tag.id === "string") ids.push(tag.id);
        const name = tag?.attributes?.name ?? tag?.attributes?.key;
        if (typeof name === "string") names.push(name);
      }
    }
    if (ids.length === 0 && names.length === 0) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Each tag requires an id or name" }] };
    }

    if (ids.length > 0) {
      await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspace_id), inArray(workspaceTags.id, ids)));
    }
    if (names.length > 0) {
      await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspace_id), inArray(workspaceTags.key, names)));
    }
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = eq(workspaceVariables.workspaceId, workspace_id);
    const [vars, [{ total }]] = await Promise.all([
      db.query.workspaceVariables.findMany({
        where,
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(workspaceVariables).where(where),
    ]);

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
                hcl: v.hcl
            }
        })),
        ...pagination(request, number, size, total)
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, body, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { key, value, category, sensitive, description, hcl } = payload?.data?.attributes || {};

    if (!validVariableAttributes(payload?.data?.attributes || {})) {
        set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(workspaceVariables).values({
        id,
        workspaceId: workspace_id,
        key,
        value: String(value),
        category: category || "terraform",
        sensitive: sensitive ?? false,
        hcl: hcl ?? false,
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
                hcl: hcl ?? false
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!workspace || !v) {
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
                hcl: v.hcl
            }
        }
    };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, body, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { key, value, category, sensitive, description, hcl } = payload?.data?.attributes || {};
    if (!validVariableAttributes(payload?.data?.attributes || {}, true)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

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
        hcl: hcl !== undefined ? hcl : v.hcl,
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
                hcl: updated.hcl
            }
        }
    };
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, var_id));
    set.status = 204;
    return;
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    await db.update(workspaces).set({ locked: true }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: true, "locked-reason": "Locked manually" } } };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/unlock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    await db.update(workspaces).set({ locked: false }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: false, "locked-reason": null } } };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/force-unlock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "owner", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    await db.update(workspaces).set({ locked: false }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: false, "locked-reason": null } } };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = eq(stateVersions.workspaceId, workspace_id);
    const [list, [{ total }]] = await Promise.all([
      db.query.stateVersions.findMany({
        where,
        orderBy: [desc(stateVersions.serial)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);

    return {
        data: list.map(state => stateVersionResource(state, request)),
        ...pagination(request, number, size, total)
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, workspace_id),
        orderBy: [desc(stateVersions.serial)]
    });
    if (!state) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stateVersionResource(state, request, true) };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/current-state-version-outputs", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspace_id),
      orderBy: [desc(stateVersions.serial)],
    });
    if (!state) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const outputs = stateOutputResources(state);
    return {
      data: outputs,
      ...pagination(request, 1, Math.max(outputs.length, 1), outputs.length),
    };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.id, state_version_id)
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stateVersionResource(state, request, true) };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/state-version-outputs", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.id, state_version_id),
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(state);
    return {
      data: outputs.slice((number - 1) * size, number * size),
      ...pagination(request, number, size, outputs.length),
    };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/outputs", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.id, state_version_id),
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(state);
    return {
      data: outputs.slice((number - 1) * size, number * size),
      ...pagination(request, number, size, outputs.length),
    };
  }, { isAuth: true })
  .get("/api/v2/state-version-outputs/:state_version_output_id", async ({ params: { state_version_output_id }, user, orgId, set }) => {
    const userOrgs = orgId
      ? [orgId]
      : user?.id
      ? (await db.select({ orgId: organizationMemberships.orgId }).from(organizationMemberships).where(eq(organizationMemberships.userId, user.id))).map(m => m.orgId)
      : [];
    if (userOrgs.length > 0) {
      const wsRows = await db.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.orgId, userOrgs));
      const wsIds = wsRows.map(w => w.id);
      if (wsIds.length > 0) {
        const states = await db.select({ id: stateVersions.id, workspaceId: stateVersions.workspaceId, statePayload: stateVersions.statePayload })
          .from(stateVersions)
          .where(inArray(stateVersions.workspaceId, wsIds));
        for (const state of states) {
          const output = stateOutputResources(state as any).find(({ id }) => id === state_version_output_id);
          if (output) {
            return { data: output };
          }
        }
      }
    }
    set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params: { state_version_id }, user, orgId, set }) => {
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.id, state_version_id)
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
        set.status = 404; return "Not Found";
    }

    set.headers["Content-Type"] = "application/json";
    return state.statePayload || "{}";
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, body, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { serial, state } = payload?.data?.attributes || {};
    if (serial === undefined) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    if (state === undefined || state === null || state === "") {
        set.status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "param is missing or the value is empty: state" }] };
    }
    const statePayload = decodeStatePayload(state);
    const id = crypto.randomUUID();
    await db.insert(stateVersions).values({
        id,
        workspaceId: workspace_id,
        serial,
        statePayload
    });

    set.status = 201;
    return {
      data: stateVersionResource({ id, workspaceId: workspace_id, serial, statePayload }, request, true),
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = eq(configurationVersions.workspaceId, workspace_id);
    const [list, [{ total }]] = await Promise.all([
      db.query.configurationVersions.findMany({
        where,
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(configurationVersions).where(where),
    ]);
    return {
      data: list.map(cv => ({
        id: cv.id,
        type: "configuration-versions",
        attributes: {
          status: cv.status,
          source: "tfe-api",
          speculative: cv.speculative,
          provisional: cv.provisional,
          "upload-url": apiURL(request, `/api/v2/configuration-versions/${cv.id}/upload`),
        },
      })),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, body, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { speculative = false, provisional = false } = (body as any)?.data?.attributes || {};
    if (typeof speculative !== "boolean" || typeof provisional !== "boolean") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "speculative and provisional must be booleans" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(configurationVersions).values({
        id,
        workspaceId: workspace_id,
        status: "pending",
        speculative,
        provisional,
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "configuration-versions",
            attributes: {
                status: "pending",
                source: "tfe-api",
                speculative,
                provisional,
                "upload-url": apiURL(request, `/api/v2/configuration-versions/${id}/upload`)
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/configuration-versions/:cv_id", async ({ params: { cv_id }, user, orgId, request, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv || !(await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: cv.id,
            type: "configuration-versions",
            attributes: {
                status: cv.status,
                source: "tfe-api",
                speculative: cv.speculative,
                provisional: cv.provisional,
                "upload-url": apiURL(request, `/api/v2/configuration-versions/${cv.id}/upload`)
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
    if (cv.status !== "pending") {
        set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Configuration version already uploaded" }] };
    }

    await mkdir(CV_STORAGE_DIR, { recursive: true });
    const archivePath = join(CV_STORAGE_DIR, `${cv_id}.tar.gz`);

    const buffer = await request.arrayBuffer();
    await writeFile(archivePath, Buffer.from(buffer));

    await db.update(configurationVersions).set({ status: "uploaded", archivePath }).where(eq(configurationVersions.id, cv_id));
    set.status = 200;
    return "Upload successful";
  })
  .get("/api/v2/configuration-versions/:cv_id/download", async ({ params: { cv_id }, user, orgId, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv || !(await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId)) || !cv.archivePath) {
        set.status = 404; return "Not Found";
    }
    return Bun.file(cv.archivePath);
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/runs", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = workspaceRunHistoryWhere(request, workspace_id);
    const [workspaceRuns, [{ total }]] = await Promise.all([
      db.query.runs.findMany({
        where,
        orderBy: [desc(runs.createdAt)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    return {
        data: workspaceRuns.map(run => runResource(run, Boolean(user))),
        ...pagination(request, number, size, total)
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/runs", async ({ params: { org_name }, user, orgId, request, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) {
      return { data: [], ...pagination(request, number, size, 0) };
    }

    const where = inArray(runs.workspaceId, orgWorkspaces.map(workspace => workspace.id));
    const [orgRuns, [{ total }]] = await Promise.all([
      db.query.runs.findMany({
          where,
          orderBy: [desc(runs.createdAt)],
          limit: size,
          offset: (number - 1) * size,
        }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    return {
      data: orgRuns.map(run => runResource(run, Boolean(user))),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/runs/queue", async ({ params: { org_name }, user, orgId, request, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) {
      return { data: [], ...pagination(request, number, size, 0) };
    }

    // ponytail: rank the small active queue in-process; use SQL windowing if org queues reach thousands.
    const queue = await db.query.runs.findMany({
      where: and(
        inArray(runs.workspaceId, orgWorkspaces.map(workspace => workspace.id)),
        inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES]),
      ),
      orderBy: [asc(runs.createdAt)],
    });
    let position = queue.filter(run => CAPACITY_RUNNING_STATUSES.includes(run.status)).length;
    const data = queue.map(run => {
      const resource = runResource(run, Boolean(user));
      return {
        ...resource,
        attributes: {
          ...resource.attributes,
          "position-in-queue": CAPACITY_PENDING_STATUSES.includes(run.status) ? ++position : 0,
        },
      };
    }).slice((number - 1) * size, number * size);

    return { data, ...pagination(request, number, size, queue.length) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/capacity", async ({ params: { org_name }, user, orgId, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const active = orgWorkspaces.length === 0 ? [] : await db.query.runs.findMany({
      columns: { status: true },
      where: and(
        inArray(runs.workspaceId, orgWorkspaces.map(workspace => workspace.id)),
        inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES]),
      ),
    });
    return {
      data: {
        id: organization.name,
        type: "organization-capacity",
        attributes: {
          pending: active.filter(run => CAPACITY_PENDING_STATUSES.includes(run.status)).length,
          running: active.filter(run => CAPACITY_RUNNING_STATUSES.includes(run.status)).length,
        },
      },
    };
  }, { isAuth: true })
  .post("/api/v2/runs", async ({ body, user, orgId, request, set }) => {
    const payload = body as any;
    const {
      message,
      "is-destroy": isDestroy,
      "auto-apply": autoApply,
      "plan-only": requestedPlanOnly,
      refresh = true,
      "refresh-only": refreshOnly = false,
      "target-addrs": targetAddrs,
      "replace-addrs": replaceAddrs,
      variables: runVariables,
      "terraform-version": terraformVersion,
      "debugging-mode": debuggingMode = false,
    } = payload?.data?.attributes || {};
    const workspaceId = payload?.data?.relationships?.workspace?.data?.id;
    const cvId = payload?.data?.relationships?.["configuration-version"]?.data?.id || payload?.data?.attributes?.["configuration-version-id"];

    if (!workspaceId) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] };
    }
    if (
      (autoApply !== undefined && typeof autoApply !== "boolean")
      || (isDestroy !== undefined && typeof isDestroy !== "boolean")
      || (requestedPlanOnly !== undefined && typeof requestedPlanOnly !== "boolean")
      || typeof refresh !== "boolean"
      || typeof refreshOnly !== "boolean"
      || typeof debuggingMode !== "boolean"
      || (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion)))
      || (targetAddrs != null && (!Array.isArray(targetAddrs) || targetAddrs.some(value => typeof value !== "string")))
      || (replaceAddrs != null && (!Array.isArray(replaceAddrs) || replaceAddrs.some(value => typeof value !== "string")))
      || (runVariables != null && (!Array.isArray(runVariables) || runVariables.some(variable =>
        !variable
        || typeof variable.key !== "string"
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.key)
        || typeof variable.value !== "string"
      )))
    ) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid run attributes" }] };
    }

    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (orgId) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    let configurationVersion: typeof configurationVersions.$inferSelect | undefined;
    if (cvId) {
      configurationVersion = typeof cvId === "string"
        ? await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) })
        : undefined;
      if (!configurationVersion || configurationVersion.workspaceId !== workspaceId) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Configuration version does not belong to workspace" }] };
      }
    }
    if (!workspace.iacBinary && request.headers.get("Terraform-Version")) {
      await db.update(workspaces).set({ iacBinary: "terraform" }).where(eq(workspaces.id, workspace.id));
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const logToken = crypto.randomUUID();
    const planOnly = requestedPlanOnly ?? configurationVersion?.speculative ?? false;

    await db.insert(runs).values({
        id,
        workspaceId,
        configurationVersionId: cvId || null,
        message: message || "Queued manually",
        status: "pending",
        isDestroy: isDestroy ?? false,
        autoApply: autoApply ?? false,
        planOnly,
        refresh,
        refreshOnly,
        targetAddrs: targetAddrs || null,
        replaceAddrs: replaceAddrs || null,
        variables: runVariables || null,
        logToken,
        terraformVersion: terraformVersion || null,
        debuggingMode,
        createdBy: user?.id || null,
        createdAt,
    });

    set.status = 201;
    return { data: runResource({
      id,
      workspaceId,
      configurationVersionId: cvId || null,
      message: message || "Queued manually",
      status: "pending",
      isDestroy: isDestroy ?? false,
      autoApply: autoApply ?? false,
      planOnly,
      refresh,
      refreshOnly,
      targetAddrs: targetAddrs || null,
      replaceAddrs: replaceAddrs || null,
      variables: runVariables || null,
      logToken,
      terraformVersion: terraformVersion || null,
      debuggingMode,
      createdBy: user?.id || null,
      createdAt,
    }, true) };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id", async ({ params: { run_id }, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return { data: runResource(authorized.run, Boolean(user)) };
  }, { isAuth: true })
  .delete("/api/v2/runs/:run_id", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(logs).where(eq(logs.runId, run_id));
    await db.delete(runs).where(eq(runs.id, run_id));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/plan", async ({ params: { run_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: planResource(authorized.run, request) };
  }, { isAuth: true })
  .get("/api/v2/plans/:plan_id", async ({ params: { plan_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(plan_id.replace(/^plan-/, ""), user?.id, orgId);
    if (!authorized) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: planResource(authorized.run, request) };
  }, { isAuth: true })
  .get("/api/v2/applies/:apply_id", async ({ params: { apply_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(apply_id.replace(/^apply-/, ""), user?.id, orgId);
    if (!authorized) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: applyResource(authorized.run, request) };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/run-events", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: [] };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/logs", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
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
  .get("/api/v2/runs/:run_id/plan/log/:log_token", async ({ params: { run_id, log_token }, request, set }) => {
    if (!(await findLogCapability(run_id, log_token))) {
      set.status = 404; return "Not Found";
    }
    const planLogs = await db.query.logs.findMany({
      where: (log, { and, eq }) => and(eq(log.runId, run_id), eq(log.phase, "plan")),
      orderBy: [asc(logs.createdAt)],
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map(log => log.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log/:log_token", async ({ params: { run_id, log_token }, request, set }) => {
    if (!(await findLogCapability(run_id, log_token))) {
      set.status = 404; return "Not Found";
    }
    const applyLogs = await db.query.logs.findMany({
      where: (log, { and, eq }) => and(eq(log.runId, run_id), eq(log.phase, "apply")),
      orderBy: [asc(logs.createdAt)],
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map(log => log.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/plan/log", async ({ params: { run_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const planLogs = await db.query.logs.findMany({
        where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "plan")),
        orderBy: [asc(logs.createdAt)]
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map(l => l.outputText).join("\n"), request);
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/apply/log", async ({ params: { run_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const applyLogs = await db.query.logs.findMany({
        where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "apply")),
        orderBy: [asc(logs.createdAt)]
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map(l => l.outputText).join("\n"), request);
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params: { run_id }, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (orgId) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const claimed = await db.update(runs)
      .set({ status: "applying" })
      .where(and(eq(runs.id, run_id), eq(runs.status, "planned")))
      .returning({ id: runs.id });
    if (claimed.length === 0) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Run must be planned before apply" }] };
    }
    executeApply(authorized.run.id).catch(console.error);

    return {
        data: {
            id: authorized.run.id,
            type: "runs",
            attributes: { status: "applying" }
        }
    };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "discarded" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not discardable" }] };
    }
    return { data: { id: run_id, type: "runs", attributes: { status: "discarded" } } };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "canceled" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] };
    }
    return { data: { id: run_id, type: "runs", attributes: { status: "canceled" } } };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/force-cancel", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "force_canceled" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] };
    }
    return { data: { id: run_id, type: "runs", attributes: { status: "force_canceled" } } };
  }, { isAuth: true });
