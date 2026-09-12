import { EmptyState } from "../components/EmptyState";
import { useEffect, useRef, useState } from "react";
import { isNumber, isRecord, isString } from "../lib/type-guards";
import { Link } from "react-router-dom";
import { ApiError, fetchAllApiPages, fetchApi, fetchApiBlob } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { formatRunStatusForUi } from "@/lib/run-labels";
import { safeHttpUrl } from "@/lib/safe-url";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorPanel } from "@/components/ui/error-panel";
import { Spinner } from "@/components/ui/spinner";
import { Download, Eye, RotateCcw, Upload } from "lucide-react";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { toast } from "@/components/ui/toast";
import type { JsonObject } from "@/lib/json";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StateItem = {
  id: string;
  attributes: JsonObject;
  relationships?: {
    run?: { data: { id: string; type: string } | null };
  };
};

function stateStatus(value: unknown): string {
  if (!isString(value) || value === "") return "Saved";
  const labels = {
    pending: "Pending",
    finalized: "Saved",
  };
  const normalized = value.toLowerCase();
  const label = Object.prototype.hasOwnProperty.call(labels, normalized)
    ? labels[normalized as keyof typeof labels]
    : undefined;
  // SAFETY: unknown state values fall through to the title-cased label below.
  return label ?? value.replace(/_/g, " ").replace(/\b\w/g, (c: string): string => c.toUpperCase());
}


type StateHistoryProps = {
  workspaceId: string;
  orgName?: string;
  workspaceName?: string;
  canUpload?: boolean;
  canRollback?: boolean;
}

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string; error: unknown }>
  | Readonly<{
    kind: "ready";
    states: StateItem[];
    refreshError?: Readonly<{ message: string; error: unknown }>;
  }>;

function formatDate(value: unknown): string {
  if (!isString(value) || value === "") return "—";
  const date = new Date(value);
  return formatDateTime(date);
}

function shortStateId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

function stateSerial(value: unknown): string {
  return isNumber(value) ? `#${String(value)}` : "Unknown serial";
}

type PendingStateUpload = {
  fileName: string;
  rawText: string;
  serial: number | null;
  lineage: string | null;
};

function StateVersionCell({ item }: Readonly<{ item: StateItem }>): React.JSX.Element {
  return (
    <TableCell>
      {/* SAFETY: the fixture field matches the API contract type. */}
      <p className="font-bold">{stateSerial(item.attributes["serial"])}</p>
      <p className="font-mono text-xs text-muted-foreground" title={item.id}>{shortStateId(item.id)}</p>
      <p className="mt-1 text-2xs text-muted-foreground" title={isString(item.attributes["lineage"]) ? item.attributes["lineage"] : undefined}>
        Lineage · {stateLineage(item.attributes["lineage"])}
      </p>
      <p className="text-2xs text-muted-foreground">
        Processing · {stateStatus(item.attributes["summary-status"] ?? item.attributes["status"])}
      </p>
    </TableCell>
  );
}

function StateRunCell({ item, orgName, workspaceName }: Readonly<{
  item: StateItem;
  orgName: string | undefined;
  workspaceName: string | undefined;
}>): React.JSX.Element {
  return (
    <TableCell className="font-mono text-xs">
      {item.relationships?.run?.data?.id != null ? (
        <div className="flex flex-col gap-0.5">
          <Link
            to={`/app/${encodeURIComponent(orgName ?? "")}/workspaces/${encodeURIComponent(workspaceName ?? "")}/runs/${encodeURIComponent(item.relationships.run.data.id)}`}
            className="text-primary hover:underline"
          >
            {isString(item.attributes["run-message"]) && item.attributes["run-message"] !== ""
              ? item.attributes["run-message"]
              : "Manual run"}
          </Link>
          <span className="text-2xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Run</span>{" · "}
            <span>{isString(item.attributes["run-status"])
              ? formatRunStatusForUi(item.attributes["run-status"])
              : "Run Status Unknown"}</span>
          </span>
          <span className="text-2xs text-muted-foreground">
            <span className="font-medium text-foreground/70">State</span>{" · "}<span>{stateStatus(item.attributes["status"])}</span>
          </span>
        </div>
      ) : (
        <div className="space-y-0.5">
          <span>—</span>
          <span className="block text-2xs text-muted-foreground">Manual or imported state</span>
        </div>
      )}
    </TableCell>
  );
}

