import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { count } from "drizzle-orm";
import { Elysia } from "elysia";
import { authPlugin } from "../auth";
import { db } from "../db";
import { workspaces } from "../db/schema";

type Status = "OK" | "WARNING" | "ERROR";
type BundleStatus = "generating" | "finished" | "errored" | "deleted";
type SetObject = Readonly<{
  status?: number | string;
  headers: Readonly<Record<string, string | number>>;
}>;
type SystemContext = Readonly<{
  body?: unknown;
  params: Readonly<Record<string, string>>;
  request: Readonly<{
    url: string;
    headers: Readonly<{ get: (name: string) => string | null }>;
  }>;
  set: SetObject;
  user?: Readonly<{ isSiteAdmin?: boolean | null }> | null;
}>;
type DiagnosticCheck = Readonly<{ name: string; status: Status }>;
type DiagnosticGroup = Readonly<{
  group: string;
  status: Status;
  checks: readonly DiagnosticCheck[];
}>;
type DiagnosticResult = Readonly<{
  node: string;
  status: Status;
  createdAt: string;
  duration: number;
  checks: readonly DiagnosticGroup[];
}>;
type QueryUrl = Readonly<{
  searchParams: Readonly<{
    getAll: (name: string) => readonly string[];
  }>;
}>;
type BundleNode = Readonly<{
  node: string;
  status: BundleStatus;
  sizeBytes?: number;
  error?: string | null;
  completedAt?: string;
}>;
type BundleRecord = Readonly<{
  id: string;
  status: BundleStatus;
  createdAt: string;
  completedAt?: string;
  sizeBytes?: number;
  error?: string | null;
  nodes: readonly BundleNode[];
}>;

const ALL_CHECKS = {
  database: ["connection"],
  storage: ["read_write"],
  runtime: ["version"],
} as const;
const BUNDLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORT_BUNDLE_PATH = "/api/v1/support/bundle-requests";
const SUPPORT_BUNDLE_COMPATIBILITY_PATH = "/api/v1/support-bundle-requests";
let diagnosticsRunning = false;

function storageDirectory(): string {
  return resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
}

function supportBundleDirectory(): string {
  return join(storageDirectory(), "support-bundles");
}

function errorResponse(set: SetObject, status: number, title: string, detail?: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  return {
    errors: [{
      status: String(status),
      title,
      ...(detail === undefined ? {} : { detail }),
    }],
  };
}

function requireSiteAdmin(user: SystemContext["user"], set: SetObject): Record<string, unknown> | undefined {
  if (user === null || user === undefined) return errorResponse(set, 401, "Unauthorized");
  return user.isSiteAdmin === true ? undefined : errorResponse(set, 403, "Forbidden");
}

function worstStatus(statuses: readonly Status[]): Status {
  if (statuses.includes("ERROR")) return "ERROR";
  if (statuses.includes("WARNING")) return "WARNING";
  return "OK";
}

function requestedChecks(url: QueryUrl): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  const values = url.searchParams.getAll("check").flatMap((value): string[] => value.split(","));
  const selected = new Map<string, Set<string>>();
  if (values.length === 0) {
    for (const [group, checks] of Object.entries(ALL_CHECKS)) selected.set(group, new Set(checks));
    return selected;
  }

  for (const value of values) {
    const [group, check, extra] = value.trim().split(".");
    const available = group === undefined
      ? undefined
      : ALL_CHECKS[group as keyof typeof ALL_CHECKS] as readonly string[] | undefined;
    if (group === "" || extra !== undefined || available === undefined || (check !== undefined && !available.includes(check))) {
      return undefined;
    }
    const checks = selected.get(group) ?? new Set<string>();
    if (check === undefined) available.forEach((name): void => { checks.add(name); });
    else checks.add(check);
    selected.set(group, checks);
  }
  return selected;
}

