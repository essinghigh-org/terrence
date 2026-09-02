import { Elysia } from "elysia";
import { db } from "../db";
import {
  explorerBulkActionRecords,
  auditLogs,
  explorerSavedQueries,
  organizations,
  type users,
  explorerCatalogMemberships,
  explorerWorkspaceInventory,
  workspaces,
} from "../db/schema";
import { and, asc, count, countDistinct, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { authPlugin } from "../auth";
import { checkOrganizationPermission, pageRequest, pagination } from "../lib/utils";
import { queueExplorerBulkActionNotification } from "../lib/notifications";
import { ensureExplorerInventory } from "../lib/explorer-inventory";
import { isPostgres } from "../db/driver";

type SetObj = Readonly<{ status?: number | string; headers: Record<string, string | number> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

type ViewType = "workspaces" | "tf_versions" | "providers" | "modules";
type ExplorerRow = Readonly<{ id: string; type: string; attributes: Record<string, unknown> }>;
type ExplorerFilter = Readonly<{ field: string; operator: string; value: string[] }>;
type ExplorerQuery = Readonly<{
  type: ViewType;
  filter: ExplorerFilter[];
  fields: string[];
  sort: string[];
}>;

const viewTypes = new Set<ViewType>(["workspaces", "tf_versions", "providers", "modules"]);
const filterOperators = new Set(["contains", "does not contain", "starts-with", "ends-with", "is", "is_not", "not-is", "is-null", "is_not_empty", "is_empty", "is-not-null", "greater-than", "less-than", "gt", "lt", "gteq", "lteq", "is_before", "is_after"]);

function safeIsoDate(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  const d = new Date(val as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function error(status: string, title: string, detail?: string): { errors: { status: string; title: string; detail?: string }[] } {
  return { errors: [{ status, title, ...(detail === undefined ? {} : { detail }) }] };
}

async function canExplore(orgId: string, userId: string | undefined, tokenOrgId: string | null, tokenTeamId: string | null): Promise<boolean> {
  return await checkOrganizationPermission(orgId, userId, tokenOrgId, tokenTeamId, "read-workspaces")
    || await checkOrganizationPermission(orgId, userId, tokenOrgId, tokenTeamId, "read-projects");
}

function viewType(value: unknown): ViewType | undefined {
  return typeof value === "string" && viewTypes.has(value as ViewType) ? value as ViewType : undefined;
}

function queryObject(value: unknown, fallbackType?: unknown): ExplorerQuery | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const type = viewType(raw.type ?? fallbackType);
  if (type === undefined) return undefined;
  let invalidOperator = false;
  const filters = Array.isArray(raw.filter)
    ? raw.filter.flatMap((item): ExplorerFilter[] => {
        if (typeof item !== "object" || item === null) return [];
        const filter = item as Record<string, unknown>;
        const values = Array.isArray(filter.value) ? filter.value.filter((v): v is string => typeof v === "string") : [];
        if (typeof filter.operator === "string" && !filterOperators.has(filter.operator)) invalidOperator = true;
        return typeof filter.field === "string" && typeof filter.operator === "string"
          ? [{ field: filter.field, operator: filter.operator, value: values }]
          : [];
      })
    : [];
  if (invalidOperator) return undefined;
  const fields = Array.isArray(raw.fields) ? raw.fields.filter((field): field is string => typeof field === "string") : [];
  const sort = Array.isArray(raw.sort)
    ? raw.sort.filter((field): field is string => typeof field === "string")
    : typeof raw.sort === "string" ? raw.sort.split(",").filter(Boolean) : [];
  const query = { type, filter: filters, fields, sort };
  return invalidQueryField(query) === null ? query : undefined;
}

function urlQuery(url: URL): ExplorerQuery | undefined {
  const type = viewType(url.searchParams.get("type"));
  if (type === undefined) return undefined;
  const filters: ExplorerFilter[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const match = /^filter\[\d+\]\[([^\]]+)\]\[([^\]]+)\]\[\d+\]$/.exec(key);
    if (match !== null) {
      const field = match[1];
      const operator = match[2];
      if (field === undefined || operator === undefined) continue;
      if (!filterOperators.has(operator)) return undefined;
      const existing = filters.find((filter) => filter.field === field && filter.operator === operator);
      if (existing === undefined) filters.push({ field, operator, value: [value] });
      else existing.value.push(value);
    }
  }
  const fields = (url.searchParams.get("fields") ?? "").split(",").filter(Boolean);
  const sort = (url.searchParams.get("sort") ?? "").split(",").filter(Boolean);
  const query = { type, filter: filters, fields, sort };
  return invalidQueryField(query) === null ? query : undefined;
}

function fieldValue(row: ExplorerRow, field: string): unknown {
  const candidates = [field, field.replaceAll("_", "-"), field.replaceAll("-", "_")];
  const key = candidates.find((candidate) => Object.prototype.hasOwnProperty.call(row.attributes, candidate));
  return key === undefined ? undefined : row.attributes[key];
}

function filterMatch(value: unknown, operator: string, expected: string[]): boolean {
  const values = expected.map((item) => item.toLocaleLowerCase());
  const actual = value === null || value === undefined ? "" : String(value).toLocaleLowerCase();
  switch (operator) {
    case "contains": return values.some((item) => actual.includes(item));
    case "does not contain": return values.every((item) => !actual.includes(item));
    case "starts-with": return values.some((item) => actual.startsWith(item));
    case "ends-with": return values.some((item) => actual.endsWith(item));
    case "is": return values.some((item) => actual === item);
    case "not-is":
    case "is_not": return values.every((item) => actual !== item);
    case "is-null":
    case "is_empty": return value === null || value === undefined || actual === "";
    case "is-not-null":
    case "is_not_empty": return value !== null && value !== undefined && actual !== "";
    case "greater-than":
    case "gt":
    case "is_after": return values.some((item) => compare(value, item) > 0);
    case "less-than":
    case "lt":
    case "is_before": return values.some((item) => compare(value, item) < 0);
    case "gteq": return values.some((item) => compare(value, item) >= 0);
    case "lteq": return values.some((item) => compare(value, item) <= 0);
    default: return false;
  }
}

function compare(value: unknown, expected: string): number {
  const actualNumber = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : Number.NaN;
  const expectedNumber = expected.trim() === "" ? Number.NaN : Number(expected);
  if (!Number.isNaN(actualNumber) && !Number.isNaN(expectedNumber)) return actualNumber - expectedNumber;
  return String(value ?? "").localeCompare(expected);
}

function applyQuery(rows: ExplorerRow[], query: ExplorerQuery): ExplorerRow[] {
  let result = rows.filter((row) => query.filter.every((filter) => filterMatch(fieldValue(row, filter.field), filter.operator, filter.value)));
  if (query.sort.length > 0) {
    result = [...result].sort((left, right) => {
      for (const sortField of query.sort) {
        const descending = sortField.startsWith("-");
        const field = descending ? sortField.slice(1) : sortField;
        const a = fieldValue(left, field);
        const b = fieldValue(right, field);
        if (a === b) continue;
        const comparison = String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
        return descending ? -comparison : comparison;
      }
      return 0;
    });
  }
  if (query.fields.length === 0) return result;
  return result.map((row) => {
    const attributes: Record<string, unknown> = {};
    for (const field of query.fields) {
      const key = [field, field.replaceAll("_", "-"), field.replaceAll("-", "_")]
        .find((candidate) => Object.prototype.hasOwnProperty.call(row.attributes, candidate));
      if (key !== undefined) attributes[key] = row.attributes[key];
    }
    return { ...row, attributes };
  });
}

const workspaceInventoryColumns: Readonly<Record<string, string>> = {
  workspace_name: "workspace_name",
  name: "workspace_name",
  workspace_created_at: "workspace_created_at",
  workspace_updated_at: "workspace_updated_at",
  terraform_version: "terraform_version",
  "workspace-terraform-version": "terraform_version",
  execution_mode: "execution_mode",
  source_module_id: "source_module_id",
  current_run_status: "current_run_status",
  current_run_applied_at: "current_run_applied_at",
  current_run_external_id: "current_run_external_id",
  current_rum_count: "current_resource_count",
  current_resource_count: "current_resource_count",
  drifted: "drifted",
  resources_drifted: "resources_drifted",
  resources_undrifted: "resources_undrifted",
  all_checks_succeeded: "all_checks_succeeded",
  checks_passed: "checks_passed",
  checks_failed: "checks_failed",
  checks_errored: "checks_errored",
  checks_unknown: "checks_unknown",
  vcs_repo_identifier: "vcs_repo_identifier",
  tags: "tags",
  project_name: "project_name",
  project_external_id: "project_id",
  providers: "providers",
  modules: "modules",
  provider_count: "provider_count",
  module_count: "module_count",
  state_version_terraform_version: "state_version_terraform_version",
  external_id: "workspace_id",
};

const catalogColumns: Readonly<Record<string, string>> = {
  name: "name",
  source: "source",
  version: "version",
  workspace_count: "workspace_count",
  "workspace-count": "workspace_count",
  workspaces: "workspaces",
};

const numericExplorerColumns = new Set([
  "current_resource_count", "resources_drifted", "resources_undrifted", "checks_passed", "checks_failed",
  "checks_errored", "checks_unknown", "provider_count", "module_count", "workspace_count",
]);
const dateExplorerColumns = new Set(["workspace_created_at", "workspace_updated_at", "current_run_applied_at"]);
const booleanExplorerColumns = new Set(["drifted", "all_checks_succeeded"]);
const comparisonOperators = new Set(["is", "not-is", "is_not", "greater-than", "gt", "is_after", "less-than", "lt", "is_before", "gteq", "lteq"]);
const negativeFilterOperators = new Set(["does not contain", "not-is", "is_not"]);

function columnFor(field: string, columns: Readonly<Record<string, string>>): string | undefined {
  return columns[field] ?? columns[field.replaceAll("-", "_")] ?? columns[field.replaceAll("_", "-")];
}

function queryColumns(type: ViewType): Readonly<Record<string, string>> {
  return type === "workspaces" ? workspaceInventoryColumns : catalogColumns;
}

function invalidQueryField(query: ExplorerQuery): string | null {
  const columns = queryColumns(query.type);
  const fields = [
    ...query.filter.map((filter) => filter.field),
    ...query.fields,
    ...query.sort.map((sort) => sort.startsWith("-") ? sort.slice(1) : sort),
  ];
  for (const field of fields) {
    if (query.type === "workspaces" && (field === "organization_name" || field === "organization-name")) continue;
    if (columnFor(field, columns) === undefined) return field;
  }
  return null;
}

function sqlColumn(name: string): SQL {
  return sql.raw(`"${name}"`);
}

function sqlFilter(columnName: string, filter: ExplorerFilter): SQL | undefined {
  const column = sqlColumn(columnName);
  const values = filter.value.length === 0 ? [""] : filter.value;
  const numeric = numericExplorerColumns.has(columnName);
  const date = dateExplorerColumns.has(columnName);
  const boolean = booleanExplorerColumns.has(columnName);
  const textColumn = boolean
    ? sql`CASE WHEN ${column} THEN 'true' ELSE 'false' END`
    : sql`CAST(${column} AS TEXT)`;
  const make = (value: string): SQL => {
    const bound = boolean && comparisonOperators.has(filter.operator)
      ? value.toLowerCase() === "true" ? true : value.toLowerCase() === "false" ? false : undefined
      : numeric && comparisonOperators.has(filter.operator)
      ? Number(value)
      : date && comparisonOperators.has(filter.operator)
        ? Date.parse(value)
        : value;
    if (boolean && comparisonOperators.has(filter.operator) && typeof bound !== "boolean") return sql`1 = 0`;
    if ((numeric || date) && comparisonOperators.has(filter.operator) && typeof bound === "number" && !Number.isFinite(bound)) return sql`1 = 0`;
    switch (filter.operator) {
      case "contains": return sql`lower(${textColumn}) LIKE lower(${`%${value}%`})`;
      case "does not contain": return sql`lower(${textColumn}) NOT LIKE lower(${`%${value}%`})`;
      case "starts-with": return sql`lower(${textColumn}) LIKE lower(${`${value}%`})`;
      case "ends-with": return sql`lower(${textColumn}) LIKE lower(${`%${value}`})`;
      case "is": return numeric || date || boolean ? sql`${column} = ${bound}` : sql`lower(${textColumn}) = lower(${value})`;
      case "not-is":
      case "is_not": return numeric || date || boolean ? sql`${column} <> ${bound}` : sql`lower(${textColumn}) <> lower(${value})`;
      case "is-null":
      case "is_empty": return sql`(${column} IS NULL OR ${textColumn} = '')`;
      case "is-not-null":
      case "is_not_empty": return sql`(${column} IS NOT NULL AND ${textColumn} <> '')`;
      case "greater-than":
      case "gt":
      case "is_after": return sql`${column} > ${bound}`;
      case "less-than":
      case "lt":
      case "is_before": return sql`${column} < ${bound}`;
      case "gteq": return sql`${column} >= ${bound}`;
      case "lteq": return sql`${column} <= ${bound}`;
      default: return sql`1 = 1`;
    }
  };
  return values.length === 1 ? make(values[0] ?? "") : sql`(${sql.join(values.map(make), negativeFilterOperators.has(filter.operator) ? sql` AND ` : sql` OR `)})`;
}

function indexedWhere(
  query: ExplorerQuery,
  orgId: string,
  orgName: string,
  columns: Readonly<Record<string, string>>,
): ReturnType<typeof and> {
  const predicates = [sql`${sqlColumn("org_id")} = ${orgId}`];
  for (const filter of query.filter) {
    if (filter.field === "organization_name" || filter.field === "organization-name") {
      if (!filterMatch(orgName, filter.operator, filter.value)) predicates.push(sql`1 = 0`);
      continue;
    }
    const columnName = columnFor(filter.field, columns);
    if (columnName === undefined) continue;
    const predicate = sqlFilter(columnName, filter);
    if (predicate !== undefined) predicates.push(predicate);
  }
  return and(...predicates);
}

function indexedOrders(query: ExplorerQuery, columns: Readonly<Record<string, string>>, fallback: string, expressions: Readonly<Record<string, SQL>> = {}): SQL[] {
  const orders = query.sort.flatMap((raw): SQL[] => {
    const descending = raw.startsWith("-");
    const field = descending ? raw.slice(1) : raw;
    const column = columnFor(field, columns);
    if (column === undefined) return [];
    const expression = expressions[field] ?? expressions[column] ?? sqlColumn(column);
    return [descending ? desc(expression) : asc(expression)];
  });
  return orders.length > 0 ? orders : [desc(sqlColumn(fallback))];
}

function inventoryResource(row: typeof explorerWorkspaceInventory.$inferSelect, orgName: string): ExplorerRow {
  const attributes: Record<string, unknown> = {
    organization_name: orgName,
    workspace_name: row.workspaceName,
    name: row.workspaceName,
    workspace_created_at: safeIsoDate(row.workspaceCreatedAt),
    workspace_updated_at: safeIsoDate(row.workspaceUpdatedAt),
    source_module_id: row.sourceModuleId,
    "workspace-terraform-version": row.terraformVersion,
    "terraform-version": row.terraformVersion,
    "execution-mode": row.executionMode,
    current_run_status: row.currentRunStatus,
    current_run_applied_at: safeIsoDate(row.currentRunAppliedAt),
    current_run_external_id: row.currentRunExternalId,
    current_rum_count: row.currentResourceCount,
    current_resource_count: row.currentResourceCount,
    drifted: row.drifted,
    resources_drifted: row.resourcesDrifted,
    resources_undrifted: row.resourcesUndrifted,
    all_checks_succeeded: row.allChecksSucceeded,
    checks_passed: row.checksPassed,
    checks_failed: row.checksFailed,
    checks_errored: row.checksErrored,
    checks_unknown: row.checksUnknown,
    vcs_repo_identifier: row.vcsRepoIdentifier,
    tags: row.tags,
    project_name: row.projectName,
    project_external_id: row.projectId,
    providers: row.providers,
    modules: row.modules,
    provider_count: row.providerCount,
    module_count: row.moduleCount,
    state_version_terraform_version: row.stateVersionTerraformVersion,
    external_id: row.workspaceId,
  };
  return { id: row.workspaceId, type: "workspaces", attributes };
}

function membershipCatalogResource(row: Readonly<{
  kind: string;
  name: string;
  source: string;
  version: string;
  workspaceCount: number;
  workspaces: string | null;
}>): ExplorerRow {
  const key = [row.kind, row.name, row.source, row.version].join("|");
  return {
    id: `eci-${encodeURIComponent(key)}`,
    type: row.kind,
    attributes: {
      name: row.name,
      source: row.source,
      version: row.version,
      workspace_count: row.workspaceCount,
      "workspace-count": row.workspaceCount,
      workspaces: row.workspaces ?? "",
    },
  };
}

function aggregateFilter(expression: SQL, filter: ExplorerFilter): SQL {
  const values = filter.value.length === 0 ? [""] : filter.value;
  const make = (value: string): SQL => {
    const numeric = Number(value);
    const bound = Number.isFinite(numeric) ? numeric : Number.NaN;
    switch (filter.operator) {
      case "is": return Number.isFinite(bound) ? sql`${expression} = ${bound}` : sql`1 = 0`;
      case "not-is":
      case "is_not": return Number.isFinite(bound) ? sql`${expression} <> ${bound}` : sql`1 = 1`;
      case "greater-than":
      case "gt":
      case "is_after": return Number.isFinite(bound) ? sql`${expression} > ${bound}` : sql`1 = 0`;
      case "less-than":
      case "lt":
      case "is_before": return Number.isFinite(bound) ? sql`${expression} < ${bound}` : sql`1 = 0`;
      case "gteq": return Number.isFinite(bound) ? sql`${expression} >= ${bound}` : sql`1 = 0`;
      case "lteq": return Number.isFinite(bound) ? sql`${expression} <= ${bound}` : sql`1 = 0`;
      case "contains": return sql`CAST(${expression} AS TEXT) LIKE ${`%${value}%`}`;
      case "does not contain": return sql`CAST(${expression} AS TEXT) NOT LIKE ${`%${value}%`}`;
      case "is-null":
      case "is_empty": return sql`(${expression} IS NULL OR CAST(${expression} AS TEXT) = '')`;
      case "is-not-null":
      case "is_not_empty": return sql`(${expression} IS NOT NULL AND CAST(${expression} AS TEXT) <> '')`;
      default: return sql`1 = 1`;
    }
  };
  return values.length === 1 ? make(values[0] ?? "") : sql`(${sql.join(values.map(make), negativeFilterOperators.has(filter.operator) ? sql` AND ` : sql` OR `)})`;
}

function aggregateTextFilter(expression: SQL, filter: ExplorerFilter): SQL {
  const values = filter.value.length === 0 ? [""] : filter.value;
  const make = (value: string): SQL => {
    const text = sql`lower(CAST(${expression} AS TEXT))`;
    const expected = value.toLowerCase();
    switch (filter.operator) {
      case "contains": return sql`${text} LIKE ${`%${expected}%`}`;
      case "does not contain": return sql`${text} NOT LIKE ${`%${expected}%`}`;
      case "starts-with": return sql`${text} LIKE ${`${expected}%`}`;
      case "ends-with": return sql`${text} LIKE ${`%${expected}`}`;
      case "is": return sql`${text} = ${expected}`;
      case "not-is":
      case "is_not": return sql`${text} <> ${expected}`;
      case "is-null":
      case "is_empty": return sql`(${expression} IS NULL OR ${text} = '')`;
      case "is-not-null":
      case "is_not_empty": return sql`(${expression} IS NOT NULL AND ${text} <> '')`;
      default: return sql`1 = 1`;
    }
  };
  return values.length === 1 ? make(values[0] ?? "") : sql`(${sql.join(values.map(make), negativeFilterOperators.has(filter.operator) ? sql` AND ` : sql` OR `)})`;
}

async function indexedExplorerRows(
  orgId: string,
  orgName: string,
  query: ExplorerQuery,
  page?: Readonly<{ offset: number; limit: number }>,
  ensureInventory = true,
): Promise<Readonly<{ rows: ExplorerRow[]; total: number }>> {
  if (ensureInventory) await ensureExplorerInventory(orgId);
  if (query.type === "workspaces") {
    const where = indexedWhere(query, orgId, orgName, workspaceInventoryColumns);
    const [rows, total] = await Promise.all([
      db.query.explorerWorkspaceInventory.findMany({ where, orderBy: [...indexedOrders(query, workspaceInventoryColumns, "workspace_updated_at"), asc(sqlColumn("workspace_id"))], ...(page === undefined ? {} : page) }),
      db.select({ total: count() }).from(explorerWorkspaceInventory).where(where),
    ]);
    return { rows: rows.map((row) => inventoryResource(row, orgName)), total: total[0]?.total ?? 0 };
  }
  const keyFilters = query.filter.filter((filter) => filter.field !== "workspace_count" && filter.field !== "workspace-count" && filter.field !== "workspaces");
  const where = and(
    eq(explorerCatalogMemberships.orgId, orgId),
    eq(explorerCatalogMemberships.kind, query.type),
    ...keyFilters.flatMap((filter): SQL[] => {
      const column = columnFor(filter.field, catalogColumns);
      const predicate = column === undefined ? undefined : sqlFilter(column, filter);
      return predicate === undefined ? [] : [predicate];
    }),
  );
  const workspaceCount = countDistinct(explorerCatalogMemberships.workspaceId);
  const workspaces = isPostgres
    ? sql<string>`string_agg(${explorerCatalogMemberships.workspaceName}, ', ' ORDER BY ${explorerCatalogMemberships.workspaceName})`
    : sql<string>`group_concat(${explorerCatalogMemberships.workspaceName}, ', ')`;
  const having = query.filter
    .filter((filter) => filter.field === "workspace_count" || filter.field === "workspace-count")
    .map((filter) => aggregateFilter(workspaceCount, filter));
  having.push(...query.filter.filter((filter) => filter.field === "workspaces").map((filter) => aggregateTextFilter(workspaces, filter)));
  const groupedBase = db.select({
    kind: explorerCatalogMemberships.kind,
    name: explorerCatalogMemberships.name,
    source: explorerCatalogMemberships.source,
    version: explorerCatalogMemberships.version,
    workspaceCount,
    workspaces,
  }).from(explorerCatalogMemberships)
    .where(where)
    .groupBy(explorerCatalogMemberships.kind, explorerCatalogMemberships.name, explorerCatalogMemberships.source, explorerCatalogMemberships.version)
    .having(having.length === 0 ? undefined : and(...having))
    .orderBy(
      ...indexedOrders(query, catalogColumns, "name", { workspace_count: workspaceCount, workspaces }),
      sql`lower(${explorerCatalogMemberships.name})`,
      sql`lower(${explorerCatalogMemberships.source})`,
      sql`lower(${explorerCatalogMemberships.version})`,
      asc(explorerCatalogMemberships.name),
      asc(explorerCatalogMemberships.source),
      asc(explorerCatalogMemberships.version),
    );
  const grouped = page === undefined ? groupedBase : groupedBase.limit(page.limit).offset(page.offset);
  const keyQuery = db.select({ name: explorerCatalogMemberships.name, source: explorerCatalogMemberships.source, version: explorerCatalogMemberships.version })
      .from(explorerCatalogMemberships)
      .where(where)
      .groupBy(explorerCatalogMemberships.name, explorerCatalogMemberships.source, explorerCatalogMemberships.version)
      .having(having.length === 0 ? undefined : and(...having));
  const [rows, total] = await Promise.all([
    grouped,
    db.select({ total: count() }).from(keyQuery.as("explorer_catalog_keys")),
  ]);
  return { rows: rows.map(membershipCatalogResource), total: total[0]?.total ?? 0 };
}

async function executeQuery(orgId: string, orgName: string, query: ExplorerQuery, request: Readonly<{ url: string }>): Promise<{ rows: ExplorerRow[]; number: number; size: number; total: number }> {
  const { number, size } = pageRequest(request);
  const indexed = await indexedExplorerRows(orgId, orgName, query, { offset: (number - 1) * size, limit: size });
  return { rows: applyQuery(indexed.rows, { ...query, filter: [], sort: [] }), number, size, total: indexed.total };
}

function savedQueryResource(saved: typeof explorerSavedQueries.$inferSelect): Record<string, unknown> {
  const query = queryObject(saved.query, saved.queryType) ?? { type: saved.queryType as ViewType, filter: [], fields: [], sort: [] };
  return {
    id: saved.id,
    type: "explorer-saved-queries",
    attributes: {
      name: saved.name,
      "created-at": new Date(saved.createdAt).toISOString(),
      query: { type: query.type, filter: query.filter, fields: query.fields, sort: query.sort },
      "query-type": saved.queryType,
    },
  };
}

function csvFields(query: ExplorerQuery): string[] {
  if (query.fields.length > 0) return [...new Set(query.fields.map((field) => field.replaceAll("-", "_")))];
  return query.type === "workspaces"
    ? [
        "organization_name", "workspace_name", "workspace_created_at", "workspace_updated_at", "terraform_version",
        "execution_mode", "source_module_id", "current_run_status", "current_run_applied_at", "current_run_external_id",
        "current_resource_count", "drifted", "resources_drifted", "resources_undrifted", "all_checks_succeeded",
        "checks_passed", "checks_failed", "checks_errored", "checks_unknown", "vcs_repo_identifier", "tags",
        "project_name", "project_external_id", "providers", "modules", "provider_count", "module_count",
        "state_version_terraform_version", "external_id",
      ]
    : ["name", "source", "version", "workspace_count", "workspaces"];
}

function csvChunk(fields: readonly string[], rows: readonly ExplorerRow[], includeHeader: boolean): string {
  const quote = (value: unknown): string => {
    const text = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const lines = rows.map((row) => fields.map((field) => quote(row.attributes[field] ?? row.attributes[field.replaceAll("_", "-")])).join(","));
  if (includeHeader) lines.unshift(fields.join(","));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function streamingExplorerCsv(
  orgId: string,
  orgName: string,
  query: ExplorerQuery,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const fields = csvFields(query);
  const pageSize = 500;
  let offset = 0;
  let first = true;
  let done = false;
  let reading = false;
  let initialized = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (done || reading) return;
      reading = true;
      try {
        if (!initialized) {
          await ensureExplorerInventory(orgId);
          initialized = true;
        }
        const page = await indexedExplorerRows(orgId, orgName, query, { offset, limit: pageSize }, false);
        const rows = applyQuery(page.rows, { ...query, filter: [], sort: [] });
        if (first || rows.length > 0) controller.enqueue(encoder.encode(csvChunk(fields, rows, first)));
        first = false;
        offset += pageSize;
        if (page.rows.length < pageSize) {
          done = true;
          controller.close();
        }
      } catch (error: unknown) {
        done = true;
        controller.error(error);
      } finally {
        reading = false;
      }
    },
  });
}

