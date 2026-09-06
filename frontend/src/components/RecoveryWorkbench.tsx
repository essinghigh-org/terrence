import { AlertTriangle, CheckCircle2, Circle, Download, FileWarning, Play, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ApiError, fetchApi, fetchApiBlob } from "../lib/api";
import { isNumber, isRecord, isString } from "../lib/type-guards";
import { toast } from "./ui/toast";

type ReviewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; review: Record<string, unknown> }>
  | Readonly<{ kind: "error"; message: string }>;

type RecoveryWorkbenchProps = Readonly<{
  runId: string;
  formatSupported?: boolean;
  onRecoveryComplete?: () => void;
  onFreshPlan?: () => void;
}>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown, fallback = "—"): string {
  return isString(value) && value !== "" ? value : fallback;
}

function numberValue(value: unknown, fallback = "—"): string {
  return isNumber(value) && Number.isSafeInteger(value) ? String(value) : fallback;
}

function statusVariant(status: string): "success" | "warning" | "destructive" | "outline" {
  if (status === "pass") return "success";
  if (status === "blocked" || status === "unknown") return "warning";
  if (status === "fail") return "destructive";
  return "outline";
}

function CheckIcon({ status }: Readonly<{ status: string }>): React.JSX.Element {
  if (status === "pass") return <CheckCircle2 className="size-4 text-success" aria-hidden="true" />;
  if (status === "fail") return <XCircle className="size-4 text-destructive" aria-hidden="true" />;
  if (status === "blocked") return <AlertTriangle className="size-4 text-warning" aria-hidden="true" />;
  return <Circle className="size-4 text-muted-foreground" aria-hidden="true" />;
}