async function diagnosticGroups(
  selected: Readonly<ReadonlyMap<string, Readonly<ReadonlySet<string>>>>,
): Promise<readonly DiagnosticGroup[]> {
  const checks = new Map<string, Promise<DiagnosticCheck>>();
  if (selected.get("database")?.has("connection") === true) {
    checks.set("database.connection", db.query.users.findFirst()
      .then((): DiagnosticCheck => ({ name: "connection", status: "OK" }))
      .catch((): DiagnosticCheck => ({ name: "connection", status: "ERROR" })));
  }
  if (selected.get("storage")?.has("read_write") === true) {
    checks.set("storage.read_write", access(storageDirectory(), constants.R_OK | constants.W_OK)
      .then((): DiagnosticCheck => ({ name: "read_write", status: "OK" }))
      .catch((): DiagnosticCheck => ({ name: "read_write", status: "ERROR" })));
  }
  if (selected.get("runtime")?.has("version") === true) {
    checks.set("runtime.version", Promise.resolve({ name: "version", status: "OK" }));
  }

  const resolved = new Map<string, DiagnosticCheck>(
    await Promise.all([...checks].map(async ([key, check]): Promise<[string, DiagnosticCheck]> => [key, await check])),
  );
  return [...selected].map(([group, names]): DiagnosticGroup => {
    const groupChecks = [...names]
      .map((name): DiagnosticCheck | undefined => resolved.get(`${group}.${name}`))
      .filter((check): check is DiagnosticCheck => check !== undefined);
    return { group, status: worstStatus(groupChecks.map((check): Status => check.status)), checks: groupChecks };
  });
}

async function runDiagnostics(
  selected: Readonly<ReadonlyMap<string, Readonly<ReadonlySet<string>>>>,
  timeoutSeconds: number,
): Promise<DiagnosticResult> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<readonly DiagnosticGroup[]>((resolvePromise): void => {
    timer = setTimeout((): void => {
      resolvePromise([{ group: "system", status: "ERROR", checks: [{ name: "timeout", status: "ERROR" }] }]);
    }, timeoutSeconds * 1000);
  });
  const checks = await Promise.race([diagnosticGroups(selected), timed]);
  if (timer !== undefined) clearTimeout(timer);
  return {
    node: hostname(),
    status: worstStatus(checks.map((group): Status => group.status)),
    createdAt: new Date().toISOString(),
    duration: Number(((performance.now() - startedAt) / 1000).toFixed(6)),
    checks,
  };
}

function diagnosticResource(result: DiagnosticResult): Record<string, unknown> {
  return {
    node: result.node,
    status: result.status,
    created_at: result.createdAt,
    duration: result.duration,
    checks: result.checks,
  };
}

async function createUsageBundle(): Promise<Record<string, unknown>> {
  const timestamp = new Date().toISOString();
  const countRows = await db.select({ value: count() }).from(workspaces);
  const snapshot = {
    snapshot_version: 2,
    id: crypto.randomUUID(),
    timestamp,
    schema_version: "2.0.0",
    product: "terraform",
    process_id: hostname(),
    metrics: {
      workspacecount: {
        key: "workspacecount",
        value: countRows[0]?.value ?? 0,
        mode: "write",
      },
    },
    product_version: process.env["BUILD_VERSION"] ?? "dev",
    license_id: "unlicensed",
    metadata: {},
  };
  const signature = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return {
    version: "2",
    mode: "automatic",
    timestamp,
    signature,
    checksum: Number.parseInt(signature.slice(0, 13), 16),
    snapshots: [{ ...snapshot, checksum: Number.parseInt(signature.slice(0, 13), 16) }],
  };
}

function isBundleRecord(value: unknown): value is BundleRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const nodes = record["nodes"];
  return typeof record["id"] === "string"
    && BUNDLE_ID_PATTERN.test(record["id"])
    && ["generating", "finished", "errored", "deleted"].includes(String(record["status"]))
    && typeof record["createdAt"] === "string"
    && Array.isArray(nodes)
    && nodes.every((node): boolean => node !== null
      && typeof node === "object"
      && typeof (node as Record<string, unknown>)["node"] === "string"
      && ["generating", "finished", "errored", "deleted"].includes(
        String((node as Record<string, unknown>)["status"]),
      ));
}

async function saveBundle(record: BundleRecord): Promise<void> {
  const directory = supportBundleDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${record.id}.json`);
  const temporary = join(directory, `.${record.id}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function loadBundle(id: string): Promise<BundleRecord | undefined> {
  if (!BUNDLE_ID_PATTERN.test(id)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(supportBundleDirectory(), `${id}.json`), "utf8"));
    return isBundleRecord(parsed) && parsed.id === id ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function loadBundles(): Promise<readonly BundleRecord[]> {
  try {
    const names = (await readdir(supportBundleDirectory()))
      .filter((name): boolean => BUNDLE_ID_PATTERN.test(name.slice(0, -5)) && name.endsWith(".json"));
    const records = await Promise.all(names.map(async (name): Promise<BundleRecord | undefined> => {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(supportBundleDirectory(), name), "utf8"));
        return isBundleRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }));
    return records.filter((record): record is BundleRecord => record !== undefined && record.status !== "deleted");
  } catch {
    return [];
  }
}

