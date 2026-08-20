/* eslint-disable @typescript-eslint/naming-convention -- Terraform plan/apply JSON fields are snake_case. */
import { useEffect, useState } from "react";
import {
    Trash2,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  FileCode,
  XCircle,
} from "lucide-react";
import { ApiError, fetchApi } from "../lib/api";
import { Spinner } from "./ui/spinner";
import { Badge } from "./ui/badge";
import { ProviderIcon } from "./ProviderIcon";
import { AttributeDiff } from "./PlanOutput";
import { OperationFilterDropdown, type Operation } from "./OperationFilterDropdown";
import { isNumber, isRecord, isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

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

// Reads are data-source refreshes, not real changes: they never execute
// during an apply, so they are excluded from the apply resource list and
// from the operation filter entirely.
const APPLY_OPERATION_OPTIONS: readonly Operation[] = ["create", "update", "delete", "replace", "move", "import", "remove"];
const DEFAULT_APPLY_OPS: ReadonlySet<Operation> = new Set(APPLY_OPERATION_OPTIONS);

type ExecutionState =
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
  create: { symbol: "+", className: "text-success" },
  update: { symbol: "~", className: "text-primary" },
  delete: { icon: Trash2, className: "text-destructive" },
  replace: { symbol: "±", className: "text-warning" },
  read: { symbol: "◎", className: "text-primary" },
  import: { symbol: "&", className: "text-foreground" },
  move: { symbol: "→", className: "text-foreground/85" },
  remove: { icon: Trash2, className: "text-muted-foreground/70" },
  "no-op": { symbol: "·", className: "text-muted-foreground/70" },
} satisfies Record<Operation, Readonly<{ symbol?: string; icon?: typeof Trash2; className: string }>>;

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
    if (op === "no-op" || op === "read") continue;

    if (applyFinished && !applyFailed) {
      const finalState: ExecutionState =
        op === "create" ? "created" :
        op === "update" ? "modified" :
        op === "delete" ? "destroyed" :
        op === "replace" ? "replaced" :
        op === "import" ? "imported" :
        op === "move" ? "moved" : "removed";
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
// SAFETY: the fixture object is read as a record; each field is typed below.
        const json = JSON.parse(trimmed) as JsonObject;
        const type = json["type"];
        const hook = isRecord(json["hook"]) ? json["hook"] : undefined;
        const rawResource = hook?.["resource"];
        const resObj = isRecord(rawResource) ? rawResource : undefined;
        const rawAddr = resObj?.["addr"];
        const addr = isString(rawAddr) ? rawAddr : undefined;

        if (addr !== undefined && map.has(addr)) {
          if (type === "apply_start") {
            const rawAction = hook?.["action"];
            const act = isString(rawAction) ? rawAction : "";
            const st: ExecutionState =
              act === "create" ? "creating" :
              act === "update" ? "modifying" :
              act === "delete" ? "destroying" : "creating";
            map.set(addr, { state: st });
          } else if (type === "apply_progress") {
            const current = map.get(addr);
            const rawElapsed = hook?.["elapsed_seconds"];
            const elapsed = isNumber(rawElapsed) ? `${rawElapsed}s` : undefined;
            if (current !== undefined) {
              map.set(addr, { ...current, elapsed });
            }
          } else if (type === "apply_complete") {
            const rawAction = hook?.["action"];
            const act = isString(rawAction) ? rawAction : "";
            const rawIdValue = hook?.["id_value"];
            const idVal = isString(rawIdValue) ? rawIdValue : undefined;
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
        const match = /Creation complete after ([^[\s]+)/.exec(line);
        const elapsed = match?.[1];
        const idMatch = /\[id=([^\]]+)\]/.exec(line);
        map.set(address, { state: "created", elapsed, resourceId: idMatch?.[1] });
      } else if (line.includes(": Modifying...")) {
        map.set(address, { state: "modifying" });
      } else if (line.includes(": Modifications complete after")) {
        const match = /Modifications complete after ([^[\s]+)/.exec(line);
        map.set(address, { state: "modified", elapsed: match?.[1] });
      } else if (line.includes(": Destroying...")) {
        map.set(address, { state: "destroying" });
      } else if (line.includes(": Destruction complete after")) {
        const match = /Destruction complete after ([^[\s]+)/.exec(line);
        map.set(address, { state: "destroyed", elapsed: match?.[1] });
      } else if (line.includes(": Still creating...")) {
        const match = /\[(.*?) elapsed\]/.exec(line);
        map.set(address, { state: "creating", elapsed: match?.[1] });
      } else if (line.includes(": Still modifying...")) {
        const match = /\[(.*?) elapsed\]/.exec(line);
        map.set(address, { state: "modifying", elapsed: match?.[1] });
      } else if (line.includes(": Still destroying...")) {
        const match = /\[(.*?) elapsed\]/.exec(line);
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
      <Badge variant="outline" className="gap-1 rounded-md border-input bg-muted font-medium text-muted-foreground">
        <Clock className="size-3 text-muted-foreground/70" />
        Pending
      </Badge>
    );
  }

  if (["creating", "modifying", "destroying", "replacing", "importing", "moving", "removing"].includes(state)) {
    return (
      <Badge variant="outline" className="gap-1.5 rounded-md border-primary/40 bg-primary/10 font-medium text-primary animate-pulse">
        <Spinner className="size-3 text-primary" />
        <span className="capitalize">{state}…</span>
        {elapsed !== undefined && <span className="font-mono text-[10px] text-primary">[{elapsed}]</span>}
      </Badge>
    );
  }

  if (state === "failed") {
    return (
      <Badge variant="outline" className="gap-1 rounded-md border-destructive/50 bg-destructive/10 font-semibold text-destructive">
        <XCircle className="size-3 text-destructive" />
        Failed
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="gap-1 rounded-md border-success/40 bg-success/10 font-medium text-success">
      <CheckCircle2 className="size-3 text-success" />
      <span className="capitalize">{state}</span>
      {elapsed !== undefined && <span className="font-mono text-[10px] text-success">({elapsed})</span>}
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

  const handleCopy = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
    const clipboard = navigator.clipboard;
    if (clipboard !== undefined) {
      void clipboard.writeText(resource.address);
      setCopied(true);
      setTimeout((): void => { setCopied(false); }, 1500);
    }
  };

  return (
    <details
      className="group border-b border-border last:border-b-0"
      aria-label={`Apply details for ${resource.address}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <ChevronRight className="size-4 shrink-0 rotate-0 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
          <span className={`inline-flex shrink-0 items-center justify-center text-sm font-bold leading-none ${config.className}`}>
            {"icon" in config ? (
              <config.icon className="size-3.5" aria-hidden="true" />
            ) : (
              <span aria-hidden="true">{config.symbol}</span>
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <ProviderIcon providerName={resource.provider_name} size={22} />
              <code className="truncate font-mono text-xs font-semibold text-foreground" title={resource.provider_name ?? undefined}>{resource.address}</code>
              <button
                type="button"
                aria-label={`Copy ${resource.address} address`}
                title={copied ? "Copied address!" : "Copy resource address"}
                className="size-6 shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                onClick={handleCopy}
              >
                {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
              </button>
            </div>


          </div>
        </div>

        <div className="shrink-0">
          <ExecutionBadge execution={execution} />
        </div>
      </summary>
      <AttributeDiff change={resource.change} address={resource.address} type={resource.type} name={resource.name} />
    </details>
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
  const [selectedOps, setSelectedOps] = useState<ReadonlySet<Operation>>(new Set(APPLY_OPERATION_OPTIONS));

  useEffect((): (() => void) => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const data = await fetchApi(`/plans/plan-${runId}/json-output`);
        if (cancelled) return;
// SAFETY: the run phase payload is plan JSON per the endpoint contract.
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
      <div role="status" className="flex items-center gap-2 border-t border-border px-5 py-4 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading structured apply output…
      </div>
    );
  }

  if (loadState.kind === "error" || loadState.kind !== "ready") {
    return (
      <div role="status" className="border-t border-border bg-muted px-5 py-4 text-xs text-muted-foreground">
        Apply view is unavailable. See raw apply logs below.
      </div>
    );
  }

  const planJson = loadState.plan;
  const changedResources = (planJson.resource_changes ?? [])
    .filter((resource): boolean => {
      const op = operationForResource(resource);
      return op !== "no-op" && op !== "read";
    });

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
    const primaryOp = operationForResource(resource);
    const matchesOp = selectedOps.has(primaryOp)
      || (resource.previous_address !== undefined && selectedOps.has("move"))
      || (resource.change.importing !== undefined && selectedOps.has("import"));
    if (!matchesOp) return false;
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
    <section aria-label="Apply output" className="border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted px-5 py-2.5">
        <div className="flex items-center gap-2">
          <FileCode className="size-4 text-muted-foreground/70" />
          <span className="text-xs font-medium text-foreground/85">Apply output</span>
          {applyStatus === "applying" && (
            <Badge variant="outline" className="gap-1 rounded border-primary/40 bg-primary/10 text-[10px] text-primary animate-pulse">
              <Spinner className="size-3 text-primary" />
              Apply in progress
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Terraform {planJson.terraform_version ?? "unknown"}
          {planJson.format_version !== undefined && ` · JSON ${planJson.format_version}`}
          <span className="ml-1.5 text-muted-foreground/70">· {changedResources.length} resource{changedResources.length === 1 ? "" : "s"}</span>
        </span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-1 flex-wrap gap-2">
          <label className="min-w-[220px] flex-1 text-xs font-medium text-muted-foreground">
            <span className="sr-only">Filter resources by address or type</span>
            <input
              id="apply-resource-search"
              name="resource-search"
              type="search"
              autoComplete="off"
              spellCheck={false}
              value={search}
              placeholder="Filter resources by address…"
              aria-label="Filter resources by address or type"
              className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
              onInput={(event): void => { setSearch(event.currentTarget.value); }}
            />
          </label>
          <OperationFilterDropdown
            options={APPLY_OPERATION_OPTIONS}
            defaultOps={DEFAULT_APPLY_OPS}
            selectedOps={selectedOps}
            onChange={setSelectedOps}
            opCounts={opCounts}
          />
        </div>
        <span aria-live="polite" className="text-xs text-muted-foreground">
          Showing {filteredResources.length} of {changedResources.length}
        </span>
      </div>

      {filteredResources.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-muted-foreground">
          {changedResources.length === 0 ? "No resources to apply." : "No resources match these filters."}
        </p>
      ) : (
        <div aria-label={`Apply resource list, ${filteredResources.length} items`} className="divide-y divide-border/60">
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