function downloadBlob(blob: Blob, runId: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `recovery-${runId}.tfstate.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function RecoveryWorkbench({ runId, formatSupported = true, onRecoveryComplete, onFreshPlan }: RecoveryWorkbenchProps): React.JSX.Element {
  const [reviewState, setReviewState] = useState<ReviewState>({ kind: "loading" });
  const [pendingAction, setPendingAction] = useState<"download" | "promote" | "plan" | null>(null);
  const [actionError, setActionError] = useState("");
  const [promotionComplete, setPromotionComplete] = useState(false);

  const loadReview = (): (() => void) => {
    const controller = new AbortController();
    setReviewState({ kind: "loading" });
    fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/recovery`, { signal: controller.signal })
      .then((payload: unknown): void => {
        if (controller.signal.aborted) return;
        const envelope = recordValue(payload);
        const data = recordValue(envelope?.["data"]);
        const attributes = recordValue(data?.["attributes"]);
        if (attributes === null) {
          setReviewState({ kind: "error", message: "The recovery review response was incomplete." });
          return;
        }
        setReviewState({ kind: "ready", review: attributes });
        const promotion = recordValue(attributes["promotion"]);
        if (promotion?.["already-promoted"] === true) setPromotionComplete(true);
      })
      .catch((error: unknown): void => {
        if (!controller.signal.aborted) setReviewState({ kind: "error", message: error instanceof Error ? error.message : "Could not load the recovery review." });
      });
    return (): void => { controller.abort(); };
  };

  useEffect((): (() => void) => loadReview(), [runId]);

  const review = reviewState.kind === "ready" ? reviewState.review : null;
  const capture = recordValue(review?.["capture"]);
  const candidate = recordValue(review?.["candidate-state"]);
  const committed = recordValue(review?.["last-committed-state"]);
  const promotion = recordValue(review?.["promotion"]);
  const checks = useMemo((): readonly Record<string, unknown>[] => {
    const values = review?.["checks"];
    if (!Array.isArray(values)) return [];
    return values.map(recordValue).filter((value): value is Record<string, unknown> => value !== null);
  }, [review]);
  const blockers = useMemo((): readonly string[] => {
    const values = promotion?.["blockers"];
    if (!Array.isArray(values)) return [];
    return values.filter(isString);
  }, [promotion]);
  const alreadyPromoted = promotion?.["already-promoted"] === true || promotionComplete;
  const serverAllowsPromotion = promotion?.["allowed"] === true || alreadyPromoted;
  const formatBlocked = !formatSupported || capture?.["status"] === "opaque";
  const reviewLoading = reviewState.kind === "loading";
  const canPromote = !reviewLoading && serverAllowsPromotion && !formatBlocked;

  async function downloadRecoveryState(): Promise<void> {
    setPendingAction("download");
    setActionError("");
    try {
      downloadBlob(await fetchApiBlob(`/api/v2/runs/${encodeURIComponent(runId)}/recovery-state`), runId);
      toast.add({ title: "Recovery backup downloaded", type: "success" });
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "Could not download the recovery copy.");
    } finally {
      setPendingAction(null);
    }
  }

  async function promoteRecoveryState(): Promise<void> {
    if (!canPromote) return;
    setPendingAction("promote");
    setActionError("");
    try {
      const result = await fetchApi<{ meta?: { idempotent?: unknown } }>(`/api/v2/runs/${encodeURIComponent(runId)}/actions/recover-state`, { method: "POST" });
      const idempotent = result.meta?.idempotent === true;
      setPromotionComplete(true);
      toast.add({ title: idempotent ? "Recovery was already promoted" : "Recovery state promoted", type: "success" });
      onRecoveryComplete?.();
      loadReview();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setActionError(/lock/i.test(error.message)
          ? "The workspace must be locked by you before recovering state. Lock it on the workspace page, then try again."
          : error.message !== "" ? error.message : "Recovery is blocked by a current state, lock, or active owner.");
      } else {
        setActionError(error instanceof Error ? error.message : "Could not promote the recovery copy.");
      }
    } finally {
      setPendingAction(null);
    }
  }

  function startFreshPlan(): void {
    if (onFreshPlan === undefined) return;
    setPendingAction("plan");
    onFreshPlan();
    setPendingAction(null);
  }

  const statusText = stringValue(capture?.["status"], reviewLoading ? "Reviewing" : "Unavailable");
  const reviewError = reviewState.kind === "error" ? reviewState.message : "";

  return (
    <Callout
      tone={alreadyPromoted ? "success" : "warning"}
      aria-label="Interrupted-apply recovery"
      title="Recovery state available"
      className="mb-5"
      actions={(
        <>
          <Button type="button" variant="outline" size="sm" disabled={pendingAction !== null} onClick={(): void => { void downloadRecoveryState(); }}>
            <Download aria-hidden="true" />
            {pendingAction === "download" ? "Working…" : "Download recovery state"}
          </Button>
          <Button type="button" size="sm" disabled={pendingAction !== null || !canPromote} onClick={(): void => { void promoteRecoveryState(); }}>
            {pendingAction === "promote" ? "Working…" : alreadyPromoted ? "Recover again (idempotent)" : "Recover into new state version"}
          </Button>
          {alreadyPromoted && onFreshPlan !== undefined && (
            <Button type="button" variant="outline" size="sm" disabled={pendingAction !== null} onClick={startFreshPlan}>
              <Play aria-hidden="true" />
              {pendingAction === "plan" ? "Starting…" : "Start fresh plan"}
            </Button>
          )}
        </>
      )}
    >
      <p>
        This run was interrupted during apply. Review the captured state and its evidence before promoting it.
        Promotion records a new state version; it does not undo changes already made in the cloud.
      </p>
      <p className="mt-2 text-xs">
        Raw state and log excerpts can contain secrets. Download a backup only to an approved secure location.
        The capture and promotion record remain available under the configured recovery retention policy.
      </p>
      {reviewError !== "" && (
        <p role="alert" className="mt-2 text-xs font-medium text-destructive">{reviewError}</p>
      )}
      {actionError !== "" && (
        <p role="alert" className="mt-2 text-xs font-medium text-destructive">{actionError}</p>
      )}
      {formatBlocked && (
        <p className="mt-2 text-xs">Client-encrypted state requires its original keys and cannot be promoted.</p>
      )}
      {reviewState.kind === "ready" && (
        <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence review</span>
            <Badge variant={alreadyPromoted ? "success" : serverAllowsPromotion && !formatBlocked ? "success" : "warning"}>{alreadyPromoted ? "Promoted" : serverAllowsPromotion && !formatBlocked ? "Ready" : "Blocked"}</Badge>
            <span className="text-xs text-muted-foreground">Capture: {statusText}</span>
          </div>

          <div className="overflow-x-auto rounded-md border border-border/70">
            <Table density="dense">
              <TableHeader>
                <TableRow><TableHead>State evidence</TableHead><TableHead>Candidate</TableHead><TableHead>Last committed</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {[
                  ["Serial", numberValue(candidate?.["serial"]), numberValue(committed?.["serial"])],
                  ["Lineage", stringValue(candidate?.["lineage"]), stringValue(committed?.["lineage"])],
                  ["SHA-256", stringValue(candidate?.["digest"]), stringValue(committed?.["digest"])],
                  ["Bytes", numberValue(candidate?.["size"]), numberValue(committed?.["size"])],
                  ["Terraform version", stringValue(candidate?.["terraformVersion"]), stringValue(committed?.["terraformVersion"])],
                ].map(([label, candidateValue, committedValue]): React.JSX.Element => (
                  <TableRow key={label}>
                    <TableCell className="font-medium">{label}</TableCell>
                    <TableCell className="max-w-[280px] break-all font-mono text-xs">{candidateValue}</TableCell>
                    <TableCell className="max-w-[280px] break-all font-mono text-xs">{committedValue}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {checks.map((check): React.JSX.Element => {
              const checkStatus = stringValue(check["status"], "unknown");
              return (
                <div key={stringValue(check["id"])} className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                  <CheckIcon status={checkStatus} />
                  <span className="min-w-0 flex-1"><span className="font-medium">{stringValue(check["id"], "Check")}</span><span className="ml-1 text-muted-foreground">{stringValue(check["detail"])}</span></span>
                  <Badge variant={statusVariant(checkStatus)}>{checkStatus}</Badge>
                </div>
              );
            })}
          </div>

          {blockers.length > 0 && (
            <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
              <p className="font-medium text-warning-text">Promotion preconditions</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{blockers.map((blocker): React.JSX.Element => <li key={blocker}>{blocker}</li>)}</ul>
            </div>
          )}

          <details>
            <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
              <FileWarning className="size-3.5" aria-hidden="true" /> Execution owner and relevant logs
            </summary>
            <div className="mt-2 space-y-2 text-xs">
              {recordValue(review?.["execution-owner"])?.["terminated"] !== true && <p className="text-warning-text">An active run or agent owner still holds this recovery attempt.</p>}
              {Array.isArray(review?.["relevant-logs"]) && review["relevant-logs"].map((entry): React.JSX.Element | null => {
                const logEntry = recordValue(entry);
                if (logEntry === null) return null;
                return <pre key={stringValue(logEntry["id"])} className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">{stringValue(logEntry["excerpt"])}</pre>;
              })}
              {(!Array.isArray(review?.["relevant-logs"]) || review["relevant-logs"].length === 0) && <p className="text-muted-foreground">No relevant run logs were recorded.</p>}
            </div>
          </details>
        </div>
      )}
    </Callout>
  );
}
