import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { formatDate } from "../lib/utils";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { StatusBadge } from "../components/ui/status-badge";
import { ChevronLeft, ChevronRight, GitPullRequest, Inbox } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type ChangeRequest = Readonly<{
  id: string;
  type: "workspace_change_requests";
  attributes: Readonly<{
    subject: string;
    message: string;
    status: "pending" | "approved" | "discarded" | "archived" | string;
    "created-at": string;
    "updated-at": string;
    "workspace-name"?: string | null;
    "created-by-username"?: string | null;
    "resolved-by-username"?: string | null;
    "resolved-at"?: string | null;
  }>;
  relationships?: Readonly<{
    workspace?: Readonly<{ data: Readonly<{ id: string }> | null }>;
  }>;
}>;

const STATUS_TABS: readonly (readonly [string, string])[] = [
  ["", "All"],
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["discarded", "Discarded"],
  ["archived", "Archived"],
];

export function ChangeRequests(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [entries, setEntries] = useState<ChangeRequest[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
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

  const loadInbox = useCallback(async (page: number, status: string, signal?: Readonly<AbortSignal>): Promise<void> => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    const statusQuery = status === "" ? "" : `&filter%5Bstatus%5D=${encodeURIComponent(status)}`;
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(orgName)}/change-requests?page%5Bsize%5D=20&page%5Bnumber%5D=${page}${statusQuery}`,
        signal === undefined ? {} : { signal },
      ) as {
        data: ChangeRequest[];
        meta?: { pagination?: { "current-page"?: number; "next-page"?: number | null; "prev-page"?: number | null; "total-pages"?: number; "total-count"?: number } };
      };
      if (signal?.aborted === true) return;
      if (sequence !== loadSequence.current || activeOrganizationName.current !== orgName) return;
      setEntries(response.data);
      setTotalCount(response.meta?.pagination?.["total-count"] ?? response.data.length);
      setCurrentPage(response.meta?.pagination?.["current-page"] ?? page);
      setTotalPages(response.meta?.pagination?.["total-pages"] ?? Math.ceil(response.data.length / 20));
    } catch (caught: unknown) {
      if (signal?.aborted === true) return;
      if (sequence !== loadSequence.current || activeOrganizationName.current !== orgName) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (signal?.aborted !== true && sequence === loadSequence.current && activeOrganizationName.current === orgName) setLoading(false);
    }
  }, [orgName]);

  useEffect((): (() => void) | undefined => {
    const controller = new AbortController();
    setEntries([]);
    setTotalCount(0);
    setCurrentPage(1);
    setTotalPages(0);
    if (orgName === "") {
      setLoading(false);
      return;
    }
    void loadInbox(1, statusFilter, controller.signal);
    return (): void => { controller.abort(); };
  }, [orgName, statusFilter, loadInbox]);

  const switchTab = (status: string): void => {
    setStatusFilter(status);
    setCurrentPage(1);
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Change requests`}
        title={(
          <span className="flex items-center gap-2">
            <GitPullRequest className="size-7 text-muted-foreground" aria-hidden="true" />
            Change requests
          </span>
        )}
        description="Review and act on change requests across the organization."
        action={!loading && error === "" ? (
          <Badge variant="secondary">{totalCount} total</Badge>
        ) : undefined}
      />

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map(([value, label]): React.JSX.Element => (
          <Button
            key={value}
            variant={statusFilter === value ? "default" : "outline"}
            size="sm"
            onClick={(): void => { switchTab(value); }}
          >
            {label}
          </Button>
        ))}
      </div>

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
            <Inbox className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-sm text-muted-foreground">
              {statusFilter === "" ? "No change requests in this organization." : `No ${statusFilter} change requests.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry): React.JSX.Element => (
            <li key={entry.id}>
              <Link
                to={`/app/${encodeURIComponent(orgName)}/change-requests/${encodeURIComponent(entry.id)}`}
                className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Card className="transition-colors hover:bg-accent/40">
                  <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{entry.attributes.subject}</span>
                        <StatusBadge status={entry.attributes.status} />
                      </div>
                      <div className="mt-1 truncate text-sm text-muted-foreground">
                        {entry.attributes["workspace-name"] !== null && entry.attributes["workspace-name"] !== undefined ? (
                          <span className="font-medium text-foreground">{entry.attributes["workspace-name"]}</span>
                        ) : (
                          "Workspace"
                        )}
                        {entry.attributes["created-by-username"] !== null && entry.attributes["created-by-username"] !== undefined && (
                          <span> · {entry.attributes["created-by-username"]}</span>
                        )}
                      </div>
                    </div>
                    <time
                      dateTime={entry.attributes["created-at"]}
                      className="shrink-0 text-sm tabular-nums text-muted-foreground"
                    >
                      {formatDate(entry.attributes["created-at"])}
                    </time>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
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
              onClick={(): void => { void loadInbox(currentPage - 1, statusFilter); }}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={(): void => { void loadInbox(currentPage + 1, statusFilter); }}
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