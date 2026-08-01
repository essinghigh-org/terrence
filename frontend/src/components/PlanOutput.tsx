/* eslint-disable @typescript-eslint/naming-convention -- Terraform plan JSON fields are snake_case. */
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Trash2,
} from "lucide-react";
import { DependencyGraph } from "./DependencyGraph";
import { ApiError, fetchApi } from "../lib/api";
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

type ActionInvocation = {
  address?: string;
  type?: string;
  name?: string;
  provider_name?: string;
  lifecycle_action_trigger?: {
    triggering_resource_address?: string;
    action_trigger_event?: string;
  };
  invoke_action_trigger?: Record<string, unknown>;
};

type PlanJson = {
  action_invocations?: ActionInvocation[];
  configuration?: unknown;
  resource_drift?: ResourceChange[];
  resource_changes?: ResourceChange[];
  output_changes?: Record<string, Change>;
  terraform_version?: string;
  format_version?: string;
};

type Operation = "create" | "update" | "delete" | "replace" | "read" | "import" | "move" | "remove" | "no-op";

type DiffRow = Readonly<{
  path: string;
  before: unknown;
  after: unknown;
  sensitive: boolean;
  unknown: boolean;
  unchanged: boolean;
}>;

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; plan: PlanJson }>;

export type PlanOutputSummary = Readonly<{ actionCount: number; importCount: number }>;

const POLL_INTERVAL_MS = 1_000;
const PLAN_PENDING_STATUSES = new Set([
  "pending",
  "fetching",
  "fetching_completed",
  "pre_plan_running",
  "pre_plan_completed",
  "queuing",
  "plan_queued",
  "planning",
]);
const PLANLESS_TERMINAL_STATUSES = new Set([
  "canceled",
  "discarded",
  "errored",
  "failed",
  "force_canceled",
  "unreachable",
]);

const operationConfig = {
  create: { symbol: "+", className: "text-emerald-700" },
  update: { symbol: "~", className: "text-blue-700" },
  delete: { icon: Trash2, className: "text-red-600" },
  replace: { symbol: "±", className: "text-amber-700" },
  read: { symbol: "◎", className: "text-purple-700" },
  import: { symbol: "&", className: "text-gray-950" },
  move: { symbol: "→", className: "text-slate-700" },
  remove: { icon: Trash2, className: "text-gray-400" },
  "no-op": { symbol: "·", className: "text-gray-400" },
} satisfies Record<Operation, Readonly<{ symbol?: string; icon?: typeof Trash2; className: string }>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChange(value: unknown): value is Change {
  if (!isRecord(value)
    || !Array.isArray(value["actions"])
    || !value["actions"].every((action: unknown): boolean => typeof action === "string")) return false;
  const importing = value["importing"];
  const replacePaths = value["replace_paths"];
  return (importing === undefined || (
      isRecord(importing)
      && (importing["id"] === undefined || typeof importing["id"] === "string")
      && (importing["unknown"] === undefined || typeof importing["unknown"] === "boolean")
    ))
    && (replacePaths === undefined || (
      Array.isArray(replacePaths)
      && replacePaths.every((path: unknown): boolean =>
        Array.isArray(path)
        && path.every((step: unknown): boolean => typeof step === "string" || typeof step === "number"),
      )
    ));
}

function isResourceChange(value: unknown): value is ResourceChange {
  return isRecord(value)
    && typeof value["address"] === "string"
    && typeof value["type"] === "string"
    && (value["deposed"] === undefined || typeof value["deposed"] === "string")
    && (value["module_address"] === undefined || typeof value["module_address"] === "string")
    && (value["mode"] === undefined || typeof value["mode"] === "string")
    && (value["name"] === undefined || typeof value["name"] === "string")
    && (value["previous_address"] === undefined || typeof value["previous_address"] === "string")
    && (value["provider_name"] === undefined || typeof value["provider_name"] === "string")
    && (value["action_reason"] === undefined || typeof value["action_reason"] === "string")
    && isChange(value["change"]);
}