function bundleResource(record: BundleRecord): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    status: record.status,
    created_at: record.createdAt,
    nodes: record.nodes.map((node): Record<string, unknown> => ({
      node: node.node,
      status: node.status,
      error: node.error ?? null,
      ...(node.sizeBytes === undefined ? {} : { size_bytes: node.sizeBytes }),
      ...(node.completedAt === undefined ? {} : { completed_at: node.completedAt }),
    })),
    ...(record.completedAt === undefined ? {} : { completed_at: record.completedAt }),
    ...(record.sizeBytes === undefined ? {} : { size_bytes: record.sizeBytes }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
  const self = `/api/v1/support/bundle-requests/${record.id}`;
  return {
    id: record.id,
    type: "support-bundle",
    attributes,
    links: {
      self,
      ...(record.status === "finished" ? { download: `${self}/download` } : {}),
    },
  };
}

async function generateSupportBundle(record: BundleRecord): Promise<void> {
  try {
    const selected = requestedChecks(new URL("http://localhost")) ?? new Map<string, Set<string>>();
    const [diagnostics, usage] = await Promise.all([
      runDiagnostics(selected, 30),
      createUsageBundle(),
    ]);
    const node = record.nodes[0]?.node ?? hostname();
    const prefix = `${record.id}/${node}`;
    const bundlePath = join(supportBundleDirectory(), `${record.id}.tar.gz`);
    await Bun.Archive.write(bundlePath, {
      [`${prefix}/diagnostics.json`]: `${JSON.stringify([diagnosticResource(diagnostics)], null, 2)}\n`,
      [`${prefix}/usage.json`]: `${JSON.stringify(usage, null, 2)}\n`,
      [`${prefix}/instance.json`]: `${JSON.stringify({
        version: process.env["BUILD_VERSION"] ?? "dev",
        build: process.env["BUILD_SHA"] ?? "unknown",
        node,
        created_at: record.createdAt,
      }, null, 2)}\n`,
    }, { compress: "gzip" });
    await chmod(bundlePath, 0o600);
    const bundleStat = await stat(bundlePath);
    const completedAt = new Date().toISOString();
    await saveBundle({
      ...record,
      status: "finished",
      completedAt,
      sizeBytes: bundleStat.size,
      nodes: record.nodes.map((bundleNode): BundleNode => ({
        ...bundleNode,
        status: "finished",
        sizeBytes: bundleStat.size,
        error: null,
        completedAt,
      })),
    });
  } catch {
    const completedAt = new Date().toISOString();
    await saveBundle({
      ...record,
      status: "errored",
      completedAt,
      error: "Bundle generation failed",
      nodes: record.nodes.map((node): BundleNode => ({
        ...node,
        status: "errored",
        error: "Bundle generation failed",
        completedAt,
      })),
    });
  }
}

function requestedNodes(url: QueryUrl): readonly string[] | undefined {
  const values = url.searchParams.getAll("nodes");
  if (values.some((value): boolean => value === "")) return undefined;
  return values;
}

async function createSupportBundle({ body, set, user }: SystemContext): Promise<unknown> {
  const forbidden = requireSiteAdmin(user, set);
  if (forbidden !== undefined) return forbidden;
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const suppliedNodes = payload["nodes"];
  if (suppliedNodes !== undefined && (!Array.isArray(suppliedNodes)
    || suppliedNodes.length === 0
    || suppliedNodes.some((node): boolean => typeof node !== "string" || node === ""))) {
    return errorResponse(set, 400, "Bad Request", "nodes must be a non-empty array of node identifiers");
  }
  const nodes = suppliedNodes === undefined ? [hostname()] : [...new Set(suppliedNodes as string[])];
  if (nodes.some((node): boolean => node !== hostname())) {
    return errorResponse(set, 404, "Not Found", "Node not found");
  }
  const record: BundleRecord = {
    id: crypto.randomUUID(),
    status: "generating",
    createdAt: new Date().toISOString(),
    nodes: nodes.map((node): BundleNode => ({ node, status: "generating", error: null })),
  };
  await saveBundle(record);
  void generateSupportBundle(record).catch((): undefined => undefined);
  (set as { status: number }).status = 202;
  return { data: bundleResource(record) };
}

