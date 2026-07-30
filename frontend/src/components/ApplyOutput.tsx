/* eslint-disable @typescript-eslint/naming-convention -- Terraform plan/apply JSON fields are snake_case. */
import { createElement, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Eye,
  FileCode,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { ApiError, fetchApi } from "../lib/api";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";

type Change = {
  actions: string[];
  before: unknown;
  after: unknown;
  after_unknown?: unknown;
  before_sensitive?: unknown;
  after_sensitive?: unknown;
  replace_paths?: readonly (readonly (string | number)[])[];
  importing?: {
    id?: string;
    unknown?: boolean;
  };
};

type ResourceChange = {
  address: string;
  deposed?: string;
  module_address?: string;
  mode?: string;
  type: string;
  name?: string;
  previous_address?: string;
  provider_name?: string;
  action_reason?: string;
  change: Change;
};

type PlanJson = {
  resource_changes?: ResourceChange[];
  terraform_version?: string;
  format_version?: string;
};

type Operation = "create" | "update" | "delete" | "replace" | "read" | "import" | "move" | "remove" | "no-op";

export type ExecutionState =
  | "pending"
  | "creating"
  | "created"
  | "modifying"
  | "modified"
  | "destroying"
  | "destroyed"
  | "replacing"
  | "replaced"
  | "importing"
  | "imported"
  | "moving"
  | "moved"
  | "removing"
  | "removed"
  | "failed";

type ResourceExecutionInfo = {
  state: ExecutionState;
  elapsed?: string | undefined;
  resourceId?: string | undefined;
  error?: string | undefined;
};

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; plan: PlanJson }>;