function isActionInvocation(value: unknown): value is ActionInvocation {
  if (!isRecord(value)
    || (value["address"] !== undefined && typeof value["address"] !== "string")
    || (value["type"] !== undefined && typeof value["type"] !== "string")
    || (value["name"] !== undefined && typeof value["name"] !== "string")
    || (value["provider_name"] !== undefined && typeof value["provider_name"] !== "string")) return false;
  const lifecycleTrigger = value["lifecycle_action_trigger"];
  return (lifecycleTrigger === undefined || (
      isRecord(lifecycleTrigger)
      && (lifecycleTrigger["triggering_resource_address"] === undefined
        || typeof lifecycleTrigger["triggering_resource_address"] === "string")
      && (lifecycleTrigger["action_trigger_event"] === undefined
        || typeof lifecycleTrigger["action_trigger_event"] === "string")
    ))
    && (value["invoke_action_trigger"] === undefined || isRecord(value["invoke_action_trigger"]));
}

function parsePlanJson(value: unknown): PlanJson | null {
  if (!isRecord(value)) return null;
  const actions = value["action_invocations"];
  const resources = value["resource_changes"];
  const drift = value["resource_drift"];
  const outputs = value["output_changes"];
  if (actions !== undefined
    && (!Array.isArray(actions) || !actions.every(isActionInvocation))) return null;
  if (resources !== undefined
    && (!Array.isArray(resources) || !resources.every(isResourceChange))) return null;
  if (drift !== undefined
    && (!Array.isArray(drift) || !drift.every(isResourceChange))) return null;
  if (outputs !== undefined
    && (!isRecord(outputs) || !Object.values(outputs).every(isChange))) return null;
  if (value["terraform_version"] !== undefined && typeof value["terraform_version"] !== "string") return null;
  if (value["format_version"] !== undefined && typeof value["format_version"] !== "string") return null;
  return value;
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

function collectionKeys(values: readonly unknown[]): readonly (string | number)[] {
  const arrays = values.filter(Array.isArray);
  if (arrays.length > 0) {
    const length = Math.max(...arrays.map((value): number => value.length), 0);
    return Array.from({ length }, (_, index): number => index);
  }
  const keys = new Set<string>();
  for (const value of values) {
    if (isRecord(value)) {
      for (const key of Object.keys(value)) keys.add(key);
    }
  }
  return [...keys].sort((left, right): number => left.localeCompare(right));
}

function childValue(value: unknown, key: string | number): unknown {
  if (typeof key === "number") return Array.isArray(value) ? value[key] : undefined;
  return isRecord(value) ? value[key] : undefined;
}

function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((value, step): string =>
    typeof step === "number"
      ? `${value}[${step}]`
      : value === "" ? step : `${value}.${step}`,
  "");
}

function collectDiffRows(
  path: string,
  before: unknown,
  after: unknown,
  beforeSensitive: unknown,
  afterSensitive: unknown,
  afterUnknown: unknown,
): readonly DiffRow[] {
  const sensitive = beforeSensitive === true || afterSensitive === true;
  const unknown = afterUnknown === true;
  const equal = JSON.stringify(before) === JSON.stringify(after);
  if (sensitive || unknown) {
    return [{
      path: path === "" ? "value" : path,
      before,
      after,
      sensitive,
      unknown,
      unchanged: equal && !unknown,
    }];
  }

  const values = [before, after, beforeSensitive, afterSensitive, afterUnknown];
  const keys = collectionKeys(values);
  if (keys.length > 0) {
    return keys.flatMap((key): readonly DiffRow[] => {
      const childPath = typeof key === "number"
        ? `${path}[${key}]`
        : path === "" ? key : `${path}.${key}`;
      return collectDiffRows(
        childPath,
        childValue(before, key),
        childValue(after, key),
        childValue(beforeSensitive, key),
        childValue(afterSensitive, key),
        childValue(afterUnknown, key),
      );
    });
  }
  return [{
    path: path === "" ? "value" : path,
    before,
    after,
    sensitive: false,
    unknown: false,
    unchanged: equal,
  }];
}

function attributeDiff(change: Change): readonly DiffRow[] {
  return collectDiffRows(
    "",
    change.before,
    change.after,
    change.before_sensitive,
    change.after_sensitive,
    change.after_unknown,
  );
}

