import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Search,
  XCircle,
} from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";
import { fetchAllApiPages, fetchApi } from "../lib/api";

type RunItem = {
  id: string;
  attributes: {
    "created-at"?: string;
    message?: string | null;
    source?: string;
    status: string;
    "trigger-reason"?: string;
  };
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  fetching: "Fetching configuration",
  fetching_completed: "Configuration fetched",
  pre_plan_running: "Running pre-plan tasks",
  pre_plan_completed: "Pre-plan tasks completed",
  queuing: "Queuing plan",
  plan_queued: "Plan queued",
  planning: "Planning",
  planned: "Needs confirmation",
  cost_estimating: "Estimating cost",
  cost_estimated: "Cost estimated",
  policy_checking: "Checking policies",
  policy_override: "Policy override required",
  policy_checked: "Policy checks passed",
  policy_soft_failed: "Policy override required",
  post_plan_running: "Running post-plan tasks",
  post_plan_completed: "Post-plan tasks completed",
  planned_and_finished: "Planned and finished",
  planned_and_saved: "Plan saved",
  confirmed: "Confirmed",
  apply_queued: "Apply queued",
  applying: "Applying",
  applied: "Applied",
  errored: "Errored",
  failed: "Failed",
  canceled: "Canceled",
  discarded: "Discarded",
  force_canceled: "Force canceled",
  unreachable: "Unreachable",
  manual: "Manual",
  pull_request: "Pull request",
  push: "Push",
  tag: "Tag",
};

const FAILED_STATUSES = new Set(["errored", "failed", "unreachable"]);
const FINISHED_STATUSES = new Set(["applied", "planned_and_finished"]);
const ATTENTION_STATUSES = new Set(["planned", "planned_and_saved", "policy_soft_failed"]);

type RunType = "empty" | "plan" | "refresh" | "standard";

const RUN_TYPE_DESCRIPTIONS: Record<RunType, string> = {
  standard: "Create a plan that can be confirmed and applied.",
  refresh: "Detect drift and synchronize the workspace state.",
  plan: "Create a speculative plan that cannot be applied.",
  empty: "Allow an unchanged plan to be confirmed and applied.",
};