async function listSupportBundles({ request, set, user }: SystemContext): Promise<unknown> {
  const forbidden = requireSiteAdmin(user, set);
  if (forbidden !== undefined) return forbidden;
  const url = new URL(request.url);
  const numberValue = url.searchParams.get("page[number]") ?? "1";
  const sizeValue = url.searchParams.get("page[size]") ?? "20";
  const pageNumber = Number(numberValue);
  const pageSize = Number(sizeValue);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return errorResponse(set, 400, "Bad Request", "Invalid pagination");
  }
  const statusFilter = url.searchParams.get("filter[status]");
  if (statusFilter !== null && !["generating", "finished", "errored"].includes(statusFilter)) {
    return errorResponse(set, 400, "Bad Request", "Invalid status filter");
  }
  const createdAfter = url.searchParams.get("filter[created_after]");
  const createdBefore = url.searchParams.get("filter[created_before]");
  if ((createdAfter !== null && Number.isNaN(Date.parse(createdAfter)))
    || (createdBefore !== null && Number.isNaN(Date.parse(createdBefore)))) {
    return errorResponse(set, 400, "Bad Request", "Invalid creation date filter");
  }
  const nodeFilters = url.searchParams.getAll("filter[nodes]");
  const filtered = (await loadBundles())
    .filter((record): boolean => statusFilter === null || record.status === statusFilter)
    .filter((record): boolean => createdAfter === null || Date.parse(record.createdAt) > Date.parse(createdAfter))
    .filter((record): boolean => createdBefore === null || Date.parse(record.createdAt) < Date.parse(createdBefore))
    .filter((record): boolean => nodeFilters.length === 0
      || nodeFilters.every((node): boolean => record.nodes.some((item): boolean => item.node === node)))
    .sort((left, right): number => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
  const pageLink = (target: number): string => `${SUPPORT_BUNDLE_PATH}?page[number]=${target}&page[size]=${pageSize}`;
  return {
    data: page.map(bundleResource),
    meta: {
      pagination: {
        current_page: pageNumber,
        total_pages: totalPages,
        total_count: totalCount,
      },
    },
    links: {
      self: pageLink(pageNumber),
      first: pageLink(1),
      prev: pageNumber > 1 ? pageLink(pageNumber - 1) : null,
      next: pageNumber < totalPages ? pageLink(pageNumber + 1) : null,
      last: pageLink(totalPages),
    },
  };
}

async function downloadSupportBundle({ params, request, set, user }: SystemContext): Promise<unknown> {
  const forbidden = requireSiteAdmin(user, set);
  if (forbidden !== undefined) return forbidden;
  const id = params["id"] ?? "";
  const record = await loadBundle(id);
  if (record === undefined) return errorResponse(set, 404, "Not Found", "Support bundle request not found");
  if (record.status === "deleted") return errorResponse(set, 410, "Gone", "Support bundle was deleted");
  if (record.status !== "finished") return errorResponse(set, 409, "Conflict", "Support bundle is not ready");
  const nodes = requestedNodes(new URL(request.url));
  if (nodes === undefined || nodes.some((node): boolean => !record.nodes.some((item): boolean => item.node === node))) {
    return errorResponse(set, 400, "Bad Request", "Unknown or empty node identifier");
  }
  const path = join(supportBundleDirectory(), `${record.id}.tar.gz`);
  if (!(await Bun.file(path).exists())) return errorResponse(set, 500, "Internal Server Error", "Support bundle artifact is missing");
  const headers = set.headers as Record<string, string | number>;
  headers["Content-Type"] = "application/gzip";
  headers["Content-Disposition"] = `attachment; filename=support-bundle-${record.id}.tar.gz`;
  return Bun.file(path);
}

async function getSupportBundle({ params, set, user }: SystemContext): Promise<unknown> {
  const forbidden = requireSiteAdmin(user, set);
  if (forbidden !== undefined) return forbidden;
  const record = await loadBundle(params["id"] ?? "");
  if (record === undefined) return errorResponse(set, 404, "Not Found", "Support bundle request not found");
  if (record.status === "deleted") return errorResponse(set, 410, "Gone", "Support bundle was deleted");
  return { data: bundleResource(record) };
}

