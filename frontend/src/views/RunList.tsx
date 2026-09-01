import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Copy,
  Search,
} from "lucide-react";
import { Avatar, AvatarImage } from "../components/ui/avatar";
import { DegradedBanner } from "../components/DegradedBanner";
import { EmptyState } from "../components/EmptyState";
import { formatDateTime, formatRelativeTime } from "@/lib/utils";
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
import { StatusBadge } from "../components/ui/status-badge";
import { toast } from "../components/ui/toast";
import { fetchApi } from "../lib/api";
import { useTerrenceEvent } from "../lib/event-provider";
import { isNumber, isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";
import { formatRunSource, formatRunStatusForUi, isVcsRunSource } from "../lib/run-labels";

const MAX_RUN_LIST_PAGES = 3;

type RunItem = {
  id: string;
  attributes: {
    "created-at"?: string;
    message?: string | null;
    source?: string;
    status: string;
    "trigger-reason"?: string;
    "branch"?: string | null;
    "commit-sha"?: string | null;
    "commit-url"?: string | null;
    "triggered-by"?: string | null;
    "triggered-by-avatar-url"?: string | null;
    operation?: string;
    "is-destroy"?: boolean;
    "plan-only"?: boolean;
    "refresh-only"?: boolean;
    "allow-empty-apply"?: boolean;
    "target-addrs"?: string[] | null;
    "replace-addrs"?: string[] | null;
  };
  relationships?: {
    "created-by"?: {
      data: { id: string; type: string } | null;
    };
  };
};

type IncludedUser = {
  id: string;
  type: string;
  attributes: {
    username: string;
    "avatar-url"?: string;
  };
};

type RunType = "empty" | "plan" | "refresh" | "standard";

function shortRunId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

const RUN_TYPE_DESCRIPTIONS = {
  standard: "Create a plan that can be confirmed and applied.",
  refresh: "Detect drift and synchronize the workspace state.",
  plan: "Create a speculative plan that cannot be applied.",
  empty: "Allow an unchanged plan to be confirmed and applied.",
};

const RUN_TYPE_LABELS = {
  standard: "Plan and apply",
  refresh: "Refresh state",
  plan: "Plan only",
  empty: "Allow empty apply",
};

/**
 * Split a comma/space-separated address input into individual resource
 * addresses (e.g. "aws_instance.web, aws_instance.db"). Empty segments are
 * dropped, matching the backend's RUN_ADDRESS_PATTERN expectations.
 */
function parseAddressList(value: string): string[] | null {
  const parts = value
    .split(/[\s,]+/)
    .map((part: string): string => part.trim())
    .filter((part: string): boolean => part !== "");
  return parts.length > 0 ? [...new Set(parts)] : null;
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
  const [usersMap, setUsersMap] = useState<ReadonlyMap<string, IncludedUser>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Latest effect's SSE dispatcher (see the refresh effect below).
  const runStatusDispatchRef = useRef<() => void>(() => {});
  const [filter, setFilter] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [runMessage, setRunMessage] = useState("");
  const [runType, setRunType] = useState<RunType>("standard");
  const [runDestroy, setRunDestroy] = useState(false);
  const [runTargets, setRunTargets] = useState("");
  const [runReplace, setRunReplace] = useState("");
  const [creating, setCreating] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [sort, setSort] = useState<"" | "created-at" | "-created-at" | "status" | "-status">("");

  const loadRuns = useCallback(async (signal: AbortSignal): Promise<void> => {
    try {
      const endpoint = `/api/v2/workspaces/${workspaceId}/runs`;
      const firstUrl = new URL(endpoint, "http://terrence.local");
      if (sort !== "") firstUrl.searchParams.set("sort", sort);
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(`${firstUrl.pathname}${firstUrl.search}`, signal === undefined ? {} : { signal }) as {
        data?: RunItem[];
        included?: IncludedUser[];
        meta?: { pagination?: JsonObject };
      };
      if (!signal.aborted) {
        const allRuns = Array.isArray(response.data) ? [...response.data] : [];
        // Build user map from included
        const userList = Array.isArray(response.included) ? response.included : [];
        const userMap = new Map<string, IncludedUser>();
        for (const user of userList) {
          if (user.type === "users") userMap.set(user.id, user);
        }
        // Fetch remaining pages
        let nextPage = response.meta?.pagination?.["next-page"];
        let fetchedPages = 1;
        while (isNumber(nextPage) && Number.isSafeInteger(nextPage) && nextPage > 0 && !signal.aborted && fetchedPages < MAX_RUN_LIST_PAGES) {
          const nextUrl = new URL(endpoint, "http://terrence.local");
          nextUrl.searchParams.set("page[number]", String(nextPage));
          nextUrl.searchParams.set("sort", sort);
          const nextPath = `${nextUrl.pathname}${nextUrl.search}`;
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
          const nextRes = await fetchApi(nextPath, signal === undefined ? {} : { signal }) as {
            data?: RunItem[];
            included?: IncludedUser[];
            meta?: { pagination?: JsonObject };
          };
          if (signal.aborted) break;
          if (Array.isArray(nextRes.data)) allRuns.push(...nextRes.data);
          // Add users from included on subsequent pages too
          if (Array.isArray(nextRes.included)) {
            for (const user of nextRes.included) {
              if (user.type === "users" && !userMap.has(user.id)) userMap.set(user.id, user);
            }
          }
          nextPage = nextRes.meta?.pagination?.["next-page"];
          fetchedPages++;
        }
        setRuns(allRuns);
        setUsersMap(userMap);
        setError("");
      }
    } catch (error: unknown) {
      if (!signal.aborted) setError(error instanceof Error ? error.message : "Could not load runs");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [workspaceId, sort]);

  useEffect((): (() => void) => {
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();

    const refresh = async (): Promise<void> => {
      await loadRuns(controller.signal);
      if (!stopped && !controller.signal.aborted) {
        // Fast updates arrive over the SSE stream; this timer is a slow
        // safety net for streams that fail (10.20).
        timer = window.setTimeout((): void => { void refresh(); }, 30000);
      }
    };
    void refresh();

    // App-global SSE (EventProvider): any run status transition in this
    // workspace reloads the list (debounced so bursts coalesce into one
    // fetch). An in-flight guard prevents a slow timer refresh from racing
    // an SSE-triggered load and writing stale results last.
    let inFlight = false;
    let debounceTimer: number | undefined;
    const reload = (): void => {
      if (inFlight || stopped || controller.signal.aborted) return;
      inFlight = true;
      void loadRuns(controller.signal).finally((): void => {
        inFlight = false;
      });
    };
    runStatusDispatchRef.current = (): void => {
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout((): void => {
        debounceTimer = undefined;
        reload();
      }, 500);
    };

    return (): void => {
      stopped = true;
      controller.abort();
      runStatusDispatchRef.current = (): void => {};
      if (timer !== undefined) window.clearTimeout(timer);
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    };
  }, [loadRuns, refreshVersion, workspaceId]);

  // App-global SSE (EventProvider): any status transition in this workspace
  // reloads the list through the effect's debounced dispatcher.
  useTerrenceEvent("run.status", (data): boolean => data["workspace-id"] === workspaceId, (): void => {
    runStatusDispatchRef.current();
  });

  useEffect((): void => {
    if (canStartRun && searchParams.get("new-run") === "true") {
      openNewRunDialog();
    }
  }, [canStartRun, searchParams]);

  /**
   * Open the dialog with a clean slate (used by "Start new run" and the
   * new-run=true URL hook). Cloning from an existing run uses
   * cloneRunSettings instead, which leaves the previous clone's edits intact
   * only when the dialog stays open.
   */
  const openNewRunDialog = (): void => {
    setRunMessage("");
    setRunType("standard");
    setRunDestroy(false);
    setRunTargets("");
    setRunReplace("");
    setDialogOpen(true);
  };

  /**
   * Cycle a sortable column: first click sorts descending (newest/highest
   * first, matching the default created-at order), second click ascending,
   * third click returns to the unset default (server order). Switching
   * columns resets to that column's descending order. Sort is applied
   * server-side via the reference-format-compatible ?sort= parameter; an unset sort sends
   * no parameter at all.
   */
  const toggleSort = (column: "created-at" | "status"): void => {
    setSort((current) => {
      if (current === `-${column}`) return column;
      if (current === column) return "";
      return `-${column}` as const;
    });
  };

  const sortArrows = (column: "created-at" | "status"): React.JSX.Element | null => {
    if (sort === column) return <ArrowUp className="size-3" aria-hidden="true" />;
    if (sort === `-${column}`) return <ArrowDown className="size-3" aria-hidden="true" />;
    return null;
  };

  const filteredRuns = useMemo((): RunItem[] => {
    const query = filter.trim().toLocaleLowerCase();
    if (query === "") return runs;
    return runs.filter((run: RunItem): boolean => {
      const creatorId = run.relationships?.["created-by"]?.data?.id;
      const creatorName = creatorId !== undefined ? usersMap.get(creatorId)?.attributes.username : undefined;
      return [
        run.id,
        run.attributes.message,
        run.attributes.status,
        formatRunStatusForUi(run.attributes.status),
        run.attributes.source,
        run.attributes["trigger-reason"],
        creatorName,
      ].some((value: string | null | undefined): boolean => value?.toLocaleLowerCase().includes(query) === true);
    });
  }, [filter, runs, usersMap]);

  async function handleStartRun(): Promise<void> {
    if (!canStartRun) return;
    setCreating(true);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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
              "is-destroy": runDestroy,
              "target-addrs": parseAddressList(runTargets),
              "replace-addrs": parseAddressList(runReplace),
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
      setRunDestroy(false);
      setRunTargets("");
      setRunReplace("");
      toast.add({ title: "Run started", type: "success" });
      setRefreshVersion((value: number): number => value + 1);
      if (isString(response.data?.id) && response.data.id !== "") {
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

  /**
   * Prefill the new-run dialog from an existing run's settings so a recurring
   * operation (same targets, replace addresses, refresh/destroy mode) can be
   * repeated without retyping them.
   */
  const cloneRunSettings = (run: RunItem): void => {
    setRunMessage(run.attributes.message ?? "");
    setRunType(run.attributes["plan-only"] === true
      ? "plan"
      : run.attributes["refresh-only"] === true
        ? "refresh"
        : run.attributes["allow-empty-apply"] === true
          ? "empty"
          : "standard");
    setRunDestroy(run.attributes["is-destroy"] === true);
    setRunTargets((run.attributes["target-addrs"] ?? []).join(", "));
    setRunReplace((run.attributes["replace-addrs"] ?? []).join(", "));
    setDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean): void => {
    setDialogOpen(open);
    if (!open && searchParams.has("new-run")) {
      const next = new URLSearchParams(searchParams);
      next.delete("new-run");
      setSearchParams(next, { replace: true });
    }
  };

  if (loading) return <div role="status" className="py-8 text-center text-muted-foreground">Loading runs…</div>;
  if (error !== "" && runs.length === 0) {
    return (
      <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
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
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            id="run-filter"
            name="run-filter"
            autoComplete="off"
            type="search"
            value={filter}
            onChange={(event): void => { setFilter(event.target.value); }}
            placeholder="Filter runs…"
            className="h-9 pl-9"
          />
        </div>
        {canStartRun && (
          <Button
            onClick={openNewRunDialog}
          >
            Start new run
          </Button>
        )}
      </div>

      {error !== "" && runs.length > 0 && (
        <DegradedBanner
          title="Run history may be out of date."
          actionLabel="Try again"
          onAction={(): void => { setRefreshVersion((value): number => value + 1); }}
        />
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            description={canStartRun
              ? "There is no run history for this workspace."
              : "There is no run history for this workspace, and you do not have permission to start one."}
            {...(canStartRun ? { actionLabel: "Start new run", onAction: openNewRunDialog } : {})}
            docsHref="/app/docs/runs"
          />
        ) : filteredRuns.length === 0 ? (
          <EmptyState
            compact
            title="No matching runs"
            description="Try a different message, status, source, or run ID."
          />
        ) : (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:px-4 sm:py-3 border-b border-border bg-muted/20">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Run history</h2>
                <p className="text-xs text-muted-foreground">{filteredRuns.length} of {runs.length} runs</p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>Sort by</span>
                <button
                  type="button"
                  onClick={(): void => { toggleSort("status"); }}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Sort runs by status, currently ${sort === "status" ? "ascending" : sort === "-status" ? "descending" : "not sorted"}`}
                >
                  Status
                  {sortArrows("status")}
                </button>
                <button
                  type="button"
                  onClick={(): void => { toggleSort("created-at"); }}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Sort runs by created date, currently ${sort === "created-at" ? "ascending" : sort === "-created-at" ? "descending" : "not sorted"}`}
                >
                  Created
                  {sortArrows("created-at")}
                </button>
              </div>
            </div>
            <div className="divide-y divide-border">
              {filteredRuns.map((run: RunItem): React.JSX.Element => {
                const creatorId = run.relationships?.["created-by"]?.data?.id;
                const creatorUser = creatorId !== undefined ? usersMap.get(creatorId) : undefined;
                const username = creatorUser?.attributes.username ?? run.attributes["triggered-by"] ?? "System";
                const avatarUrl = creatorUser?.attributes["avatar-url"] ?? run.attributes["triggered-by-avatar-url"] ?? "";
                const isVcsSource = isVcsRunSource(run.attributes.source, run.attributes["trigger-reason"]);
                const sourceLabel = formatRunSource(run.attributes.source, run.attributes["trigger-reason"]);
// SAFETY: the fixed source list matches the VCS source union the UI renders.
                const externalSource = isVcsSource;
                return (
                  <article
                    key={run.id}
                    className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}/runs/${encodeURIComponent(run.id)}`}
                          className="truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                        >
                          {run.attributes.message ?? "Triggered via UI"}
                        </Link>
                      </div>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="font-mono text-2xs text-muted-foreground/90" title={run.id}>{shortRunId(run.id)}</span>
                        {run.attributes.operation !== undefined && run.attributes.operation !== "plan_and_apply" && (
                          <><span aria-hidden="true">·</span><span className="text-foreground/80">{run.attributes.operation.replace(/_/g, " ")}</span></>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className="flex items-center gap-1">
                          {avatarUrl !== "" && (
                            <Avatar className="inline-flex size-3.5 rounded-full">
                              <AvatarImage src={avatarUrl} alt={username} className="rounded-full object-cover" />
                            </Avatar>
                          )}
                          <span>{username}</span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>via {sourceLabel}</span>
                        {externalSource && run.attributes.branch !== null && run.attributes.branch !== undefined && (
                          <><span aria-hidden="true">·</span><span>{`branch ${run.attributes.branch}`}</span></>
                        )}
                        {externalSource && run.attributes["commit-sha"] !== null && run.attributes["commit-sha"] !== undefined && run.attributes["commit-sha"] !== "" && (
                          <>
                            <span aria-hidden="true">·</span>
                            {run.attributes["commit-url"] !== null && run.attributes["commit-url"] !== undefined && run.attributes["commit-url"] !== "" ? (
                              <a
                                href={run.attributes["commit-url"]}
                                target="_blank"
                                rel="noreferrer"
                                title={run.attributes["commit-sha"]}
                                className="inline-flex items-center gap-0.5 font-mono text-2xs text-primary hover:underline"
                              >
                                {run.attributes["commit-sha"].slice(0, 7)}
                                <ArrowUpRight className="size-3" aria-hidden="true" />
                              </a>
                            ) : (
                              <span className="font-mono text-2xs" title={run.attributes["commit-sha"]}>{run.attributes["commit-sha"].slice(0, 7)}</span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <StatusBadge status={run.attributes.status} />
                      <div className="text-right text-xs text-muted-foreground min-w-[5.5rem]">
                        <time dateTime={run.attributes["created-at"]} title={formatDateTime(run.attributes["created-at"])}>
                          {formatRelativeTime(run.attributes["created-at"])}
                        </time>
                      </div>
                      {canStartRun && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={(): void => { cloneRunSettings(run); }}
                          aria-label="Clone run"
                          title="Clone this run's settings"
                        >
                          <Copy className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
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
                  name="run-message"
                  autoComplete="off"
                  placeholder="Triggered via UI"
                  value={runMessage}
                  onChange={(event): void => { setRunMessage(event.target.value); }}
                />
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Run type</legend>
                {/* SAFETY: the value matches the fixture's declared contract. */}
                {// SAFETY: the rendered attribute matches the union the UI derives from the API contract.
(Object.keys(RUN_TYPE_LABELS) as RunType[]).map((type): React.JSX.Element => (
                  <label
                    key={type}
                    className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                      runType === type
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-input hover:bg-background"
                    }`}
                  >
                    <input
                      type="radio"
                      name="run-type"
                      value={type}
                      checked={runType === type}
                      onChange={(): void => { setRunType(type); }}
                      aria-label={RUN_TYPE_LABELS[type]}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium text-foreground">{RUN_TYPE_LABELS[type]}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{RUN_TYPE_DESCRIPTIONS[type]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:border-input hover:bg-background">
                <input
                      type="checkbox"
                      name="run-destroy"
                      checked={runDestroy}
                  onChange={(event): void => { setRunDestroy(event.target.checked); }}
                  disabled={!canStartRun}
                  aria-label="Destroy infrastructure"
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">Destroy infrastructure</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Plan a destroy of all managed resources and apply it. Target and replace addresses still apply.
                    {runDestroy && runType === "plan" && (
                      <span className="mt-0.5 block text-warning">A speculative plan-only destroy will not apply changes.</span>
                    )}
                  </span>
                </span>
              </label>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="run-targets" className="text-sm font-medium">Target addresses</label>
                <Input
                  id="run-targets"
                  name="run-targets"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="aws_instance.web, aws_instance.db"
                  value={runTargets}
                  onChange={(event): void => { setRunTargets(event.target.value); }}
                />
                <p className="text-xs text-muted-foreground">Comma-separated resource addresses to limit this run to.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="run-replace" className="text-sm font-medium">Replace addresses</label>
                <Input
                  id="run-replace"
                  name="run-replace"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="aws_instance.web"
                  value={runReplace}
                  onChange={(event): void => { setRunReplace(event.target.value); }}
                />
                <p className="text-xs text-muted-foreground">Comma-separated resource addresses to force replacement of.</p>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={(): void => { handleDialogOpenChange(false); }}>Cancel</Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Starting…" : "Start run"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>}
    </div>
  );
}