const operationConfig = {
  create: { icon: Plus, label: "create", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  update: { icon: RefreshCw, label: "change", className: "border-blue-200 bg-blue-50 text-blue-700" },
  delete: { icon: Trash2, label: "destroy", className: "border-red-200 bg-red-50 text-red-700" },
  replace: { icon: RefreshCw, label: "replace", className: "border-amber-200 bg-amber-50 text-amber-700" },
  read: { icon: Eye, label: "read", className: "border-purple-200 bg-purple-50 text-purple-700" },
  import: { icon: Download, label: "import", className: "border-teal-200 bg-teal-50 text-teal-700" },
  move: { icon: ArrowRight, label: "move", className: "border-slate-300 bg-slate-100 text-slate-700" },
  remove: { icon: Trash2, label: "removed from state", className: "border-slate-300 bg-slate-100 text-slate-700" },
  "no-op": { icon: RefreshCw, label: "no-op", className: "border-gray-200 bg-gray-50 text-gray-500" },
} satisfies Record<Operation, Readonly<{ icon: typeof Plus; label: string; className: string }>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationFor(actions: readonly string[], actionReason?: string): Operation {
  if (actions.includes("create") && actions.includes("delete")) return "replace";
  if (actions.includes("create")) return "create";
  if (actions.includes("delete")) {
    if (actionReason === "delete_because_no_resource_config" || actionReason === "removed_from_state") {
      return "remove";
    }
    return "delete";
  }
  if (actions.includes("update")) return "update";
  if (actions.includes("read")) return "read";
  return "no-op";
}

function operationForResource(resource: ResourceChange): Operation {
  const operation = operationFor(resource.change.actions, resource.action_reason);
  if (operation !== "no-op") return operation;
  if (resource.change.importing !== undefined) return "import";
  if (resource.previous_address !== undefined) return "move";
  return "no-op";
}

function parseApplyLogsToExecMap(
  logs: string,
  resources: readonly ResourceChange[],
  applyFinished: boolean,
  applyFailed: boolean,
): Map<string, ResourceExecutionInfo> {
  const map = new Map<string, ResourceExecutionInfo>();

  for (const resource of resources) {
    const op = operationForResource(resource);
    if (op === "no-op") continue;

    if (applyFinished && !applyFailed) {
      const finalState: ExecutionState =
        op === "create" ? "created" :
        op === "update" ? "modified" :
        op === "delete" ? "destroyed" :
        op === "replace" ? "replaced" :
        op === "import" ? "imported" :
        op === "move" ? "moved" :
        op === "remove" ? "removed" : "created";
      map.set(resource.address, { state: finalState });
    } else {
      map.set(resource.address, { state: "pending" });
    }
  }

  if (logs === "") return map;

  const lines = logs.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("{")) {
      try {
        const json = JSON.parse(trimmed) as Record<string, unknown>;
        const type = json["type"];
        const hook = isRecord(json["hook"]) ? json["hook"] : undefined;
        const resObj = isRecord(hook?.["resource"]) ? hook["resource"] : undefined;
        const addr = typeof resObj?.["addr"] === "string" ? resObj["addr"] : undefined;

        if (addr !== undefined && map.has(addr)) {
          if (type === "apply_start") {
            const act = typeof hook?.["action"] === "string" ? hook["action"] : "";
            const st: ExecutionState =
              act === "create" ? "creating" :
              act === "update" ? "modifying" :
              act === "delete" ? "destroying" : "creating";
            map.set(addr, { state: st });
          } else if (type === "apply_progress") {
            const current = map.get(addr);
            const elapsed = typeof hook?.["elapsed_seconds"] === "number" ? `${hook["elapsed_seconds"]}s` : undefined;
            if (current !== undefined) {
              map.set(addr, { ...current, elapsed });
            }
          } else if (type === "apply_complete") {
            const act = typeof hook?.["action"] === "string" ? hook["action"] : "";
            const idVal = typeof hook?.["id_value"] === "string" ? hook["id_value"] : undefined;
            const st: ExecutionState =
              act === "create" ? "created" :
              act === "update" ? "modified" :
              act === "delete" ? "destroyed" : "created";
            map.set(addr, { state: st, resourceId: idVal });
          } else if (type === "apply_errored") {
            map.set(addr, { state: "failed", error: "Apply errored" });
          }
        }
        continue;
      } catch {}
    }

    for (const address of map.keys()) {
      if (!line.includes(address)) continue;

      if (line.includes(": Creating...")) {
        map.set(address, { state: "creating" });
      } else if (line.includes(": Creation complete after")) {
        const match = line.match(/Creation complete after ([^[\s]+)/);
        const elapsed = match?.[1];
        const idMatch = line.match(/\[id=([^\]]+)\]/);
        map.set(address, { state: "created", elapsed, resourceId: idMatch?.[1] });
      } else if (line.includes(": Modifying...")) {
        map.set(address, { state: "modifying" });
      } else if (line.includes(": Modifications complete after")) {
        const match = line.match(/Modifications complete after ([^[\s]+)/);
        map.set(address, { state: "modified", elapsed: match?.[1] });
      } else if (line.includes(": Destroying...")) {
        map.set(address, { state: "destroying" });
      } else if (line.includes(": Destruction complete after")) {
        const match = line.match(/Destruction complete after ([^[\s]+)/);
        map.set(address, { state: "destroyed", elapsed: match?.[1] });
      } else if (line.includes(": Still creating...")) {
        const match = line.match(/\[(.*?) elapsed\]/);
        map.set(address, { state: "creating", elapsed: match?.[1] });
      } else if (line.includes(": Still modifying...")) {
        const match = line.match(/\[(.*?) elapsed\]/);
        map.set(address, { state: "modifying", elapsed: match?.[1] });
      } else if (line.includes(": Still destroying...")) {
        const match = line.match(/\[(.*?) elapsed\]/);
        map.set(address, { state: "destroying", elapsed: match?.[1] });
      } else if (line.includes(": Error") || line.includes("Error: ")) {
        map.set(address, { state: "failed", error: line });
      }
    }
  }

  if (applyFailed) {
    for (const [address, current] of map.entries()) {
      if (["creating", "modifying", "destroying", "replacing"].includes(current.state)) {
        map.set(address, { state: "failed", error: "Apply failed during execution" });
      }
    }
  }

  return map;
}

function ExecutionBadge({ execution }: Readonly<{ execution: ResourceExecutionInfo }>): React.JSX.Element {
  const { state, elapsed } = execution;

  if (state === "pending") {
    return (
      <Badge variant="outline" className="gap-1 rounded-md border-gray-300 bg-gray-100 font-medium text-gray-600">
        <Clock className="size-3 text-gray-400" />
        Pending
      </Badge>
    );
  }

  if (["creating", "modifying", "destroying", "replacing", "importing", "moving", "removing"].includes(state)) {
    return (
      <Badge variant="outline" className="gap-1.5 rounded-md border-blue-300 bg-blue-50 font-medium text-blue-700 animate-pulse">
        <Spinner className="size-3 text-blue-600" />
        <span className="capitalize">{state}...</span>
        {elapsed !== undefined && <span className="font-mono text-[10px] text-blue-500">[{elapsed}]</span>}
      </Badge>
    );
  }

  if (state === "failed") {
    return (
      <Badge variant="outline" className="gap-1 rounded-md border-red-300 bg-red-50 font-semibold text-red-700">
        <XCircle className="size-3 text-red-600" />
        Failed
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="gap-1 rounded-md border-emerald-300 bg-emerald-50 font-medium text-emerald-800">
      <CheckCircle2 className="size-3 text-emerald-600" />
      <span className="capitalize">{state}</span>
      {elapsed !== undefined && <span className="font-mono text-[10px] text-emerald-600">({elapsed})</span>}
    </Badge>
  );
}

function ApplyResourceRow({
  resource,
  execution,
}: Readonly<{
  resource: ResourceChange;
  execution: ResourceExecutionInfo;
}>): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const operation = operationForResource(resource);
  const config = operationConfig[operation];
  const operationIcon = config.icon;

  const handleCopy = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (value: string) => Promise<void> } | undefined;
    if (clipboard !== undefined) {
      void clipboard.writeText(resource.address);
      setCopied(true);
      setTimeout((): void => { setCopied(false); }, 1500);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 text-xs last:border-b-0 hover:bg-gray-50/80">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Badge variant="outline" className={`gap-1 rounded-md capitalize ${config.className}`}>
          {createElement(operationIcon, { className: "size-3" })}
          {config.label}
        </Badge>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <code className="truncate font-mono text-xs font-semibold text-gray-900">{resource.address}</code>
            <button
              type="button"
              aria-label={`Copy ${resource.address} address`}
              title={copied ? "Copied address!" : "Copy resource address"}
              className="rounded border border-gray-200 bg-white p-1 text-gray-500 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500"
              onClick={handleCopy}
            >
              {copied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
            </button>
          </div>

          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-500">
            <span>Type: <code className="font-mono">{resource.type}</code></span>
            {resource.previous_address !== undefined && (
              <span className="flex items-center gap-1">
                Moved from <code className="font-mono">{resource.previous_address}</code>
                <ArrowRight className="inline size-3 text-gray-400" />
                <code className="font-mono font-medium text-gray-700">{resource.address}</code>
              </span>
            )}
            {execution.resourceId !== undefined && (
              <span>ID: <code className="font-mono text-gray-700">{execution.resourceId}</code></span>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0">
        <ExecutionBadge execution={execution} />
      </div>
    </div>
  );
}

export function ApplyOutput({
  runId,
  status,
  applyStatus,
  applyLogs,
}: Readonly<{
  runId: string;
  status: string;
  applyStatus: string;
  applyLogs: string;
}>): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState<Operation | "all">("all");

  useEffect((): (() => void) => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const data = await fetchApi(`/plans/plan-${runId}/json-output`);
        if (cancelled) return;
        setLoadState({ kind: "ready", plan: data as PlanJson });
      } catch (reason: unknown) {
        if (cancelled) return;
        setLoadState({
          kind: "error",
          message: reason instanceof ApiError && reason.status === 404
            ? "Plan data is unavailable for apply output."
            : "Failed to load apply output.",
        });
      }
    };

    void load();
    return (): void => { cancelled = true; };
  }, [runId]);

  if (loadState.kind === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 border-t border-gray-200 px-5 py-4 text-sm text-gray-500">
        <Spinner className="size-4" />
        Loading structured apply output…
      </div>
    );
  }

  if (loadState.kind === "error" || loadState.kind !== "ready") {
    return (
      <div role="status" className="border-t border-gray-200 bg-gray-50 px-5 py-4 text-xs text-gray-500">
        Apply view is unavailable. See raw apply logs below.
      </div>
    );
  }

  const planJson = loadState.plan;
  const changedResources = (planJson.resource_changes ?? [])
    .filter((resource): boolean => operationForResource(resource) !== "no-op");

  const applyFinished = applyStatus === "applied" || status === "applied";
  const applyFailed = ["errored", "failed", "unreachable"].includes(applyStatus);
  const execMap = parseApplyLogsToExecMap(applyLogs, changedResources, applyFinished, applyFailed);

  const importCount = changedResources.filter((r): boolean => r.change.importing !== undefined).length;
  const moveCount = changedResources.filter((r): boolean => r.previous_address !== undefined).length;

  const opCounts = {
    create: changedResources.filter((resource): boolean => operationForResource(resource) === "create").length,
    update: changedResources.filter((resource): boolean => operationForResource(resource) === "update").length,
    delete: changedResources.filter((resource): boolean => operationForResource(resource) === "delete").length,
    replace: changedResources.filter((resource): boolean => operationForResource(resource) === "replace").length,
    read: changedResources.filter((resource): boolean => operationForResource(resource) === "read").length,
    import: importCount,
    move: moveCount,
    remove: changedResources.filter((resource): boolean => operationForResource(resource) === "remove").length,
  };

  const query = search.trim().toLocaleLowerCase();
  const filteredResources = changedResources.filter((resource): boolean => {
    if (operation !== "all"
      && (operation === "import"
        ? resource.change.importing === undefined
        : operation === "move"
          ? resource.previous_address === undefined
          : operationForResource(resource) !== operation)) return false;
    if (query === "") return true;
    return [
      resource.address,
      resource.previous_address,
      resource.type,
      resource.name,
      resource.module_address,
      resource.provider_name,
    ].some((val): boolean => val?.toLocaleLowerCase().includes(query) === true);
  });

  return (
    <section aria-label="Apply output" className="border-t border-gray-200">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-5 py-2.5">
        <div className="flex items-center gap-2">
          <FileCode className="size-4 text-gray-400" />
          <span className="text-xs font-medium text-gray-700"></span>
          {applyStatus === "applying" && (
            <Badge variant="outline" className="gap-1 rounded border-blue-300 bg-blue-50 text-[10px] text-blue-700 animate-pulse">
              <Spinner className="size-3 text-blue-600" />
              Apply in progress
            </Badge>
          )}
        </div>
        <span className="text-xs text-gray-500">
          {changedResources.length} resource{changedResources.length === 1 ? "" : "s"} total
        </span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 px-4 py-3">
        <div className="flex flex-1 flex-wrap gap-2">
          <label className="min-w-[220px] flex-1 text-xs font-medium text-gray-600">
            <span className="sr-only">Filter resources by address or type</span>
            <input
              type="search"
              value={search}
              placeholder="Filter resources by address…"
              aria-label="Filter resources by address or type"
              className="h-8 w-full rounded-md border border-gray-300 bg-white px-2.5 text-sm font-normal text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              onInput={(event): void => { setSearch(event.currentTarget.value); }}
            />
          </label>
          <label className="text-xs font-medium text-gray-600">
            <span className="sr-only">Filter by operation</span>
            <select
              value={operation}
              aria-label="Filter by operation"
              className="h-8 rounded-md border border-gray-300 bg-white px-2.5 text-sm font-normal text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              onChange={(event): void => { setOperation(event.currentTarget.value as Operation | "all"); }}
            >
              <option value="all">All operations ({changedResources.length})</option>
              <option value="create">Create ({opCounts.create})</option>
              <option value="update">Change ({opCounts.update})</option>
              <option value="delete">Destroy ({opCounts.delete})</option>
              <option value="replace">Replace ({opCounts.replace})</option>
              <option value="move">Move ({opCounts.move})</option>
              <option value="import">Import ({opCounts.import})</option>
              <option value="remove">Remove from state ({opCounts.remove})</option>
              <option value="read">Read ({opCounts.read})</option>
            </select>
          </label>
        </div>
        <span aria-live="polite" className="text-xs text-gray-500">
          Showing {filteredResources.length} of {changedResources.length}
        </span>
      </div>

      {filteredResources.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-gray-500">
          {changedResources.length === 0 ? "No resources to apply." : "No resources match these filters."}
        </p>
      ) : (
        <div aria-label={`Apply resource list, ${filteredResources.length} items`} className="divide-y divide-gray-100">
          {filteredResources.map((resource): React.JSX.Element => {
            const exec = execMap.get(resource.address) ?? { state: "pending" };
            return (
              <ApplyResourceRow
                key={`${resource.address}:${resource.deposed ?? ""}`}
                resource={resource}
                execution={exec}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