function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? "[…]" : "{…}";
}

function Value({
  value,
  sensitive = false,
  unknown = false,
}: Readonly<{ value: unknown; sensitive?: boolean; unknown?: boolean }>): React.JSX.Element {
  if (sensitive) {
    return <span className="font-medium italic text-gray-500">Sensitive value</span>;
  }
  if (unknown) {
    return <span className="font-medium italic text-purple-700">Known after apply</span>;
  }
  return <code className="break-all font-mono text-[12px] text-gray-700">{formatValue(value)}</code>;
}

function AttributeDiff({ change, address }: Readonly<{ change: Change; address: string }>): React.JSX.Element {
  const rows = attributeDiff(change);
  const contextualUnchanged = new Set(
    rows
      .filter((row): boolean => row.unchanged && !row.sensitive && ["id", "name"].includes(row.path))
      .map((row): string => row.path),
  );
  const visibleRows = rows.filter((row): boolean => !row.unchanged || contextualUnchanged.has(row.path));
  const hiddenUnchanged = rows.filter((row): boolean => row.unchanged).length - contextualUnchanged.size;
  const replacementPaths = (change.replace_paths ?? []).map(formatPath);
  const forcesReplacement = (path: string): boolean => replacementPaths.some((replacementPath): boolean =>
    path === replacementPath
    || path.startsWith(`${replacementPath}.`)
    || path.startsWith(`${replacementPath}[`),
  );
  const unchangedSummary = hiddenUnchanged > 0
    ? `${hiddenUnchanged} unchanged attribute${hiddenUnchanged === 1 ? "" : "s"} hidden`
    : "";
  if (visibleRows.length === 0) {
    return (
      <p className="px-4 py-3 text-xs text-gray-500">
        No attribute-level changes to show.{unchangedSummary === "" ? "" : ` ${unchangedSummary}.`}
      </p>
    );
  }

  return (
    <div aria-label={`Attribute changes for ${address}`} className="overflow-x-auto border-t border-gray-200 bg-gray-50 px-4 pb-3">
      <div className="min-w-[560px]">
        <div className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,1.2fr)_20px_minmax(120px,1.2fr)] gap-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          <span>Attribute</span>
          <span>Before</span>
          <span aria-hidden="true" />
          <span>After</span>
        </div>
        {visibleRows.map((row): React.JSX.Element => {
          const attrSymbol = row.unchanged ? null : row.before === undefined ? { char: "+", cls: "text-emerald-700" } : row.after === undefined ? { char: "−", cls: "text-red-700" } : { char: "~", cls: "text-blue-700" };
          return (
          <div key={row.path} className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,1.2fr)_20px_minmax(120px,1.2fr)] items-start gap-3 border-t border-gray-100 py-2 text-xs">
            <div className="min-w-0 flex items-center gap-1.5">
              {attrSymbol !== null && <span aria-hidden="true" className={`shrink-0 text-xs font-semibold ${attrSymbol.cls}`}>{attrSymbol.char}</span>}
              <code className="break-all font-mono font-medium text-gray-700">{row.path}</code>
              {forcesReplacement(row.path) && (
                <span className="ml-1 block text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                  Forces replacement
                </span>
              )}
            </div>
            {row.unchanged ? (
              <div className="col-span-3 text-gray-500">
                <Value value={row.after} sensitive={row.sensitive} />
              </div>
            ) : (
              <>
                <Value value={row.before} sensitive={row.sensitive} />
                <span aria-hidden="true" className="text-center text-gray-300">→</span>
                <Value value={row.after} sensitive={row.sensitive} unknown={row.unknown} />
              </>
            )}
          </div>
          );
        })}
        {unchangedSummary !== "" && (
          <p className="border-t border-gray-100 py-2 text-xs text-blue-600">… {unchangedSummary}</p>
        )}
      </div>
    </div>
  );
}

function providerLabel(providerName: string | undefined): string {
  if (providerName === undefined || providerName === "") return "provider unknown";
  const label = providerName.split("/").pop();
  return label === undefined || label === "" ? "provider unknown" : label;
}