const RUN_TYPE_LABELS: Record<RunType, string> = {
  standard: "Plan and apply",
  refresh: "Refresh state",
  plan: "Plan only",
  empty: "Allow empty apply",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

function formatDate(value: string | undefined): string {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString();
}

function StatusIcon({ status }: Readonly<{ status: string }>): React.JSX.Element {
  if (FINISHED_STATUSES.has(status)) return <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />;
  if (FAILED_STATUSES.has(status)) return <XCircle className="size-4 text-red-600" aria-hidden="true" />;
  if (ATTENTION_STATUSES.has(status)) return <AlertCircle className="size-4 text-amber-600" aria-hidden="true" />;
  if (["canceled", "discarded", "force_canceled"].includes(status)) {
    return <XCircle className="size-4 text-gray-500" aria-hidden="true" />;
  }
  return <Clock className="size-4 text-blue-600" aria-hidden="true" />;
}

function displaySource(source: string | undefined): string {
  if (source === undefined || source === "") return "—";
  const labels: Readonly<Record<string, string>> = {
    bitbucket: "Bitbucket",
    github: "GitHub",
    gitlab: "GitLab",
    "tfe-api": "TFE API",
    "tfe-no-code": "No-code provisioning",
  };
  return labels[source] ?? statusLabel(source);
}

export function RunList({
  workspaceId,
  orgName: propOrgName,
  workspaceName: propWorkspaceName,
  canStartRun = true,
}: Readonly<{
  workspaceId: string;
  orgName?: string;
  workspaceName?: string;
  canStartRun?: boolean;
}>): React.JSX.Element {
  const params = useParams<{ orgName: string; workspaceName: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const orgName = propOrgName ?? params.orgName ?? "";
  const workspaceName = propWorkspaceName ?? params.workspaceName ?? "";
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [runMessage, setRunMessage] = useState("");
  const [runType, setRunType] = useState<RunType>("standard");
  const [creating, setCreating] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const loadRuns = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const response = await fetchAllApiPages<RunItem>(`/api/v2/workspaces/${workspaceId}/runs`, signal);
      if (!signal.aborted) {
        setRuns(response);
        setError("");
      }
    } catch (error: unknown) {
      if (!signal.aborted) setError(error instanceof Error ? error.message : "Could not load runs");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [workspaceId]);

  useEffect((): (() => void) => {
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();

    const refresh = async (): Promise<void> => {
      await loadRuns(controller.signal);
      if (!stopped && !controller.signal.aborted) {
        timer = window.setTimeout((): void => { void refresh(); }, 5000);
      }
    };
    void refresh();

    return (): void => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadRuns, refreshVersion]);

  useEffect((): void => {
    if (canStartRun && searchParams.get("new-run") === "true") setDialogOpen(true);
  }, [canStartRun, searchParams]);

  const filteredRuns = useMemo((): RunItem[] => {
    const query = filter.trim().toLocaleLowerCase();
    if (query === "") return runs;
    return runs.filter((run: RunItem): boolean => [
      run.id,
      run.attributes.message,
      run.attributes.status,
      statusLabel(run.attributes.status),
      run.attributes.source,
      run.attributes["trigger-reason"],
    ].some((value: string | null | undefined): boolean => value?.toLocaleLowerCase().includes(query) === true));
  }, [filter, runs]);

  async function handleStartRun(): Promise<void> {
    if (!canStartRun) return;
    setCreating(true);
    try {
      const response = await fetchApi("/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "runs",
            attributes: {
              message: runMessage.trim() !== "" ? runMessage.trim() : undefined,
              "plan-only": runType === "plan",
              "refresh-only": runType === "refresh",
              "allow-empty-apply": runType === "empty",
              "auto-apply": runType === "plan" ? false : undefined,
            },
            relationships: {
              workspace: { data: { type: "workspaces", id: workspaceId } },
            },
          },
        }),
      }) as { data?: { id?: unknown } };
      handleDialogOpenChange(false);
      setRunMessage("");
      setRunType("standard");
      toast.add({ title: "Run started", type: "success" });
      setRefreshVersion((value: number): number => value + 1);
      if (typeof response.data?.id === "string" && response.data.id !== "") {
        void navigate(
          `/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}/runs/${encodeURIComponent(response.data.id)}`,
        );
      }
    } catch (error: unknown) {
      toast.add({
        title: error instanceof Error ? error.message : "Failed to start run",
        type: "error",
      });
    } finally {
      setCreating(false);
    }
  }

  const handleDialogOpenChange = (open: boolean): void => {
    setDialogOpen(open);
    if (!open && searchParams.has("new-run")) {
      const next = new URLSearchParams(searchParams);
      next.delete("new-run");
      setSearchParams(next, { replace: true });
    }
  };

  if (loading) return <div role="status" className="py-8 text-center text-gray-500">Loading runs...</div>;
  if (error !== "" && runs.length === 0) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <p className="font-medium">Could not load runs</p>
        <p className="mt-1">{error}</p>
        <Button className="mt-3" variant="outline" onClick={(): void => { setRefreshVersion((value): number => value + 1); }}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <label htmlFor="run-filter" className="sr-only">Filter runs</label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <Input
            id="run-filter"
            type="search"
            value={filter}
            onChange={(event): void => { setFilter(event.target.value); }}
            placeholder="Filter runs"
            className="h-9 pl-9"
          />
        </div>
        {canStartRun && (
          <Button
            className="h-9 rounded-[4px] bg-[#1060ff] px-4 text-white shadow-none hover:bg-[#0d4dcc]"
            onClick={(): void => { setDialogOpen(true); }}
          >
            Start new run
          </Button>
        )}
      </div>

      {error !== "" && runs.length > 0 && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>Run history may be out of date.</span>
          <Button variant="outline" onClick={(): void => { setRefreshVersion((value): number => value + 1); }}>
            Try again
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        {runs.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <h2 className="mb-1 text-base font-medium text-gray-950">No runs yet</h2>
            <p className={canStartRun ? "mb-4 text-sm" : "text-sm"}>
              {canStartRun
                ? "There is no run history for this workspace."
                : "There is no run history for this workspace, and you do not have permission to start one."}
            </p>
            {canStartRun && (
              <Button
                className="h-9 rounded-[4px] bg-[#1060ff] px-4 text-white shadow-none hover:bg-[#0d4dcc]"
                onClick={(): void => { setDialogOpen(true); }}
              >
                Start new run
              </Button>
            )}
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="p-10 text-center">
            <h2 className="text-sm font-medium text-gray-950">No matching runs</h2>
            <p className="mt-1 text-sm text-gray-500">Try a different message, status, source, or run ID.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-[#fafafa] text-xs font-semibold tracking-wide text-gray-800">
                  <th className="border-r border-gray-200 px-4 py-3">Run</th>
                  <th className="border-r border-gray-200 px-4 py-3">Status</th>
                  <th className="border-r border-gray-200 px-4 py-3">Source</th>
                  <th className="border-r border-gray-200 px-4 py-3">Trigger</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredRuns.map((run: RunItem): React.JSX.Element => (
                  <tr key={run.id} className="border-b border-gray-200 transition-colors last:border-b-0 hover:bg-gray-50">
                    <td className="border-r border-gray-200 px-4 py-3">
                      <Link
                        to={`/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}/runs/${encodeURIComponent(run.id)}`}
                        className="mb-0.5 block text-[13px] font-medium text-blue-700 hover:underline"
                      >
                        {run.attributes.message ?? "Manual run"}
                      </Link>
                      <span className="font-mono text-[11px] text-gray-500">{run.id}</span>
                    </td>
                    <td className="border-r border-gray-200 px-4 py-3">
                      <div className="flex items-center gap-2 text-[13px] font-medium text-gray-900">
                        <StatusIcon status={run.attributes.status} />
                        {statusLabel(run.attributes.status)}
                      </div>
                    </td>
                    <td className="border-r border-gray-200 px-4 py-3 text-[13px] text-gray-600">
                      {displaySource(run.attributes.source)}
                    </td>
                    <td className="border-r border-gray-200 px-4 py-3 text-[13px] capitalize text-gray-600">
                      {statusLabel(run.attributes["trigger-reason"] ?? "manual")}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-gray-500">
                      <time dateTime={run.attributes["created-at"]}>{formatDate(run.attributes["created-at"])}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canStartRun && <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Start new run</DialogTitle>
            <DialogDescription>
              Configure and start a new run for this workspace.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event): void => {
              event.preventDefault();
              void handleStartRun();
            }}
          >
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="run-message" className="text-sm font-medium">Run name</label>
                <Input
                  id="run-message"
                  placeholder="Triggered via UI"
                  value={runMessage}
                  onChange={(event): void => { setRunMessage(event.target.value); }}
                />
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Run type</legend>
                {(Object.keys(RUN_TYPE_LABELS) as RunType[]).map((type): React.JSX.Element => (
                  <label
                    key={type}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                      runType === type
                        ? "border-blue-600 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="run-type"
                      value={type}
                      checked={runType === type}
                      onChange={(): void => { setRunType(type); }}
                      aria-label={RUN_TYPE_LABELS[type]}
                      className="mt-0.5 size-4 accent-blue-600"
                    />
                    <span>
                      <span className="block text-sm font-medium text-gray-950">{RUN_TYPE_LABELS[type]}</span>
                      <span className="mt-0.5 block text-xs text-gray-500">{RUN_TYPE_DESCRIPTIONS[type]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={(): void => { handleDialogOpenChange(false); }}>Cancel</Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Starting..." : "Start run"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>}
    </div>
  );
}