async function organizationFor(params: Readonly<Record<string, string>>): Promise<typeof organizations.$inferSelect | undefined> {
  return db.query.organizations.findFirst({ where: eq(organizations.name, params.org_name ?? "") });
}

type ExplorerBulkActionRecord = Readonly<typeof explorerBulkActionRecords.$inferSelect>;

function explorerBulkActionRecordValues(
  workspaceId: string,
  subject: string,
  message: string,
  createdBy: string | null,
  now: number,
): ExplorerBulkActionRecord {
  return {
    id: `ebar-${crypto.randomUUID()}`,
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

function explorerBulkActionError(set: SetObj, status: number, title: string, detail?: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  return error(String(status), title, detail);
}

// Explorer is a preserved backend compatibility surface. Its bulk-action
// contract stores historical Explorer artifacts in the legacy table and emits
// the provider-valid notification trigger, but no public change-request product
// routes or WebUI are exposed.
const MAX_EXPLORER_BULK_ACTION_TARGETS = 500;
const EXPLORER_NOTIFICATION_CONCURRENCY = 10;

function bulkActionQuery(value: unknown): ExplorerQuery | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const type = viewType(raw.type);
  if (type !== "workspaces") return undefined;
  if (raw.filter !== undefined && !Array.isArray(raw.filter)) return undefined;

  const filter = (raw.filter ?? []).flatMap((item): Readonly<Record<string, unknown>>[] => {
    if (item === null || typeof item !== "object") return [];
    const entries = Object.entries(item as Record<string, unknown>);
    if (entries.length !== 1) return [];
    const [field, operations] = entries[0] ?? [];
    if (typeof field !== "string" || operations === null || typeof operations !== "object") return [];
    return Object.entries(operations as Record<string, unknown>).map(([operator, values]) => ({
      field,
      operator,
      value: values,
    }));
  });
  if (filter.length !== (raw.filter ?? []).length) return undefined;
  return queryObject({ type, filter, fields: [], sort: [] });
}

type ExplorerWorkspaceSelection = Readonly<{ ids: string[]; total: number }>;

async function queryWorkspaceIds(
  orgId: string,
  orgName: string,
  query: unknown,
): Promise<ExplorerWorkspaceSelection | undefined> {
  const parsed = bulkActionQuery(query);
  if (parsed === undefined) return undefined;
  const result = await indexedExplorerRows(
    orgId,
    orgName,
    parsed,
    { offset: 0, limit: MAX_EXPLORER_BULK_ACTION_TARGETS + 1 },
  );
  return { ids: result.rows.map((row): string => row.id), total: result.total };
}

export const explorerRoutes = new Elysia({ name: "explorer" })
  .use(authPlugin)
  .post("/api/v2/organizations/:org_name/explorer/bulk-actions", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const organization = await organizationFor(params);
    if (
      organization === undefined
      || !(await checkOrganizationPermission(organization.id, user?.id, tokenOrgId, tokenTeamId, "manage-workspaces"))
    ) return explorerBulkActionError(set, 404, "Not Found");

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
    ) return explorerBulkActionError(set, 422, "Unprocessable Entity", "Valid bulk-action inputs and exactly one target selector are required");

    let selectedIds: string[] | undefined;
    let selectedTotal: number | undefined;
    if (targetIds !== undefined) {
      if (
        !Array.isArray(targetIds)
        || targetIds.length === 0
        || targetIds.length > MAX_EXPLORER_BULK_ACTION_TARGETS
        || targetIds.some((id): boolean => typeof id !== "string")
      ) {
        return explorerBulkActionError(set, 422, "Unprocessable Entity", `target_ids must contain between 1 and ${MAX_EXPLORER_BULK_ACTION_TARGETS} workspace IDs`);
      }
      const requestedIds = [...new Set(targetIds as string[])];
      const candidates = await db.query.workspaces.findMany({
        columns: { id: true },
        where: and(eq(workspaces.orgId, organization.id), inArray(workspaces.id, requestedIds)),
      });
      const candidateIds = new Set(candidates.map((workspace): string => workspace.id));
      selectedIds = requestedIds;
      if (selectedIds.some((id): boolean => !candidateIds.has(id))) selectedIds = undefined;
    } else {
      const selection = await queryWorkspaceIds(organization.id, organization.name, query);
      selectedIds = selection?.ids;
      selectedTotal = selection?.total;
    }
    if (selectedIds === undefined || selectedIds.length === 0) {
      return explorerBulkActionError(set, 422, "Unprocessable Entity", "The target selector did not resolve to workspaces");
    }
    if (
      selectedIds.length > MAX_EXPLORER_BULK_ACTION_TARGETS
      || (selectedTotal !== undefined && selectedTotal > MAX_EXPLORER_BULK_ACTION_TARGETS)
    ) {
      return explorerBulkActionError(set, 422, "Unprocessable Entity", `The target selector matches more than ${MAX_EXPLORER_BULK_ACTION_TARGETS} workspaces`);
    }

    const now = Date.now();
    const records = selectedIds.map((workspaceId): ExplorerBulkActionRecord =>
      explorerBulkActionRecordValues(workspaceId, subject, message, user?.id ?? null, now));
    await db.transaction(async (tx): Promise<void> => {
      await tx.insert(explorerBulkActionRecords).values(records);
      await tx.insert(auditLogs).values(records.map((record) => ({
        id: crypto.randomUUID(),
        orgId: organization.id,
        userId: user?.id ?? null,
        action: "create",
        resourceType: "explorer-bulk-action-records",
        resourceId: record.id,
        details: {
          workspaceId: record.workspaceId,
          toStatus: "pending",
        },
        createdAt: now,
      })));
    });
    // Notifications reread the committed Explorer bulk-action rows. Dispatching only
    // after commit prevents a failed transaction from producing a notification
    // for a row that never became durable.
    for (let i = 0; i < records.length; i += EXPLORER_NOTIFICATION_CONCURRENCY) {
      await Promise.all(records
        .slice(i, i + EXPLORER_NOTIFICATION_CONCURRENCY)
        .map((record): Promise<void> => queueExplorerBulkActionNotification(record.id)));
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
  .get("/api/v2/organizations/:org_name/explorer", async ({ params, user, request, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    if (org === undefined || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    const query = urlQuery(new URL(request.url));
    if (query === undefined) { (set as { status: number }).status = 422; return error("422", "Unprocessable Entity", "type must be one of workspaces, tf_versions, providers, or modules"); }
    const result = await executeQuery(org.id, org.name, query, request);
    return { data: result.rows, ...pagination(request, result.number, result.size, result.total) };
  })
  .get("/api/v2/organizations/:org_name/explorer/export/csv", async ({ params, user, request, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    if (org === undefined || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    const query = urlQuery(new URL(request.url));
    if (query === undefined) { (set as { status: number }).status = 422; return error("422", "Unprocessable Entity", "type is required"); }
    return new Response(streamingExplorerCsv(org.id, org.name, query), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=explorer-${query.type}.csv` } });
  })
  .get("/api/v2/organizations/:org_name/explorer/views", async ({ params, user, request, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    if (org === undefined || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    const views = await db.query.explorerSavedQueries.findMany({ where: eq(explorerSavedQueries.orgId, org.id), orderBy: [desc(explorerSavedQueries.createdAt)] });
    const { number, size } = pageRequest(request);
    return { data: views.slice((number - 1) * size, number * size).map(savedQueryResource), ...pagination(request, number, size, views.length) };
  })
  .post("/api/v2/organizations/:org_name/explorer/views", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    if (org === undefined || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    const query = queryObject(data?.query, data?.query_type ?? data?.["query-type"]);
    if (name === "" || query === undefined) { (set as { status: number }).status = 422; return error("422", "Unprocessable Entity", "name, query_type, and query are required"); }
    const saved: typeof explorerSavedQueries.$inferInsert = { id: `sq-${crypto.randomUUID()}`, orgId: org.id, name, queryType: query.type, query: { type: query.type, filter: query.filter, fields: query.fields, sort: query.sort }, createdAt: Date.now() };
    await db.insert(explorerSavedQueries).values(saved);
    (set as { status: number }).status = 201;
    return { data: savedQueryResource(saved as typeof explorerSavedQueries.$inferSelect) };
  })
  .get("/api/v2/organizations/:org_name/explorer/views/:view_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    const view = org === undefined ? undefined : await db.query.explorerSavedQueries.findFirst({ where: eq(explorerSavedQueries.id, params.view_id ?? "") });
    if (org === undefined || view === undefined || view.orgId !== org.id || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    return { data: savedQueryResource(view) };
  })
  .patch("/api/v2/organizations/:org_name/explorer/views/:view_id", async ({ params, user, body, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    const view = org === undefined ? undefined : await db.query.explorerSavedQueries.findFirst({ where: eq(explorerSavedQueries.id, params.view_id ?? "") });
    if (org === undefined || view === undefined || view.orgId !== org.id || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    const query = queryObject(data?.query, data?.query_type ?? data?.["query-type"] ?? view.queryType);
    if (name === "" || query === undefined) { (set as { status: number }).status = 422; return error("422", "Unprocessable Entity", "name and query are required"); }
    await db.update(explorerSavedQueries).set({ name, queryType: query.type, query: { type: query.type, filter: query.filter, fields: query.fields, sort: query.sort } }).where(eq(explorerSavedQueries.id, view.id));
    const updated = { ...view, name, queryType: query.type, query: { type: query.type, filter: query.filter, fields: query.fields, sort: query.sort } };
    return { data: savedQueryResource(updated) };
  })
  .delete("/api/v2/organizations/:org_name/explorer/views/:view_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    const view = org === undefined ? undefined : await db.query.explorerSavedQueries.findFirst({ where: eq(explorerSavedQueries.id, params.view_id ?? "") });
    if (org === undefined || view === undefined || view.orgId !== org.id || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    await db.delete(explorerSavedQueries).where(eq(explorerSavedQueries.id, view.id));
    return { data: savedQueryResource(view) };
  })
  .get("/api/v2/organizations/:org_name/explorer/views/:view_id/results", async ({ params, user, request, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    const view = org === undefined ? undefined : await db.query.explorerSavedQueries.findFirst({ where: eq(explorerSavedQueries.id, params.view_id ?? "") });
    if (org === undefined || view === undefined || view.orgId !== org.id || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    const query = queryObject(view.query, view.queryType);
    if (query === undefined) { (set as { status: number }).status = 500; return error("500", "Internal Server Error"); }
    const result = await executeQuery(org.id, org.name, query, request);
    return { data: result.rows, ...pagination(request, result.number, result.size, result.total) };
  })
  .get("/api/v2/organizations/:org_name/explorer/views/:view_id/csv", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await organizationFor(params);
    const view = org === undefined ? undefined : await db.query.explorerSavedQueries.findFirst({ where: eq(explorerSavedQueries.id, params.view_id ?? "") });
    if (org === undefined || view === undefined || view.orgId !== org.id || !(await canExplore(org.id, user?.id, tokenOrgId, tokenTeamId))) {
      (set as { status: number }).status = 404; return error("404", "Not Found");
    }
    const query = queryObject(view.query, view.queryType);
    if (query === undefined) { (set as { status: number }).status = 500; return error("500", "Internal Server Error"); }
    return new Response(streamingExplorerCsv(org.id, org.name, query), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=${view.id}.csv` } });
  })
  ;