const actionReasonLabels: Readonly<Record<string, string>> = {
  replace_because_cannot_update: "Replacement required by provider",
  replace_because_tainted: "Resource is tainted",
  replace_by_request: "Replacement requested",
  replace_by_triggers: "Replacement triggered by dependency",
  delete_because_no_resource_config: "No matching resource configuration",
  delete_because_no_module: "Containing module was removed",
  delete_because_wrong_repetition: "Resource key no longer matches its configuration",
  delete_because_count_index: "Resource index is outside the configured count",
  delete_because_each_key: "Resource key is absent from for_each",
  read_because_config_unknown: "Configuration is known after apply",
  read_because_dependency_pending: "Dependency has pending changes",
};

function actionReasonLabel(reason: string): string {
  return actionReasonLabels[reason] ?? reason.replace(/_/g, " ");
}

function ResourceRow({ resource }: Readonly<{ resource: ResourceChange }>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const operation = operationForResource(resource);
  const config = operationConfig[operation];

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
    <details
      className="group border-b border-gray-200 last:border-b-0"
      onToggle={(event): void => { setExpanded(event.currentTarget.open); }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-gray-400 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold leading-5 ${config.className}`}>
          {"icon" in config ? (
            <config.icon className="size-3" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">{config.symbol}</span>
          )}
        </span>
        {resource.change.importing !== undefined && operationForResource(resource) !== "import" && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold leading-5 capitalize text-gray-950">
            <span aria-hidden="true">&</span>
            <span>import</span>
          </span>
        )}
        {resource.previous_address !== undefined && operationForResource(resource) !== "move" && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold leading-5 capitalize text-slate-700">
            <span aria-hidden="true">→</span>
            <span>move</span>
          </span>
        )}
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
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-gray-500">
            <span>Type: <code className="font-mono">{resource.type}</code></span>
            {resource.module_address !== undefined && (
              <span>Module: <code className="font-mono">{resource.module_address}</code></span>
            )}
            <span title={resource.provider_name}>
              Provider: <code className="font-mono">{providerLabel(resource.provider_name)}</code>
            </span>
            {resource.mode === "data" && <span>Data source</span>}
            {resource.deposed !== undefined && (
              <span>Deposed key: <code className="font-mono">{resource.deposed}</code></span>
            )}
            {resource.previous_address !== undefined && (
              <span className="flex items-center gap-1">
                Moved from <code className="font-mono">{resource.previous_address}</code>
                <ArrowRight className="inline size-3 text-gray-400" />
                <code className="font-mono font-medium text-gray-700">{resource.address}</code>
              </span>
            )}
            {resource.change.importing !== undefined && (
              <span>
                Import ID: <code className="font-mono">
                  {resource.change.importing.unknown === true
                    ? "known after apply"
                    : resource.change.importing.id ?? "unknown"}
                </code>
              </span>
            )}
            {resource.action_reason !== undefined && (
              <span>Reason: {actionReasonLabel(resource.action_reason)}</span>
            )}
          </div>
        </div>
      </summary>
      {expanded && <AttributeDiff change={resource.change} address={resource.address} />}
    </details>
  );
}

function ActionInvocations({ actions }: Readonly<{ actions: readonly ActionInvocation[] }>): React.JSX.Element {
  if (actions.length === 0) return <></>;
  return (
    <details className="border-t border-gray-200">
      <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
        Actions to invoke <span className="font-normal text-gray-500">({actions.length})</span>
      </summary>
      <div className="divide-y divide-gray-100 border-t border-gray-100">
        {actions.map((action, index): React.JSX.Element => {
          const configuredLabel = action.address
            ?? [action.type, action.name].filter((value): value is string => value !== undefined && value !== "").join(".");
          const label = configuredLabel === "" ? `Action ${index + 1}` : configuredLabel;
          const trigger = action.lifecycle_action_trigger;
          return (
            <div key={`${label}:${index}`} className="flex items-start gap-3 px-5 py-3 text-xs">
              <span className="inline-flex items-center gap-1 rounded-md border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-xs font-semibold leading-5 text-purple-700">invoke</span>
              <div className="min-w-0">
                <code className="break-all font-mono font-semibold text-gray-900">{label}</code>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-gray-500">
                  {action.provider_name !== undefined && (
                    <span>Provider: <code className="font-mono">{providerLabel(action.provider_name)}</code></span>
                  )}
                  {trigger?.action_trigger_event !== undefined && (
                    <span>{trigger.action_trigger_event.replace(/_/g, " ")}</span>
                  )}
                  {trigger?.triggering_resource_address !== undefined && (
                    <span>Triggered by <code className="font-mono">{trigger.triggering_resource_address}</code></span>
                  )}
                  {action.invoke_action_trigger !== undefined && <span>Explicit invocation</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function summaryCounts(resources: readonly ResourceChange[]): Readonly<{
  add: number;
  change: number;
  destroy: number;
  replace: number;
}> {
  let add = 0;
  let change = 0;
  let destroy = 0;
  let replace = 0;
  for (const resource of resources) {
    const operation = operationForResource(resource);
    if (operation === "create") add++;
    if (operation === "update") change++;
    if (operation === "delete") destroy++;
    if (operation === "replace") {
      add++;
      destroy++;
      replace++;
    }
  }
  return { add, change, destroy, replace };
}

function resourceMatches(
  resource: ResourceChange,
  operation: Operation | "all",
  query: string,
): boolean {
  if (operation !== "all"
    && (operation === "import"
      ? resource.change.importing === undefined
      : operation === "move"
        ? resource.previous_address === undefined
        : operationForResource(resource) !== operation)) return false;
  if (query === "") return true;
  return [
    resource.address,
    resource.deposed,
    resource.previous_address,
    resource.type,
    resource.name,
    resource.module_address,
    resource.provider_name,
  ].some((value): boolean => value?.toLocaleLowerCase().includes(query) === true);
}

function OutputChanges({ outputs }: Readonly<{ outputs: readonly [string, Change][] }>): React.JSX.Element {
  if (outputs.length === 0) return <></>;
  return (
    <details className="border-t border-gray-200">
      <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
        Output changes <span className="font-normal text-gray-500">({outputs.length})</span>
      </summary>
      <div className="border-t border-gray-100">
        {outputs.map(([name, output]): React.JSX.Element => (
          <details key={name} className="border-b border-gray-100 last:border-b-0">
            <summary className="flex cursor-pointer items-center gap-2 px-5 py-2 text-xs hover:bg-gray-50">
              <span className="inline-flex items-center rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-5">{name}</span>
              <span className="text-gray-500">{(() => { const op = operationFor(output.actions); return op === "delete" ? "−" : op === "no-op" ? "·" : op === "create" ? "+" : op === "update" ? "~" : op === "read" ? "◎" : op === "replace" ? "±" : op === "import" ? "&" : op === "move" ? "→" : ""; })()}</span>
            </summary>
            <AttributeDiff change={output} address={`output.${name}`} />
          </details>
        ))}
      </div>
    </details>
  );
}

export function PlanOutput({
  runId,
  status,
  planStatus,
  onSummaryChange,
}: Readonly<{
  runId: string;
  status: string;
  planStatus?: string;
  onSummaryChange?: (summary: PlanOutputSummary | null) => void;
}>): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState<Operation | "all">("all");
  const activeRunId = useRef(runId);
  const readyRunId = useRef<string | null>(null);

  useEffect((): (() => void) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shouldPoll = PLAN_PENDING_STATUSES.has(status);

    const runChanged = activeRunId.current !== runId;
    if (runChanged) {
      activeRunId.current = runId;
      readyRunId.current = null;
      setLoadState({ kind: "loading" });
      setSearch("");
      setOperation("all");
    }

    const load = async (): Promise<void> => {
      try {
        const data = await fetchApi(`/plans/plan-${runId}/json-output`);
        if (cancelled) return;
        const plan = parsePlanJson(data);
        if (plan === null) throw new Error("The structured plan response was invalid.");
        readyRunId.current = runId;
        setLoadState({ kind: "ready", plan });
      } catch (reason: unknown) {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 404 && shouldPoll) {
          setLoadState({ kind: "waiting" });
          timer = setTimeout((): void => {
            void load();
          }, POLL_INTERVAL_MS);
          return;
        }
        if (reason instanceof ApiError
          && reason.status === 404
          && PLANLESS_TERMINAL_STATUSES.has(status)
          && planStatus !== "finished") {
          setLoadState({ kind: "unavailable" });
          return;
        }
        setLoadState({
          kind: "error",
          message: reason instanceof ApiError && reason.status === 404
            ? "Plan output is not available for this run."
            : reason instanceof Error
              ? reason.message
              : "Failed to load structured plan output.",
        });
      }
    };

    if (readyRunId.current !== runId) void load();
    return (): void => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [planStatus, retry, runId, status]);

  useEffect((): void => {
    const ready = activeRunId.current === runId
      && readyRunId.current === runId
      && loadState.kind === "ready";
    onSummaryChange?.(ready
      ? {
          actionCount: loadState.plan.action_invocations?.length ?? 0,
          importCount: (loadState.plan.resource_changes ?? [])
            .filter((resource): boolean => resource.change.importing !== undefined).length,
        }
      : null);
  }, [loadState, onSummaryChange, runId]);

  if (activeRunId.current !== runId || loadState.kind === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 border-t border-gray-200 px-5 py-4 text-sm text-gray-500">
        <Spinner className="size-4" />
        Loading structured plan output…
      </div>
    );
  }

  if (loadState.kind === "waiting") {
    return (
      <div role="status" className="flex items-start gap-3 border-t border-gray-200 bg-blue-50/50 px-5 py-4 text-sm text-gray-600">
        <Spinner className="mt-0.5 size-4 text-blue-600" />
        <div>
          <p className="font-medium text-gray-800">Preparing structured plan output…</p>
          <p className="mt-0.5 text-xs">This view will update automatically when the plan is ready.</p>
        </div>
      </div>
    );
  }

  if (loadState.kind === "unavailable") {
    return (
      <div role="status" className="border-t border-gray-200 bg-gray-50 px-5 py-4">
        <p className="text-sm font-medium text-gray-700">Plan output was not produced for this run.</p>
      </div>
    );
  }

  if (loadState.kind === "error") {
    return (
      <div role="alert" className="border-t border-gray-200 bg-red-50/60 px-5 py-4">
        <p className="text-sm font-medium text-red-800">Could not load plan output</p>
        <p className="mt-1 text-xs text-red-700">{loadState.message}</p>
        <button
          type="button"
          className="mt-3 rounded border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          onClick={(): void => {
            setLoadState({ kind: "loading" });
            setRetry((value): number => value + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const planJson = loadState.plan;
  const changedResources = (planJson.resource_changes ?? [])
    .filter((resource): boolean => operationForResource(resource) !== "no-op");
  const driftResources = (planJson.resource_drift ?? [])
    .filter((resource): boolean => operationForResource(resource) !== "no-op");
  const counts = summaryCounts(changedResources);
  const query = search.trim().toLocaleLowerCase();
  const filteredResources = changedResources
    .filter((resource): boolean => resourceMatches(resource, operation, query));
  const filteredDrift = driftResources
    .filter((resource): boolean => resourceMatches(resource, operation, query));
  const importCount = changedResources
    .filter((resource): boolean => resource.change.importing !== undefined).length;
  const moveCount = changedResources
    .filter((resource): boolean => resource.previous_address !== undefined).length;
  const outputs = Object.entries(planJson.output_changes ?? {});
  const actionInvocations = planJson.action_invocations ?? [];
  const operationSummary = [
    {
      count: importCount,
      label: "to import",
      symbol: "&",
      className: "text-gray-950",
    },
    {
      count: counts.add,
      label: "to create",
      symbol: "+",
      className: "text-emerald-700",
    },
    {
      count: counts.change,
      label: "to change",
      symbol: "~",
      className: "text-blue-700",
    },
    {
      count: counts.destroy,
      label: "to destroy",
      symbol: "−",
      className: "text-red-700",
    },
  ].filter((item): boolean => item.count > 0);

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

  return (
    <section aria-label="Plan output" className="border-t border-gray-200">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-5 py-2.5">
        <div className="flex items-center gap-2">
        </div>
        <span className="text-xs text-gray-500">
          Terraform {planJson.terraform_version ?? "unknown"}
          {planJson.format_version !== undefined && ` · JSON ${planJson.format_version}`}
        </span>
      </div>

      <div aria-label="Resource change summary" className="flex flex-wrap gap-2 border-b border-gray-200 p-4">
        {operationSummary.length === 0 ? (
          <div aria-label="No resource changes" className="w-full rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-600">
            No resource changes
          </div>
        ) : operationSummary.map((item): React.JSX.Element => (
          <span
            key={item.label}
            aria-label={`${item.count} ${item.label}`}
            className={`inline-flex items-center gap-1 text-xs font-semibold leading-5 ${item.className}`}
          >
            <span aria-hidden="true">{item.symbol}</span>
            {item.count} <span className="font-normal">{item.label}</span>
          </span>
        ))}
      </div>
      {(counts.replace > 0 || moveCount > 0 || driftResources.length > 0 || actionInvocations.length > 0) && (
        <div className="flex flex-wrap gap-2 border-b border-gray-200 px-4 py-2 text-xs text-gray-600">
          {counts.replace > 0 && <span>{counts.replace} replacement{counts.replace === 1 ? "" : "s"}</span>}
          {moveCount > 0 && <span>{moveCount} move{moveCount === 1 ? "" : "s"}</span>}
          {driftResources.length > 0 && <span>{driftResources.length} drifted resource{driftResources.length === 1 ? "" : "s"}</span>}
          {actionInvocations.length > 0 && (
            <span>{actionInvocations.length} action{actionInvocations.length === 1 ? "" : "s"} to invoke</span>
          )}
        </div>
      )}

      <DependencyGraph
        configuration={planJson.configuration}
        changes={changedResources.map((resource): { address: string; operation: string } => ({
          address: resource.address,
          operation: operationForResource(resource),
        }))}
      />

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
          <select
            value={operation}
            aria-label="Filter by operation"
            className="h-8 rounded-md border border-gray-300 bg-white px-2.5 text-sm font-normal text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            onChange={(event): void => {
              const val = ((event.currentTarget || event.target)).value as Operation | "all";
              setOperation(val);
            }}
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
          </div>
        <span aria-live="polite" className="text-xs text-gray-500">
          Showing {filteredResources.length} of {changedResources.length}
          {driftResources.length > 0 && ` · ${filteredDrift.length} of ${driftResources.length} drift`}
        </span>
      </div>

      {filteredResources.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-gray-500">
          {changedResources.length === 0
            ? actionInvocations.length === 0
              ? "This plan has no resource changes."
              : `This plan has no resource changes, but it will invoke ${actionInvocations.length} action${actionInvocations.length === 1 ? "" : "s"}.`
            : "No resources match these filters."}
        </p>
      ) : (
        <div aria-label={`Resource list, ${filteredResources.length} items`}>
          {filteredResources.map((resource): React.JSX.Element => (
            <ResourceRow key={`${resource.address}:${resource.deposed ?? ""}`} resource={resource} />
          ))}
        </div>
      )}

      {driftResources.length > 0 && (
        <details className="border-t border-gray-200">
          <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Resource drift <span className="font-normal text-gray-500">({filteredDrift.length})</span>
          </summary>
          {filteredDrift.length === 0 ? (
            <p className="border-t border-gray-100 px-5 py-4 text-sm text-gray-500">
              No drifted resources match these filters.
            </p>
          ) : (
            <div className="border-t border-gray-100">
              {filteredDrift.map((resource): React.JSX.Element => (
                <ResourceRow key={`${resource.address}:${resource.deposed ?? ""}`} resource={resource} />
              ))}
            </div>
          )}
        </details>
      )}

      <ActionInvocations actions={actionInvocations} />
      <OutputChanges outputs={outputs} />
    </section>
  );
}
