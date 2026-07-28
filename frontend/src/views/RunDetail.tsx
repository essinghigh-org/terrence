import { useCallback, useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { toast } from "../components/ui/toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { CheckCircle2, XCircle, Clock, AlertCircle, ChevronDown, ExternalLink } from "lucide-react";

type RunResource = {
  id: string;
  attributes: Record<string, unknown>;
};

type CostEstimate = {
  id: string;
  attributes: {
    status: string;
    "prior-monthly-cost"?: string;
    "proposed-monthly-cost"?: string;
    "delta-monthly-cost"?: string;
    "resources-count"?: number;
    "matched-resources-count"?: number;
    "unmatched-resources-count"?: number;
    "error-message"?: string | null;
  };
};

type PolicyCheck = {
  id: string;
  attributes: {
    status: string;
    result?: unknown;
    "created-at"?: string;
  };
};

function formatMonthlyCost(value: string | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return `${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} / month`;
}

function policyResultText(result: unknown): string {
  if (result === null || result === undefined) return "No detailed result";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") return `${result}`;
  if (typeof result !== "object") return "No detailed result";
  const details = result as Record<string, unknown>;
  const summary: string[] = [];
  if (typeof details["policy"] === "string") summary.push(details["policy"]);
  if (typeof details["error"] === "string") summary.push(details["error"]);
  const violations = details["violations"];
  if (Array.isArray(violations)) {
    summary.push(`${violations.length} violation${violations.length === 1 ? "" : "s"}${
      violations.length > 0 ? `: ${violations.map(String).join(", ")}` : ""
    }`);
  }
  return summary.length > 0 ? summary.join(" — ") : JSON.stringify(result);
}

export function RunDetail(): React.JSX.Element {
  const { orgName: rawOrgName, workspaceName: rawWorkspaceName, runId: rawRunId } = useParams<{ orgName: string; workspaceName: string; runId: string }>();
  const orgName = rawOrgName ?? "";
  const workspaceName = rawWorkspaceName ?? "";
  const runId = rawRunId ?? "";
  const [run, setRun] = useState<RunResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string>("");
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [policyChecks, setPolicyChecks] = useState<PolicyCheck[]>([]);
  const logsRef = useRef<HTMLPreElement>(null);

  const loadRun = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const data = await fetchApi(`/api/v2/runs/${runId}`, { signal }) as { data: RunResource };
      signal.throwIfAborted();
      setRun(data.data);

      const [logResult, costResult, policyResult] = await Promise.allSettled([
        data.data.attributes["status"] === "pending"
          ? Promise.resolve(null)
          : fetchApi(`/api/v2/runs/${runId}/logs`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/cost-estimate`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/policy-checks`, { signal }),
      ]);
      signal.throwIfAborted();
      if (logResult.status === "fulfilled" && logResult.value !== null) {
        const logData = logResult.value as {
          data?: { attributes?: { "output-text"?: string } }[];
          logs?: { message: string }[];
        };
        setLogs(
          logData.logs?.map((log): string => log.message).join("")
          ?? logData.data?.map((log): string => log.attributes?.["output-text"] ?? "").join("")
          ?? "",
        );
      }
      if (costResult.status === "fulfilled") {
        const costData = costResult.value as { data?: CostEstimate };
        setCostEstimate(costData.data ?? null);
      }
      if (policyResult.status === "fulfilled") {
        const policyData = policyResult.value as { data?: PolicyCheck[] };
        setPolicyChecks(Array.isArray(policyData.data) ? policyData.data : []);
      }
    } catch (err: unknown) {
      if (!signal.aborted) console.error(err);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [runId]);

  useEffect((): (() => void) => {
    let active = true;
    const controllers = new Set<AbortController>();
    const refresh = (): void => {
      if (!active) return;
      const controller = new AbortController();
      controllers.add(controller);
      void loadRun(controller.signal).finally((): void => { controllers.delete(controller); });
    };
    refresh();
    const interval = window.setInterval(refresh, 3000);
    return (): void => {
      active = false;
      window.clearInterval(interval);
      controllers.forEach((controller): void => { controller.abort(); });
    };
  }, [loadRun]);

  useEffect((): void => {
    if (logsRef.current != null) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  async function handleApply(): Promise<void> {
    try {
      await fetchApi(`/api/v2/runs/${runId}/actions/apply`, { method: "POST" });
      toast.add({ title: "Run queued for apply", type: "success" });
    } catch {
      toast.add({ title: "Failed to apply run", type: "error" });
    }
  }

  async function handleDiscard(): Promise<void> {
    try {
      await fetchApi(`/api/v2/runs/${runId}/actions/discard`, { method: "POST" });
      toast.add({ title: "Run discarded", type: "success" });
    } catch {
      toast.add({ title: "Failed to discard run", type: "error" });
    }
  }

  async function handleOverridePolicy(): Promise<void> {
    try {
      await fetchApi(`/api/v2/runs/${runId}/actions/override-policy`, { method: "POST" });
      toast.add({ title: "Policy override accepted", type: "success" });
    } catch {
      toast.add({ title: "Failed to override policy", type: "error" });
    }
  }

  if (loading && run === null) return <div className="p-8 text-gray-500">Loading run...</div>;
  if (run === null) return <div className="p-8 text-gray-500">Run not found</div>;

  const status = run.attributes["status"] as string;
  const isPending = status === 'pending';
  const isPlanning = status === 'planning';
  const isPlanned = status === 'planned' || status === "planned_and_saved";
  const isApplying = status === 'applying';
  const isApplied = status === 'applied';
  const isErrored = status === 'errored' || status === 'failed';
  const costAttributes = costEstimate?.attributes;
  const costStatus = costAttributes?.status ?? "unavailable";
  const costPending = costStatus === "queued" || costStatus === "pending";
  const costFailed = costStatus === "errored" || costStatus === "canceled";
  const hasSoftFailedPolicy = status === "policy_soft_failed"
    || policyChecks.some((check: PolicyCheck): boolean => check.attributes.status === "soft_failed");
  const hasFailedPolicy = policyChecks.some((check: PolicyCheck): boolean =>
    ["failed", "soft_failed", "hard_failed", "errored", "unreachable"].includes(check.attributes.status),
  );
  const policySummary = policyChecks.length === 0
    ? status === "policy_checking" ? "checking" : "not required"
    : hasFailedPolicy ? hasSoftFailedPolicy ? "soft failed" : "failed"
    : policyChecks.every((check: PolicyCheck): boolean => check.attributes.status === "overridden")
      ? "overridden"
      : "passed";

  return (
    <div className="max-w-full w-full">
      {/* Breadcrumbs */}
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5 font-medium">
        <Link to={`/app/${orgName}`} className="hover:underline">{orgName}</Link>
        <span className="text-gray-300">/</span>
        <Link to={`/app/${orgName}/workspaces/${workspaceName}`} className="hover:underline">{workspaceName}</Link>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900">Runs</span>
        <span className="text-gray-300">/</span>
        <span className="text-gray-900 font-mono">{runId}</span>
      </div>

      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight mb-2">
            {(run.attributes["message"] as string | null) ?? "Manual run"}
          </h1>
          <div className="flex items-center gap-4 text-[13px] text-gray-600">
             <div className="flex items-center gap-1.5">
               <div className="h-5 w-5 rounded bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-600">U</div>
               <span>User triggered</span>
             </div>
             <span>•</span>
              <span>Created {new Date(run.attributes["created-at"] as string).toLocaleString()}</span>
          </div>
        </div>

        {isPlanned && (
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleDiscard} className="bg-white">Discard run</Button>
            <Button onClick={handleApply} className="bg-[#2962ff] hover:bg-[#1a4bcf] text-white">Confirm & Apply</Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2">
          {/* Run timeline UI mimicking screenshot */}
          <div className="bg-white border border-gray-200 rounded-md shadow-sm mb-6 overflow-hidden">
             {/* Plan step */}
             <div className="border-b border-gray-200">
                <div className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50">
                   <div className="flex items-center gap-3">
                      {isPending ? <Clock className="h-5 w-5 text-gray-400" /> :
                       isPlanning ? <Clock className="h-5 w-5 text-blue-500" /> :
                       isErrored && !isApplying ? <XCircle className="h-5 w-5 text-red-500" /> :
                       <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
                      <span className="font-semibold text-gray-900">Plan</span>
                   </div>
                   <div className="flex items-center gap-4">
                      {run.attributes["has-changes"] !== undefined && (
                        <span className="text-sm text-gray-600">
                       {(run.attributes["has-changes"] as boolean | undefined) === true ? "Changes to apply" : "No changes"}
                        </span>
                      )}
                      <ChevronDown className="h-4 w-4 text-gray-400" />
                   </div>
                </div>

                {/* Embedded Terminal for Plan */}
                {(!isPending) && (
                  <div className="bg-[#111315] p-4 text-gray-300 font-mono text-[13px] leading-relaxed border-t border-gray-200 relative overflow-hidden">
                       <pre ref={logsRef} className="max-h-[400px] overflow-y-auto whitespace-pre-wrap">{logs !== "" ? logs : "Initializing..."}</pre>
                     <div className="absolute top-4 right-4 flex gap-2">
                        <button className="bg-white/10 hover:bg-white/20 text-white rounded p-1.5 transition-colors">
                           <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                     </div>
                  </div>
                )}
             </div>

             {/* Cost Estimation step */}
             <div className="border-b border-gray-200">
                <div className="flex items-center justify-between px-5 py-4">
                   <div className="flex items-center gap-3">
                      {costPending ? (
                        <Clock className="h-5 w-5 text-muted-foreground" />
                      ) : costFailed ? (
                        <XCircle className="h-5 w-5 text-destructive" />
                      ) : (
                        <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
                      )}
                      <span className="font-semibold text-gray-900">Cost estimation</span>
                   </div>
                   <div className="flex items-center gap-3">
                      <Badge variant={costFailed ? "destructive" : costPending ? "outline" : "secondary"}>
                        {costStatus.replace(/_/g, " ")}
                      </Badge>
                      {costAttributes != null && (
                        <span className="font-mono text-sm font-medium">
                          {formatMonthlyCost(costAttributes["delta-monthly-cost"])}
                        </span>
                      )}
                   </div>
                </div>
                {costAttributes != null && (
                  <dl aria-label="Cost estimate details" className="grid grid-cols-2 gap-4 px-5 pb-4 text-sm md:grid-cols-4">
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">Prior monthly</dt>
                      <dd className="font-medium">{formatMonthlyCost(costAttributes["prior-monthly-cost"])}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">Proposed monthly</dt>
                      <dd className="font-medium">{formatMonthlyCost(costAttributes["proposed-monthly-cost"])}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">Monthly delta</dt>
                      <dd className="font-medium">{formatMonthlyCost(costAttributes["delta-monthly-cost"])}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">Priced resources</dt>
                      <dd className="font-medium">
                        {costAttributes["matched-resources-count"] ?? 0} of {costAttributes["resources-count"] ?? 0}
                      </dd>
                    </div>
                    {costAttributes["error-message"] != null && (
                      <div className="col-span-full text-destructive">
                        {costAttributes["error-message"]}
                      </div>
                    )}
                  </dl>
                )}
             </div>

             {/* Policy Check step */}
             <div className="border-b border-gray-200">
                <div className="flex items-center justify-between px-5 py-4">
                   <div className="flex items-center gap-3">
                      {hasFailedPolicy ? (
                        <AlertCircle className="h-5 w-5 text-destructive" />
                      ) : policySummary === "checking" ? (
                        <Clock className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
                      )}
                      <span className="font-semibold text-gray-900">Policy check</span>
                   </div>
                   {hasSoftFailedPolicy ? (
                      <div className="flex items-center gap-2">
                        <Badge variant="destructive">Soft failed</Badge>
                        <Button size="sm" variant="outline" onClick={(): void => { void handleOverridePolicy(); }}>
                          Override policy
                        </Button>
                      </div>
                   ) : (
                      <Badge variant={hasFailedPolicy ? "destructive" : policySummary === "passed" ? "default" : "secondary"}>
                        {policySummary}
                      </Badge>
                   )}
                </div>
                {policyChecks.length > 0 && (
                  <div className="px-5 pb-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Check</TableHead>
                          <TableHead>Result</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {policyChecks.map((check: PolicyCheck): React.JSX.Element => (
                          <TableRow key={check.id}>
                            <TableCell className="font-mono text-xs">{check.id}</TableCell>
                            <TableCell className="whitespace-normal">
                              {policyResultText(check.attributes.result)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  ["failed", "soft_failed", "hard_failed", "errored", "unreachable"].includes(check.attributes.status)
                                    ? "destructive"
                                    : check.attributes.status === "passed" ? "default" : "secondary"
                                }
                              >
                                {check.attributes.status.replace(/_/g, " ")}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
             </div>

             {/* Apply step */}
             <div>
                <div className="flex items-center justify-between px-5 py-4">
                   <div className="flex items-center gap-3">
                      {isApplied ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> :
                       isApplying ? <Clock className="h-5 w-5 text-blue-500" /> :
                       isPlanned ? <AlertCircle className="h-5 w-5 text-orange-500" /> :
                       <div className="h-5 w-5 rounded-full border-2 border-gray-300 flex items-center justify-center" />}
                      <span className={`font-semibold ${isApplied || isApplying || isPlanned ? 'text-gray-900' : 'text-gray-500'}`}>Apply</span>
                   </div>
                   {isPlanned && <span className="text-sm text-orange-600 font-medium bg-orange-50 px-2 py-0.5 rounded border border-orange-200">Needs confirmation</span>}
                </div>
             </div>
          </div>
        </div>

        <div className="col-span-1">
          <div className="bg-white border border-gray-200 rounded-md shadow-sm">
            <div className="px-4 py-3 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900">Run Details</h3>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Status</div>
                <div className="text-[13px] text-gray-900 font-medium capitalize">
                   {status.replace(/_/g, ' ')}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Workspace</div>
                <div className="text-[13px] text-blue-600 hover:underline cursor-pointer font-medium">
                   {workspaceName}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Auto-apply</div>
                <div className="text-[13px] text-gray-900">
                   {(run.attributes["auto-apply"] as boolean | undefined) === true ? "Enabled" : "Disabled"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
