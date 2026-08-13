import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { formatDate } from "../lib/utils";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { ArrowLeft, CheckCircle2, GitPullRequest, History, XCircle } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type ChangeRequest = Readonly<{
  id: string;
  type: "workspace_change_requests";
  attributes: Readonly<{
    subject: string;
    message: string;
    status: "pending" | "approved" | "discarded" | "archived" | string;
    "archived-by"?: string | null;
    "archived-at"?: string | null;
    "created-at": string;
    "updated-at": string;
    "resolved-by"?: string | null;
    "resolved-at"?: string | null;
    "created-by-username"?: string | null;
    "resolved-by-username"?: string | null;
  }>;
  relationships?: Readonly<{
    workspace?: Readonly<{ data: Readonly<{ id: string }> | null }>;
    creator?: Readonly<{ data: Readonly<{ id: string }> | null }>;
  }>;
}>;

type AuditEntry = Readonly<{
  attributes: Readonly<{
    action: string;
    "resource-type": string;
    "resource-id": string | null;
    details?: Readonly<Record<string, unknown>> | null;
    "created-at": string;
    "actor-username": string | null;
  }>;
}>;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  approved: "secondary",
  discarded: "destructive",
  archived: "outline",
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char): string => char.toUpperCase());
}

export function ChangeRequestDetail(): React.JSX.Element {
  const { orgName: rawOrgName, changeRequestId } = useParams<{ orgName: string; changeRequestId: string }>();
  const orgName = rawOrgName ?? "";
  const navigate = useNavigate();
  const [changeRequest, setChangeRequest] = useState<ChangeRequest | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditAvailable, setAuditAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"discard" | "archive" | null>(null);
  const activeKey = useRef(changeRequestId ?? "");
  activeKey.current = changeRequestId ?? "";

  useEffect((): (() => void) | undefined => {
    setChangeRequest(null);
    setWorkspaceName(null);
    setAuditEntries([]);
    setAuditAvailable(false);
    setError("");
    const id = changeRequestId ?? "";
    if (id === "") return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      try {
        const response = await fetchApi(`/change-requests/${encodeURIComponent(id)}`) as { data?: ChangeRequest };
        const resource = response.data;
        if (cancelled || activeKey.current !== id) return;
        if (resource === undefined) {
          setError("Change request not found.");
          return;
        }
        setChangeRequest(resource);
        const workspaceId = resource.relationships?.workspace?.data?.id;
        if (workspaceId !== undefined && workspaceId !== null) {
          fetchApi(`/workspaces/${encodeURIComponent(workspaceId)}`)
            .then((workspaceResponse): void => {
              if (cancelled || activeKey.current !== id) return;
              const name = (workspaceResponse as { data?: { attributes?: { name?: string } } }).data?.attributes?.name;
              if (name !== undefined && name !== "") setWorkspaceName(name);
            })
            .catch((): void => { /* workspace name is a nicety */ });
        }
        // Audit history is owner-scoped; hide the section when the caller
        // cannot read it instead of failing the page.
        fetchApi(`/organizations/${encodeURIComponent(orgName)}/audit-logs`)
          .then((auditResponse): void => {
            if (cancelled || activeKey.current !== id) return;
            const entries = (auditResponse as { data?: AuditEntry[] }).data ?? [];
            setAuditEntries(entries.filter((entry): boolean =>
              entry.attributes["resource-type"] === "change-requests" && entry.attributes["resource-id"] === id));
            setAuditAvailable(true);
          })
          .catch((): void => { /* no audit-logs:read grant */ });
      } catch (caught: unknown) {
        if (cancelled || activeKey.current !== id) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled && activeKey.current === id) setLoading(false);
      }
    };
    void load();
    return (): void => { cancelled = true; };
  }, [orgName, changeRequestId]);

  const runAction = async (action: "approve" | "discard"): Promise<void> => {
    const id = changeRequestId ?? "";
    setActing(true);
    setConfirmAction(null);
    try {
      const response = await fetchApi(`/change-requests/${encodeURIComponent(id)}/actions/${action}`, {
        method: "POST",
        body: JSON.stringify({ data: { type: "workspace_change_requests" } }),
      }) as { data?: ChangeRequest };
      if (response.data !== undefined) setChangeRequest(response.data);
      toast.add({ title: `Change request ${action === "approve" ? "approved" : "discarded"}`, type: "success" });
    } catch (caught: unknown) {
      toast.add({
        title: `Could not ${action} the change request`,
        description: caught instanceof Error ? caught.message : String(caught),
        type: "error",
      });
    } finally {
      setActing(false);
    }
  };

  const archive = async (): Promise<void> => {
    const id = changeRequestId ?? "";
    setActing(true);
    setConfirmAction(null);
    try {
      const response = await fetchApi(`/workspaces/change-requests/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { type: "workspace_change_requests" } }),
      }) as { data?: ChangeRequest };
      if (response.data !== undefined) setChangeRequest(response.data);
      toast.add({ title: "Change request archived", type: "success" });
    } catch (caught: unknown) {
      toast.add({
        title: "Could not archive the change request",
        description: caught instanceof Error ? caught.message : String(caught),
        type: "error",
      });
    } finally {
      setActing(false);
    }
  };

  const workspaceHref = workspaceName !== null && workspaceName !== ""
    ? `/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`
    : null;

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Change requests`}
        title={(
          <span className="flex items-center gap-2">
            <GitPullRequest className="size-7 text-muted-foreground" aria-hidden="true" />
            {changeRequest?.attributes.subject ?? "Change request"}
          </span>
        )}
        description="Change request details, approval flow, and audit history."
        action={changeRequest !== null ? (
          <Badge variant={STATUS_VARIANT[changeRequest.attributes.status] ?? "secondary"}>
            {statusLabel(changeRequest.attributes.status)}
          </Badge>
        ) : undefined}
      />

      <Button
        variant="ghost"
        size="sm"
        className="mb-2 -ml-2"
        onClick={(): void => { void navigate(`/app/${encodeURIComponent(orgName)}/change-requests`); }}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to change requests
      </Button>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-6" />
        </div>
      ) : error !== "" ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : changeRequest === null ? null : (
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-4 py-5">
              <p className="whitespace-pre-wrap text-sm text-foreground">{changeRequest.attributes.message}</p>
              <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Workspace</dt>
                  <dd>
                    {workspaceHref !== null ? (
                      <Link to={workspaceHref} className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {workspaceName}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Created by</dt>
                  <dd className="text-foreground">
                    {changeRequest.attributes["created-by-username"] !== null
                      && changeRequest.attributes["created-by-username"] !== undefined
                      ? changeRequest.attributes["created-by-username"]
                      : changeRequest.relationships?.creator?.data !== null && changeRequest.relationships?.creator?.data !== undefined
                        ? changeRequest.relationships.creator.data.id
                        : "System"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Created at</dt>
                  <dd className="tabular-nums text-foreground">{formatDate(changeRequest.attributes["created-at"])}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Resolved</dt>
                  <dd className="tabular-nums text-foreground">
                    {changeRequest.attributes["resolved-at"] !== null && changeRequest.attributes["resolved-at"] !== undefined
                      ? formatDate(changeRequest.attributes["resolved-at"])
                      : "—"}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {changeRequest.attributes.status === "pending" && (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 py-4">
                <Button onClick={(): void => { void runAction("approve"); }} disabled={acting}>
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                  Approve
                </Button>
                <Button variant="outline" onClick={(): void => { setConfirmAction("discard"); }} disabled={acting}>
                  <XCircle className="size-4" aria-hidden="true" />
                  Discard
                </Button>
                <Button variant="outline" onClick={(): void => { setConfirmAction("archive"); }} disabled={acting}>
                  Archive
                </Button>
              </CardContent>
            </Card>
          )}

          {auditAvailable && (
            <Card>
              <CardContent className="py-5">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <History className="size-4 text-muted-foreground" aria-hidden="true" />
                  Audit history
                </h2>
                {auditEntries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No audit entries for this change request.</p>
                ) : (
                  <ul className="space-y-2">
                    {auditEntries.map((entry): React.JSX.Element => (
                      <li key={`${entry.attributes["created-at"]}-${entry.attributes.action}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span>
                          <Badge variant="secondary">{entry.attributes.action}</Badge>
                          <span className="ml-2 text-muted-foreground">{entry.attributes["actor-username"] ?? "System"}</span>
                        </span>
                        <time dateTime={entry.attributes["created-at"]} className="tabular-nums text-muted-foreground">
                          {formatDate(entry.attributes["created-at"])}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          <ConfirmDialog
            open={confirmAction !== null}
            title={confirmAction === "discard" ? "Discard change request" : "Archive change request"}
            description={confirmAction === "discard"
              ? "The change request will be marked as discarded. This cannot be undone."
              : "The change request will be marked as archived. This cannot be undone."}
            confirmText={confirmAction === "discard" ? "Discard" : "Archive"}
            onConfirm={(): void => {
              if (confirmAction === "discard") void runAction("discard");
              else if (confirmAction === "archive") void archive();
            }}
            onOpenChange={(open: boolean): void => { if (!open) setConfirmAction(null); }}
          />
        </div>
      )}
    </PageShell>
  );
}