function StateCommitCell({ item }: Readonly<{ item: StateItem }>): React.JSX.Element {
  return (
    <TableCell className="font-mono text-xs">
      {isString(item.attributes["vcs-commit-sha"]) ? (
        isString(item.attributes["vcs-commit-url"]) && safeHttpUrl(item.attributes["vcs-commit-url"]) !== null ? (
          <a
            href={safeHttpUrl(item.attributes["vcs-commit-url"]) ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            {item.attributes["vcs-commit-sha"].slice(0, 8)}
          </a>
        ) : item.attributes["vcs-commit-sha"].slice(0, 8)
      ) : "—"}
    </TableCell>
  );
}

function StateActionsCell({
  item,
  loadingStateId,
  canRollback,
  rollingBack,
  onView,
  onDownload,
  onRollback,
}: Readonly<{
  item: StateItem;
  loadingStateId: string | null;
  canRollback: boolean;
  rollingBack: boolean;
  onView: (item: StateItem) => void;
  onDownload: (item: StateItem) => void;
  onRollback: (item: StateItem) => void;
}>): React.JSX.Element {
  return (
    <TableCell>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={loadingStateId === item.id || item.attributes["state-representation"] === "opentofu-encrypted"}
          onClick={(): void => { onView(item); }}
        >
          <Eye className="size-3.5" aria-hidden="true" />
          {loadingStateId === item.id ? "Loading…" : "View JSON"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title="Download raw state — may contain secrets"
          aria-describedby={`state-download-warning-${item.id}`}
          onClick={(): void => { onDownload(item); }}
        >
          <Download className="size-3.5" aria-hidden="true" />
          Download raw state
        </Button>
        {canRollback && (
          <Button
            variant="outline"
            size="sm"
            disabled={rollingBack || item.attributes["state-representation"] === "opentofu-encrypted"}
            onClick={(): void => { onRollback(item); }}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Rollback as new current
          </Button>
        )}
      </div>
      <span id={`state-download-warning-${item.id}`} className="mt-1 block text-2xs text-muted-foreground">Raw download may contain secrets.</span>
      {item.attributes["state-representation"] === "opentofu-encrypted" && (
        <span className="mt-1 block text-xs text-muted-foreground">Client-encrypted state: structured inspection is unavailable. Download it with its client keys for recovery.</span>
      )}
    </TableCell>
  );
}

function currentStateMarkers(loadState: LoadState): Readonly<{ serial: number | null; lineage: string | null }> {
  const latest = loadState.kind === "ready" && loadState.states.length > 0 ? loadState.states[0] : undefined;
  const rawLineage = latest?.attributes["lineage"];
  return {
    serial: latest !== undefined && isNumber(latest.attributes["serial"]) ? latest.attributes["serial"] : null,
    lineage: isString(rawLineage) && rawLineage !== "" ? rawLineage : null,
  };
}

function uploadStaleness(
  pendingUpload: PendingStateUpload,
  currentSerial: number | null,
  currentLineage: string | null,
): Readonly<{ stale: boolean; mismatch: boolean }> {
  return {
    stale: pendingUpload.serial !== null && currentSerial !== null && pendingUpload.serial <= currentSerial,
    mismatch: pendingUpload.lineage !== null && currentLineage !== null && pendingUpload.lineage !== currentLineage,
  };
}

function isClientRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

function RollbackErrorPanel({ error, workspaceId, onRetry }: Readonly<{
  error: unknown;
  workspaceId: string;
  onRetry: () => void;
}>): React.JSX.Element | null {
  if (error === null) return null;
  return (
    <ErrorPanel
      title={isClientRejection(error) ? "State promotion was rejected" : "State promotion needs reconciliation"}
      message={isClientRejection(error)
        ? `${error.message} No state change was committed.`
        : "The server did not confirm whether promotion committed. Refresh state history before trying again."}
      error={error}
      retryLabel="Refresh state history"
      onRetry={onRetry}
      diagnosticContext={{ screen: "state-history", workspaceId, operation: "rollback" }}
    />
  );
}

function UploadStateButton({ uploading, onSelectFile }: Readonly<{
  uploading: boolean;
  onSelectFile: () => void;
}>): React.JSX.Element {
  return (
    <Button
      variant="outline"
      disabled={uploading}
      onClick={onSelectFile}
    >
      {uploading ? <Spinner className="size-4" /> : <Upload className="size-4" />}
      {uploading ? "Uploading…" : "Upload state"}
    </Button>
  );
}

function uploadDescriptionContent(
  pendingUpload: PendingStateUpload | null,
  loadState: LoadState,
): React.ReactNode {
  if (pendingUpload === null) return null;
  const current = currentStateMarkers(loadState);
  const { stale, mismatch } = uploadStaleness(pendingUpload, current.serial, current.lineage);
  return (
    <span className="block space-y-1">
      <span className="block">File <strong>{pendingUpload.fileName}</strong> becomes the latest state version.</span>
      <span className="block">
        Uploaded serial: {pendingUpload.serial ?? "unknown"} · Lineage: {pendingUpload.lineage ?? "unknown"}
      </span>
      <span className="block">
        Current serial: {current.serial ?? "none"} · Lineage: {current.lineage ?? "unknown"}
      </span>
      {(stale || mismatch) && (
        <span className="block font-medium text-destructive">
          {stale ? "The uploaded serial is not newer than the current one. " : ""}
          {mismatch ? "The lineage does not match the current state — this looks like a different state entirely. " : ""}
          Upload only if you intend to replace history.
        </span>
      )}
    </span>
  );
}

function stateLineage(value: unknown): string {
  return isString(value) && value !== "" ? shortStateId(value) : "Unknown lineage";
}

export function StateHistory({ workspaceId, orgName, workspaceName, canUpload = true, canRollback = false }: StateHistoryProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [loadingStateId, setLoadingStateId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [pendingRollback, setPendingRollback] = useState<StateItem | null>(null);
  const [rollbackError, setRollbackError] = useState<unknown>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    fileName: string;
    rawText: string;
    serial: number | null;
    lineage: string | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoadState((current): LoadState => current.kind === "ready"
      ? { kind: "ready", states: current.states }
      : { kind: "loading" });
    void fetchAllApiPages<StateItem>(`/workspaces/${workspaceId}/state-versions`, controller.signal, { retryAttempts: 0 })
      .then((states: StateItem[]): void => {
        if (!controller.signal.aborted) {
          setRollbackError(null);
          setLoadState({ kind: "ready", states });
        }
      })
      .catch((error: unknown): void => {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : "Failed to load state version history";
          setLoadState((current): LoadState => current.kind === "ready"
            ? { ...current, refreshError: { message, error } }
            : {
              kind: "error",
              message,
              error,
            },
          );
        }
      });
    return (): void => {
      controller.abort();
    };
  }, [retry, workspaceId]);

  const handleViewJson = async (s: StateItem): Promise<void> => {
// SAFETY: the fixture field matches the API contract type.
    const stateStr = s.attributes["state"] as string | undefined;
    if (stateStr != null) {
      try {
        const parsed: unknown = isString(stateStr) ? JSON.parse(stateStr) : stateStr;
        setSelectedState(JSON.stringify(parsed, null, 2));
      } catch {
        setSelectedState(stateStr);
      }
      return;
    }

    setLoadingStateId(s.id);
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const res = await fetchApi(`/state-versions/${s.id}`) as { data?: { attributes?: JsonObject } };
// SAFETY: the fixture field matches the API contract type.
      const rawPayload = (res.data?.attributes?.["state"] as string | undefined) ?? "{}";
      try {
        const parsed: unknown = isString(rawPayload) ? JSON.parse(rawPayload) : rawPayload;
        setSelectedState(JSON.stringify(parsed, null, 2));
      } catch {
        setSelectedState(rawPayload);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load state version JSON";
      toast.add({ title: "Could not load state", description: msg, type: "error" });
    } finally {
      setLoadingStateId(null);
    }
  };

  const handleDownload = async (s: StateItem): Promise<void> => {
    try {
      const blob = await fetchApiBlob(`/state-versions/${s.id}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
// SAFETY: the fixture field matches the API contract type.
      const serial = (s.attributes["serial"] as number | undefined) ?? 1;
      a.download = `terraform-state-v${serial}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.add({ title: "State downloaded", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to download state version";
      toast.add({ title: "Could not download state", description: msg, type: "error" });
    }
  };

  const performRollback = async (): Promise<void> => {
    if (pendingRollback === null) return;
    const selected = pendingRollback;
    setPendingRollback(null);
    setRollbackError(null);
    setRollingBack(true);
    try {
      const response = await fetchApi(`/state-versions/${encodeURIComponent(selected.id)}/actions/rollback`, {
        method: "POST",
      }) as { data?: StateItem };
      const promoted = response.data;
      if (promoted !== undefined) {
        setLoadState((current): LoadState => current.kind === "ready"
          ? { kind: "ready", states: [promoted, ...current.states] }
          : current);
      } else {
        setRetry((value): number => value + 1);
      }
      toast.add({
        title: "State version promoted",
        description: "The older state is now the current state as a new version. Cloud resources change only after the next plan and apply.",
        type: "success",
      });
    } catch (error: unknown) {
      setRollbackError(error);
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      toast.add({
        title: rejected ? "State promotion was rejected" : "State promotion needs reconciliation",
        description: rejected
          ? `${error instanceof Error ? error.message : "The state version could not be promoted."} No state change was committed.`
          : "The server did not confirm whether promotion committed. Refresh state history before trying again.",
        type: "error",
      });
    } finally {
      setRollingBack(false);
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    let rawState: string;
    try {
      rawState = await file.text();
    } catch (error: unknown) {
      const message = error instanceof Error && error.message !== "" ? error.message : "The file could not be read.";
      toast.add({ title: "Could not read state file", description: message, type: "error" });
      return;
    }
    let serial: number | null = null;
    let lineage: string | null = null;
    try {
      const parsed: unknown = JSON.parse(rawState);
      if (isRecord(parsed)) {
        if (isNumber(parsed["serial"])) serial = parsed["serial"];
        if (isString(parsed["lineage"]) && parsed["lineage"] !== "") lineage = parsed["lineage"];
      }
    } catch {
      // Unparseable files still confirm, with unknown serial/lineage shown.
    }
    setPendingUpload({ fileName: file.name, rawText: rawState, serial, lineage });
  };

  const performUpload = async (): Promise<void> => {
    if (pendingUpload === null) return;
    setPendingUpload(null);
    setUploading(true);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(`/workspaces/${workspaceId}/state-versions/upload`, {
        method: "POST",
        body: pendingUpload.rawText,
      }) as { data?: StateItem };
      const uploadedState = response.data;
      if (uploadedState !== undefined) {
        setLoadState((current): LoadState => current.kind === "ready"
          ? { kind: "ready", states: [uploadedState, ...current.states] }
          : current);
      }
      toast.add({ title: "State uploaded", description: "The imported state is now the latest state version.", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to upload Terraform state";
      toast.add({ title: "Could not upload state", description: msg, type: "error" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">State version history</h2>
          <p className="mt-1 text-sm text-muted-foreground">Inspect historical state and its source run. Raw downloads may contain secrets. Download raw state only when you need a recoverable copy. Promoting a version creates a new current version; it does not rewind cloud resources.</p>
          <p className="mt-1 text-xs text-muted-foreground">Client-encrypted OpenTofu state cannot be inspected as structured state; keep its client keys with any recovery copy.</p>
        </div>
        {canUpload && (
          <>
            <input
              ref={fileInputRef}
              name="state-upload"
              className="hidden"
              type="file"
              accept=".tfstate,.json,application/json"
              aria-label="Upload Terraform/OpenTofu state"
              onChange={(event): void => { void handleUpload(event); }}
            />
            <UploadStateButton
              uploading={uploading}
              onSelectFile={(): void => { fileInputRef.current?.click(); }}
            />
          </>
        )}
      </div>

      <RollbackErrorPanel
        error={rollbackError}
        workspaceId={workspaceId}
        onRetry={(): void => { setRetry((value: number): number => value + 1); }}
      />

      <div className="border rounded-md">
        {loadState.kind === "ready" && loadState.refreshError !== undefined && (
          <ErrorPanel
            title="Could not refresh state version history"
            message={loadState.refreshError.message}
            error={loadState.refreshError.error}
            retryLabel="Try again"
            onRetry={(): void => { setRetry((value: number): number => value + 1); }}
            diagnosticContext={{ screen: "state-history", workspaceId, operation: "refresh" }}
            className="m-3"
          />
        )}
        <Table density="dense">
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Run</TableHead>
              <TableHead>Commit</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadState.kind === "loading" && (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <TableSkeleton rows={4} cols={5} label="Loading state versions" />
                </TableCell>
              </TableRow>
            )}
            {loadState.kind === "error" && (
              <TableRow>
                <TableCell colSpan={5} className="py-8">
                  <ErrorPanel
                    title="Could not load state version history"
                    message={loadState.message}
                    error={loadState.error}
                    retryLabel="Try again"
                    onRetry={(): void => { setRetry((value: number): number => value + 1); }}
                    diagnosticContext={{ screen: "state-history", workspaceId }}
                    className="mx-auto max-w-xl"
                  />
                </TableCell>
              </TableRow>
            )}
            {loadState.kind === "ready" && loadState.states.map((s: StateItem): React.JSX.Element => (
              <TableRow key={s.id}>
                <StateVersionCell item={s} />
                <TableCell className="text-sm">{formatDate(s.attributes["created-at"])}</TableCell>
                <StateRunCell item={s} orgName={orgName} workspaceName={workspaceName} />
                <StateCommitCell item={s} />
                <StateActionsCell
                  item={s}
                  loadingStateId={loadingStateId}
                  canRollback={canRollback}
                  rollingBack={rollingBack}
                  onView={handleViewJson}
                  onDownload={handleDownload}
                  onRollback={setPendingRollback}
                />
              </TableRow>
            ))}
            {loadState.kind === "ready" && loadState.states.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  <EmptyState compact title="No state versions recorded yet." description="State versions appear after an apply or a state upload." docsHref="/app/docs/state" />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={selectedState != null} onOpenChange={(): void => { setSelectedState(null); }}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>State Payload JSON</DialogTitle>
          </DialogHeader>
          <pre className="bg-code-background text-code-foreground p-4 rounded-md text-xs font-mono overflow-x-auto whitespace-pre-wrap">
            {selectedState}
          </pre>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingUpload !== null}
        onOpenChange={(open): void => { if (!open) setPendingUpload(null); }}
        title="Upload state version?"
        description={uploadDescriptionContent(pendingUpload, loadState)}
        confirmText="Upload state"
        confirmVariant="destructive"
        onConfirm={(): void => { void performUpload(); }}
      />
      <ConfirmDialog
        open={pendingRollback !== null}
        onOpenChange={(open): void => { if (!open) setPendingRollback(null); }}
        title="Rollback this state as a new current version?"
        description={((): React.ReactNode => {
          if (pendingRollback === null) return null;
          const runId = pendingRollback.relationships?.run?.data?.id;
          return (
            <span className="block space-y-1">
              <span className="block">Source version <strong>{stateSerial(pendingRollback.attributes["serial"])}</strong> · {shortStateId(pendingRollback.id)}</span>
              <span className="block">Lineage: {stateLineage(pendingRollback.attributes["lineage"])} · Processing: {stateStatus(pendingRollback.attributes["summary-status"] ?? pendingRollback.attributes["status"])}</span>
              <span className="block">Created: {formatDate(pendingRollback.attributes["created-at"])} · Source run: {runId ?? "manual or imported"}</span>
              <span className="mt-2 block font-medium text-foreground">This creates a new current state version with a new serial. It does not change cloud resources; review the next plan before applying.</span>
              <span className="block">Promotion requires this workspace to be locked by you. Lock it from Workspace settings before confirming.</span>
            </span>
          );
        })()}
        requireCheckbox="I understand that promotion changes the current state record and the next plan may propose infrastructure changes."
        confirmText="Rollback as new current"
        confirmVariant="destructive"
        loading={rollingBack}
        onConfirm={(): void => { void performRollback(); }}
      />
    </div>
  );
}
