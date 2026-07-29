import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Badge } from "../components/ui/badge";
import { Spinner } from "../components/ui/spinner";
import { ChevronDown, ChevronRight, Plus, Minus, RefreshCw, FileCode } from "lucide-react";

type ResourceChange = {
  address: string;
  module_address?: string;
  mode: string;
  type: string;
  name: string;
  change: {
    actions: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
};

type ActionIcon = typeof Plus | typeof Minus | typeof RefreshCw;

type PlanJson = {
  resource_changes?: ResourceChange[];
  output_changes?: Record<string, { actions?: string[]; before?: unknown; after?: unknown }>;
  configuration?: { provider_config?: Record<string, unknown> };
  terraform_version?: string;
  format_version?: string;
};

const actionConfig: Record<string, { icon: ActionIcon; label: string; color: string }> = {
  create: { icon: Plus, label: "create", color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
  delete: { icon: Minus, label: "delete", color: "text-red-600 bg-red-50 border-red-200" },
  update: { icon: RefreshCw, label: "change", color: "text-blue-600 bg-blue-50 border-blue-200" },
  "no-op": { icon: RefreshCw, label: "no-op", color: "text-gray-400 bg-gray-50 border-gray-200" },
  read: { icon: RefreshCw, label: "read", color: "text-purple-600 bg-purple-50 border-purple-200" },
};

function summaryCounts(changes: ResourceChange[]): { add: number; change: number; destroy: number } {
  let add = 0, change = 0, destroy = 0;
  for (const rc of changes) {
    for (const a of rc.change.actions) {
      if (a === "create") add++;
      else if (a === "update") change++;
      else if (a === "delete") destroy++;
    }
  }
  return { add, change, destroy };
}

function ResourceRow({ rc, depth }: Readonly<{ rc: ResourceChange; depth: number }>): React.JSX.Element {
  const actions = rc.change.actions;
  const action = actions[0] ?? "no-op";
  const cfg: { icon: ActionIcon; label: string; color: string } = actionConfig[action] ?? actionConfig["no-op"]!;
  const Icon = cfg.icon;
  return (
    <div className={`flex items-center gap-3 py-2 px-3 text-sm border-b border-gray-100 last:border-0 ${depth > 0 ? "ml-6" : ""}`}>
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}>
        <Icon className="size-3" />
        {cfg.label}
      </span>
      <code className="text-xs font-mono text-gray-800">{rc.type}</code>
      <span className="text-xs text-gray-600 truncate">{rc.address}</span>
    </div>
  );
}

function ResourceChangesCard({ resources }: Readonly<{ resources: ResourceChange[] }>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const counts = summaryCounts(resources);
  const total = resources.length;

  if (total === 0) return <></>;

  return (
    <div className="border-t border-gray-200">
      <button
        onClick={(): void => { setExpanded(!expanded); }}
        className="flex items-center justify-between w-full px-5 py-3 text-sm hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="size-4 text-gray-400" /> : <ChevronRight className="size-4 text-gray-400" />}
          <span className="font-medium text-gray-700">Resource changes</span>
          <span className="text-xs text-gray-500">({total} resources)</span>
        </div>
        <div className="flex items-center gap-3 text-xs font-medium">
          {counts.add > 0 && <span className="text-emerald-600">+{counts.add} to add</span>}
          {counts.change > 0 && <span className="text-blue-600">~{counts.change} to change</span>}
          {counts.destroy > 0 && <span className="text-red-600">-{counts.destroy} to destroy</span>}
        </div>
      </button>
      {expanded && (
        <div className="max-h-[480px] overflow-y-auto border-t border-gray-100">
          {resources.map((rc, i) => (
            <ResourceRow key={`${rc.address}-${i}`} rc={rc} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}

function OutputChangesCard({ outputs }: Readonly<{ outputs: [string, { actions?: string[]; before?: unknown; after?: unknown }][] }>): React.JSX.Element {
  if (outputs.length === 0) return <></>;
  return (
    <div className="border-t border-gray-200 px-5 py-3">
      <h4 className="text-sm font-medium text-gray-700 mb-2">Output changes</h4>
      <div className="grid gap-1.5">
        {outputs.map(([name, oc]) => (
          <div key={name} className="flex items-center gap-2 text-xs">
            <Badge variant="outline" className="font-mono text-[10px]">{name}</Badge>
            <span className="text-gray-500">
              {oc.actions?.includes("create") ? "added" :
               oc.actions?.includes("update") ? "changed" :
               oc.actions?.includes("delete") ? "deleted" : "unchanged"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PlanOutput({ runId }: Readonly<{ runId: string }>): React.JSX.Element {
  const [planJson, setPlanJson] = useState<PlanJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect((): (() => void) => {
    let cancelled = false;
    setLoading(true);
    setError("");

    fetchApi(`/api/v2/plans/plan-${runId}/json-output`)
      .then((data: unknown) => {
        if (!cancelled) {
          setPlanJson(data as PlanJson);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load plan output";
          if (msg.includes("404")) {
            setError(""); // Not available yet — plan may still be running
          } else {
            setError(msg);
          }
          setLoading(false);
        }
      });

    return (): void => { cancelled = true; };
  }, [runId]);

  if (loading) {
    return (
      <div className="border-t border-gray-200 px-5 py-4 flex items-center gap-2 text-sm text-gray-500">
        <Spinner className="size-4" />
        Loading plan output...
      </div>
    );
  }

  if (error !== "") {
    return (
      <div className="border-t border-gray-200 px-5 py-3">
        <p className="text-xs text-red-500">{error}</p>
      </div>
    );
  }

  if (planJson === null) return <></>;

  const resources = planJson.resource_changes ?? [];
  const outputEntries = Object.entries(planJson.output_changes ?? {});

  return (
    <div className="border-t border-gray-200">
      {/* Summary badge */}
      <div className="flex items-center gap-3 px-5 py-2 bg-gray-50 border-b border-gray-200">
        <FileCode className="size-4 text-gray-400" />
        <span className="text-xs font-medium text-gray-600">
          Terraform v{planJson.terraform_version ?? "?"} &bull;
          format {planJson.format_version ?? "?"}
        </span>
      </div>

      {/* Resource changes */}
      <ResourceChangesCard resources={resources} />

      {/* Output changes */}
      <OutputChangesCard outputs={outputEntries} />
    </div>
  );
}
