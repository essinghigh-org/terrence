import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { formatDate } from "../lib/utils";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, Clock3, GitPullRequest, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type CalendarEntry = {
  id: string;
  type: "change-calendar-entry";
  attributes: {
    kind: "apply" | "change-request" | "auto-destroy";
    at: string;
    scheduled?: boolean;
    "scheduled-at"?: string | null;
    runId?: string;
    changeRequestId?: string;
    workspaceId: string;
    workspaceName: string | null;
    subject?: string | null;
  };
};

type CalendarPage = Readonly<{
  data: CalendarEntry[];
  meta?: {
    pagination?: {
      "current-page"?: number;
      "next-page"?: number | null;
      "prev-page"?: number | null;
      "total-pages"?: number;
      "total-count"?: number;
    };
  };
}>;

const KIND_LABEL: Record<CalendarEntry["attributes"]["kind"], string> = {
  apply: "Confirmed apply",
  "change-request": "Change request",
  "auto-destroy": "Auto-destroy",
};

const KIND_ICON: Record<CalendarEntry["attributes"]["kind"], typeof CheckCircle2> = {
  apply: CheckCircle2,
  "change-request": GitPullRequest,
  "auto-destroy": Trash2,
};

const KIND_VARIANT: Record<CalendarEntry["attributes"]["kind"], "default" | "secondary" | "destructive"> = {
  apply: "default",
  "change-request": "secondary",
  "auto-destroy": "destructive",
};

function occurrenceLabel(entry: CalendarEntry): string {
  const { attributes } = entry;
  if (attributes.kind === "change-request") {
    return attributes.subject !== null && attributes.subject !== undefined && attributes.subject !== ""
      ? attributes.subject
      : "Change request";
  }
  // True future-scheduled applies are distinct from historical confirmation
  // activity (scheduled_at semantics, 21.4).
  if (attributes.kind === "apply" && attributes.scheduled === true) return "Scheduled apply";
  return KIND_LABEL[attributes.kind];
}

export function ChangeCalendar(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  // Monotonic request sequence: only the latest response may write state,
  // so a slow pager response cannot clobber a newer org/page fetch.
  const loadSequence = useRef(0);

  useEffect((): (() => void) | undefined => {
    setEntries([]);
    setTotalCount(0);
    setCurrentPage(1);
    setTotalPages(0);
    setError("");
    if (orgName === "") return;
    let cancelled = false;
    const loadCalendar = async (): Promise<void> => {
      setLoading(true);
      try {
        const response = await fetchApi(
          `/organizations/${encodeURIComponent(orgName)}/change-calendar?page%5Bsize%5D=20`,
        ) as CalendarPage;
        if (cancelled || activeOrganizationName.current !== orgName) return;
        setEntries(response.data);
        setTotalCount(response.meta?.pagination?.["total-count"] ?? response.data.length);
        setCurrentPage(response.meta?.pagination?.["current-page"] ?? 1);
        setTotalPages(response.meta?.pagination?.["total-pages"] ?? Math.ceil(response.data.length / 20));
      } catch (caught: unknown) {
        if (cancelled || activeOrganizationName.current !== orgName) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled && activeOrganizationName.current === orgName) setLoading(false);
      }
    };
    void loadCalendar();
    return (): void => { cancelled = true; };
  }, [orgName]);

  const loadPage = async (page: number): Promise<void> => {
    if (page < 1 || page > totalPages) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(orgName)}/change-calendar?page%5Bsize%5D=20&page%5Bnumber%5D=${page}`,
      ) as CalendarPage;
      // A slow pager response must not write state after the organization
      // changed or a newer request superseded it.
      if (sequence !== loadSequence.current || activeOrganizationName.current !== orgName) return;
      setEntries(response.data);
      setTotalCount(response.meta?.pagination?.["total-count"] ?? response.data.length);
      setCurrentPage(response.meta?.pagination?.["current-page"] ?? page);
      setTotalPages(response.meta?.pagination?.["total-pages"] ?? totalPages);
    } catch (caught: unknown) {
      if (sequence !== loadSequence.current || activeOrganizationName.current !== orgName) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (sequence === loadSequence.current && activeOrganizationName.current === orgName) setLoading(false);
    }
  };

  // Workspace routes are name-based (matching TFE): links resolve through
  // attributes.workspaceName, never the internal id. The run link is only
  // rendered when the workspace name is available so it can never dangle.
  const workspaceUrl = (workspaceName: string): string =>
    `/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`;

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Change calendar`}
        title={(
          <span className="flex items-center gap-2">
            <CalendarClock className="size-7 text-muted-foreground" aria-hidden="true" />
            Change calendar
          </span>
        )}
        description="Confirmed applies, pending change requests, and scheduled auto-destroys."
        action={!loading && error === "" ? (
          <Badge variant="secondary">{totalCount} upcoming</Badge>
        ) : undefined}
      />

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-6" />
        </div>
      ) : error !== "" ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Clock3 className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-sm text-muted-foreground">No scheduled changes in this organization.</p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry): React.JSX.Element => {
            const ICON_COMPONENT = KIND_ICON[entry.attributes.kind];
            return (
              <li key={entry.id}>
                <Card>
                  <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <ICON_COMPONENT className="mt-0.5 size-5 text-muted-foreground" aria-hidden="true" />
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{occurrenceLabel(entry)}</span>
                          <Badge variant={KIND_VARIANT[entry.attributes.kind]}>
                            {entry.attributes.kind === "apply" && entry.attributes.scheduled === true
                              ? "Scheduled"
                              : KIND_LABEL[entry.attributes.kind]}
                          </Badge>
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {entry.attributes.workspaceName !== null ? (
                            <Link
                              to={workspaceUrl(entry.attributes.workspaceName)}
                              className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                              {entry.attributes.workspaceName}
                            </Link>
                          ) : (
                            "Workspace"
                          )}
                          {entry.attributes.runId !== undefined && entry.attributes.workspaceName !== null && (
                            <span>
                              {" · "}
                              <Link
                                to={`${workspaceUrl(entry.attributes.workspaceName)}/runs/${encodeURIComponent(entry.attributes.runId)}`}
                                className="rounded-sm font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                              >
                                {entry.attributes.runId.slice(0, 8)}
                              </Link>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <time
                      dateTime={entry.attributes.at}
                      className="shrink-0 text-sm tabular-nums text-muted-foreground"
                    >
                      {formatDate(entry.attributes.at)}
                    </time>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {!loading && error === "" && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages} · {totalCount} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onClick={(): void => { void loadPage(currentPage - 1); }}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={(): void => { void loadPage(currentPage + 1); }}
            >
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}