async function deleteSupportBundle({ params, set, user }: SystemContext): Promise<unknown> {
  const forbidden = requireSiteAdmin(user, set);
  if (forbidden !== undefined) return forbidden;
  const record = await loadBundle(params["id"] ?? "");
  if (record === undefined) return errorResponse(set, 404, "Not Found", "Support bundle request not found");
  if (record.status === "deleted") return errorResponse(set, 410, "Gone", "Support bundle was deleted");
  if (record.status === "generating") return errorResponse(set, 409, "Conflict", "Support bundle is still generating");
  try {
    await unlink(join(supportBundleDirectory(), `${record.id}.tar.gz`));
  } catch {
    // A failed bundle has no artifact; retain the tombstone either way.
  }
  await saveBundle({ ...record, status: "deleted" });
  (set as { status: number }).status = 204;
  return new Response(null, { status: 204 });
}

export const systemAdminRoutes = new Elysia({ name: "system-admin" })
  .use(authPlugin)
  .get("/api/v1/diagnostics", async ({ request, set, user }: SystemContext): Promise<unknown> => {
    const forbidden = requireSiteAdmin(user, set);
    if (forbidden !== undefined) return forbidden;

    const accept = request.headers.get("accept");
    if (accept !== null && !accept.split(",").some((value): boolean => {
      const mediaType = value.split(";")[0]?.trim();
      return mediaType === "application/json" || mediaType === "*/*";
    })) return errorResponse(set, 406, "Not Acceptable", "Only application/json is supported");

    const url = new URL(request.url);
    const timeoutValue = url.searchParams.get("timeout") ?? "30";
    if (!/^\d+$/.test(timeoutValue) || Number(timeoutValue) < 1 || Number(timeoutValue) > 300) {
      return errorResponse(set, 400, "Bad Request", "timeout must be an integer from 1 to 300");
    }
    const selected = requestedChecks(url);
    if (selected === undefined) return errorResponse(set, 400, "Bad Request", "Unknown or empty diagnostic check");
    const nodes = requestedNodes(url);
    if (nodes === undefined || nodes.some((node): boolean => node !== hostname())) {
      return errorResponse(set, 400, "Bad Request", "Unknown or empty node identifier");
    }
    if (diagnosticsRunning) return errorResponse(set, 429, "Too Many Requests", "Another diagnostic check is already running");

    diagnosticsRunning = true;
    try {
      const result = await runDiagnostics(selected, Number(timeoutValue));
      return Response.json([diagnosticResource(result)], {
        status: result.status === "ERROR" ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      diagnosticsRunning = false;
    }
  })
  .get("/api/v1/usage/bundle", async ({ set, user }: SystemContext): Promise<unknown> => {
    const forbidden = requireSiteAdmin(user, set);
    if (forbidden !== undefined) return forbidden;
    return Response.json(await createUsageBundle(), {
      headers: { "Content-Type": "application/json" },
    });
  })
  // The slash path is TFE's canonical API. The hyphenated alias preserves this
  // project's original SPEC contract without duplicating the implementation.
  .post(SUPPORT_BUNDLE_PATH, createSupportBundle)
  .get(SUPPORT_BUNDLE_PATH, listSupportBundles)
  .get(`${SUPPORT_BUNDLE_PATH}/:id/download`, downloadSupportBundle)
  .get(`${SUPPORT_BUNDLE_PATH}/:id`, getSupportBundle)
  .delete(`${SUPPORT_BUNDLE_PATH}/:id`, deleteSupportBundle)
  .post(SUPPORT_BUNDLE_COMPATIBILITY_PATH, createSupportBundle)
  .get(SUPPORT_BUNDLE_COMPATIBILITY_PATH, listSupportBundles)
  .get(`${SUPPORT_BUNDLE_COMPATIBILITY_PATH}/:id/download`, downloadSupportBundle)
  .get(`${SUPPORT_BUNDLE_COMPATIBILITY_PATH}/:id`, downloadSupportBundle)
  .delete(`${SUPPORT_BUNDLE_COMPATIBILITY_PATH}/:id`, deleteSupportBundle);
