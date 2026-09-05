import { EmptyState } from "../components/EmptyState";
import { useEffect, useRef, useState } from "react";
import { isNumber, isRecord, isString } from "../lib/type-guards";
import { Link } from "react-router-dom";
import { fetchAllApiPages, fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { formatRunStatusForUi } from "@/lib/run-labels";
import { safeHttpUrl } from "@/lib/safe-url";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Upload } from "lucide-react";
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
}

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; states: StateItem[] }>;

function formatDate(value: unknown): string {
  if (!isString(value) || value === "") return "—";
  const date = new Date(value);
  return formatDateTime(date);
}

function shortStateId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

export function StateHistory({ workspaceId, orgName, workspaceName, canUpload = true }: StateHistoryProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [loadingStateId, setLoadingStateId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{
    fileName: string;
    rawText: string;
    serial: number | null;
    lineage: string | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoadState({ kind: "loading" });
    void fetchAllApiPages<StateItem>(`/workspaces/${workspaceId}/state-versions`, controller.signal)
      .then((states: StateItem[]): void => {
        if (!controller.signal.aborted) setLoadState({ kind: "ready", states });
      })
      .catch((error: unknown): void => {
        if (!controller.signal.aborted) {
          setLoadState({
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to load state version history",
          });
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
      const rawText: unknown = await fetchApi(`/state-versions/${s.id}/download`);
      const payloadString = isString(rawText) ? rawText : JSON.stringify(rawText, null, 2);
      const blob = new Blob([payloadString], { type: "application/json" });
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
          <p className="mt-1 text-sm text-muted-foreground">Browse historical state, inspect the run that produced it, and download a safe copy for recovery.</p>
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
            <Button
              variant="outline"
              disabled={uploading}
              onClick={(): void => { fileInputRef.current?.click(); }}
            >
              {uploading ? <Spinner className="size-4" /> : <Upload className="size-4" />}
              {uploading ? "Uploading…" : "Upload state"}
            </Button>
          </>
        )}
      </div>

      <div className="border rounded-md">
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
                <TableCell colSpan={5} className="py-8">
                  <div role="status" className="flex items-center justify-center gap-2 text-muted-foreground">
                    <Spinner />
                    Loading state versions…
                  </div>
                </TableCell>
              </TableRow>
            )}
            {loadState.kind === "error" && (
              <TableRow>
                <TableCell colSpan={5} className="py-8">
                  <div role="alert" className="mx-auto max-w-md text-center">
                    <p className="font-medium text-destructive">Could not load state version history</p>
                    <p className="mt-1 text-sm text-muted-foreground">{loadState.message}</p>
                    <Button
                      className="mt-3"
                      variant="outline"
                      onClick={(): void => { setRetry((value: number): number => value + 1); }}
                    >
                      Try again
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {loadState.kind === "ready" && loadState.states.map((s: StateItem): React.JSX.Element => (
              <TableRow key={s.id}>
                <TableCell>
                  {/* SAFETY: the fixture field matches the API contract type. */}
                  <p className="font-bold">#{// SAFETY: the rendered attribute matches the union the UI derives from the API contract.
s.attributes["serial"] as number}</p>
                  <p className="font-mono text-xs text-muted-foreground" title={s.id}>{shortStateId(s.id)}</p>
                </TableCell>
                <TableCell className="text-sm">{formatDate(s.attributes["created-at"])}</TableCell>
                <TableCell className="font-mono text-xs">
                  {s.relationships?.run?.data?.id != null ? (
                    <div className="flex flex-col gap-0.5">
                      <Link
                        to={`/app/${encodeURIComponent(orgName ?? "")}/workspaces/${encodeURIComponent(workspaceName ?? "")}/runs/${encodeURIComponent(s.relationships.run.data.id)}`}
                        className="text-primary hover:underline"
                      >
                        {isString(s.attributes["run-message"]) && s.attributes["run-message"] !== ""
                          ? s.attributes["run-message"]
                          : "Manual run"}
                      </Link>
                      <span className="text-2xs text-muted-foreground">
                        <span className="font-medium text-foreground/70">Run</span>{" · "}
                        <span>{isString(s.attributes["run-status"])
                          ? formatRunStatusForUi(s.attributes["run-status"])
                          : "Run Status Unknown"}</span>
                      </span>
                      <span className="text-2xs text-muted-foreground">
                        <span className="font-medium text-foreground/70">State</span>{" · "}<span>{stateStatus(s.attributes["status"])}</span>
                      </span>
                    </div>
                  ) : "—"}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {isString(s.attributes["vcs-commit-sha"]) ? (
                    isString(s.attributes["vcs-commit-url"]) && safeHttpUrl(s.attributes["vcs-commit-url"]) !== null ? (
                      <a
                        href={safeHttpUrl(s.attributes["vcs-commit-url"]) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {s.attributes["vcs-commit-sha"].slice(0, 8)}
                      </a>
                    ) : s.attributes["vcs-commit-sha"].slice(0, 8)
                  ) : "—"}
                </TableCell>
                <TableCell className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingStateId === s.id}
                    onClick={(): void => { void handleViewJson(s); }}
                  >
                    {loadingStateId === s.id ? "Loading…" : "View JSON"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={(): void => { void handleDownload(s); }}>
                    Download state
                  </Button>
                </TableCell>
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
        description={((): React.ReactNode => {
          if (pendingUpload === null) return null;
          const latest = loadState.kind === "ready" && loadState.states.length > 0 ? loadState.states[0] : undefined;
          const currentSerial = latest !== undefined && isNumber(latest.attributes["serial"]) ? latest.attributes["serial"] : null;
          const currentLineage = isString(latest?.attributes["lineage"]) && latest.attributes["lineage"] !== ""
            ? latest.attributes["lineage"]
            : null;
          const stale = pendingUpload.serial !== null && currentSerial !== null && pendingUpload.serial <= currentSerial;
          const mismatch = pendingUpload.lineage !== null && currentLineage !== null && pendingUpload.lineage !== currentLineage;
          return (
            <span className="block space-y-1">
              <span className="block">File <strong>{pendingUpload.fileName}</strong> becomes the latest state version.</span>
              <span className="block">
                Uploaded serial: {pendingUpload.serial ?? "unknown"} · Lineage: {pendingUpload.lineage ?? "unknown"}
              </span>
              <span className="block">
                Current serial: {currentSerial ?? "none"} · Lineage: {currentLineage ?? "unknown"}
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
        })()}
        confirmText="Upload state"
        confirmVariant="destructive"
        onConfirm={(): void => { void performUpload(); }}
      />
    </div>
  );
}
