import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Copy, Link2, Play, RotateCcw } from "lucide-react";
import { cn, copyTextToClipboard } from "@/lib/utils";
import { safeHttpUrl } from "@/lib/safe-url";
import { isString } from "@/lib/type-guards";
import { formatDate } from "@/lib/run-detail-format";
import { formatRunSource, formatRunStatus, isVcsRunSource } from "@/lib/run-labels";
import type { RunAttributes } from "@/lib/run-view-state";
import { StatusBadge } from "../ui/status-badge";
import { Badge } from "../ui/badge";
import { Button, buttonVariants } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { toast } from "../ui/toast";

function useCopyRunLink(runPermalink: string, runId: string): Readonly<{
  copiedPermalink: boolean;
  copyRunPermalink: () => Promise<void>;
  copyRunId: () => Promise<void>;
}> {
  const [copiedPermalink, setCopiedPermalink] = useState(false);
  const copiedPermalinkResetTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (copiedPermalinkResetTimerRef.current !== undefined) window.clearTimeout(copiedPermalinkResetTimerRef.current);
    };
  }, []);

  async function copyRunPermalink(): Promise<void> {
    const didCopy = await copyTextToClipboard(runPermalink);
    if (!mountedRef.current) return;
    if (didCopy) {
      setCopiedPermalink(true);
      toast.add({ title: "Run permalink copied", type: "success" });
      if (copiedPermalinkResetTimerRef.current !== undefined) window.clearTimeout(copiedPermalinkResetTimerRef.current);
      copiedPermalinkResetTimerRef.current = window.setTimeout((): void => {
        copiedPermalinkResetTimerRef.current = undefined;
        setCopiedPermalink(false);
      }, 2000);
      return;
    }
    toast.add({ title: "Could not copy link", type: "error" });
  }

  // The bare run ID (not the permalink) is what people paste into tickets and
  // the CLI. It used to live in the workspace header that wrapped this page;
  // now that a run is its own page, the affordance belongs here.
  async function copyRunId(): Promise<void> {
    const didCopy = await copyTextToClipboard(runId);
    if (!mountedRef.current) return;
    if (didCopy) {
      toast.add({ title: "Run ID copied", type: "success" });
      return;
    }
    toast.add({ title: "Could not copy run ID", type: "error" });
  }

  return { copiedPermalink, copyRunPermalink, copyRunId };
}

function RunStatusBadges({ attributes, status, speculativeRun }: Readonly<{
  attributes: RunAttributes;
  status: string;
  speculativeRun: boolean;
}>): React.JSX.Element {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {/* One badge, one status vocabulary (lib/run-status). The page used
          to hand-roll this mapping here and in six other places. */}
      <StatusBadge status={status} className="rounded" />
      <span aria-live="polite" className="sr-only">Run status: {formatRunStatus(status)}</span>
      {attributes["plan-only"] === true && <Badge variant="outline" className="rounded">Plan only</Badge>}
      {speculativeRun && <Badge variant="outline" className="rounded" title="This speculative plan never applies">Speculative</Badge>}
      {attributes["is-destroy"] === true && <Badge variant="destructive" className="rounded">Destroy</Badge>}
      {attributes["refresh-only"] === true && <Badge variant="outline" className="rounded text-primary border-primary/30 bg-primary/10">Refresh only</Badge>}
      {attributes["allow-empty-apply"] === true && <Badge variant="outline" className="rounded text-primary border-primary/30 bg-primary/10">Allow empty apply</Badge>}
    </div>
  );
}

function VcsReference({ attributes }: Readonly<{ attributes: RunAttributes }>): React.JSX.Element | null {
  if (!isVcsRunSource(attributes.source, attributes["trigger-reason"])) return null;
  const commitSha = attributes["commit-sha"];
  const commitUrl = isString(attributes["commit-url"]) ? safeHttpUrl(attributes["commit-url"]) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{isString(attributes.branch) ? attributes.branch : "Default branch"}</span>
      {commitSha !== undefined && commitSha !== null && commitSha !== "" && (
        commitUrl !== null ? (
          <a
            href={commitUrl}
            target="_blank"
            rel="noreferrer"
            title={commitSha}
            className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-primary underline decoration-primary/40 hover:no-underline"
          >
            {commitSha.slice(0, 12)}
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </a>
        ) : (
          <code title={commitSha}>{commitSha.slice(0, 12)}</code>
        )
      )}
    </div>
  );
}

function RunHeaderActions({ workspacePath, canRerun, rerunBlockedReason, rerunPending, pendingAction, rerunError, copiedPermalink, onCopyPermalink, onOpenRerunDialog }: Readonly<{
  workspacePath: string;
  canRerun: boolean;
  rerunBlockedReason: string | null;
  rerunPending: boolean;
  pendingAction: string;
  rerunError: string;
  copiedPermalink: boolean;
  onCopyPermalink: () => void;
  onOpenRerunDialog: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 lg:max-w-sm lg:justify-end">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        aria-label="Copy run permalink"
        onClick={onCopyPermalink}
      >
        <Link2 className="size-3.5" aria-hidden="true" />
        {copiedPermalink ? "Copied" : "Copy link"}
      </Button>
      {/* Starting a fresh run used to come from the workspace header that
          wrapped this page. Re-run is permission-gated, so keep an
          unconditional route to the new-run form. */}
      <Link
        to={`${workspacePath}/runs?new-run=true`}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
      >
        <Play className="size-3.5" aria-hidden="true" />
        New run
      </Link>
      {(canRerun || rerunBlockedReason !== null) && (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={!canRerun || rerunPending || pendingAction !== ""}
          title={rerunBlockedReason ?? undefined}
          onClick={onOpenRerunDialog}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {rerunPending ? "Queuing…" : "Re-run"}
        </Button>
      )}
      {rerunBlockedReason !== null && (
        <span className="w-full text-xs text-muted-foreground lg:text-right">{rerunBlockedReason}</span>
      )}
      {rerunError !== "" && (
        <p role="alert" className="w-full text-xs text-destructive">{rerunError}</p>
      )}
      {/* Cancel, force cancel, apply, discard and override all live in the
          decision panel below. They used to be split between here and a
          panel at the foot of the page, with a third block explaining why
          the ones here were missing. */}
    </div>
  );
}

function RerunDialog({ open, onOpenChange, rerunPending, onRerun }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rerunPending: boolean;
  onRerun: (mode: "original" | "current") => void;
}>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose rerun inputs</DialogTitle>
          <DialogDescription>
            A rerun creates a new run. Choose the immutable inputs captured for this run, or the workspace settings currently configured.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={rerunPending} onClick={(): void => { onRerun("original"); }}>
            Original inputs
          </Button>
          <Button type="button" disabled={rerunPending} onClick={(): void => { onRerun("current"); }}>
            Current settings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type RunHeaderProps = Readonly<{
  orgName: string;
  orgPath: string;
  workspaceName: string;
  workspacePath: string;
  runId: string;
  runPermalink: string;
  attributes: RunAttributes;
  status: string;
  speculativeRun: boolean;
  canRerun: boolean;
  rerunBlockedReason: string | null;
  rerunPending: boolean;
  pendingAction: string;
  rerunError: string;
  rerunDialogOpen: boolean;
  setRerunDialogOpen: (open: boolean) => void;
  onRerun: (mode: "original" | "current") => void;
}>;

export function RunHeader(props: RunHeaderProps): React.JSX.Element {
  const { attributes, status, runId, runPermalink } = props;
  const { copiedPermalink, copyRunPermalink, copyRunId } = useCopyRunLink(runPermalink, runId);
  return (
    <>
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <RunStatusBadges attributes={attributes} status={status} speculativeRun={props.speculativeRun} />
          {/* A run page is now its own page rather than a panel nested under the
              workspace header, so its title is the document's h1. */}
          <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl text-foreground">
            {attributes.message ?? "Manual run"}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <p>
              {formatRunSource(attributes.source, attributes["trigger-reason"])} · Created {formatDate(attributes["created-at"])}
            </p>
            <div className="flex items-center gap-1">
              <span>Run ID:</span>
              <code className="select-all font-mono">{runId}</code>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Copy run ID"
                onClick={(): void => { void copyRunId(); }}
              >
                <Copy aria-hidden="true" />
              </Button>
            </div>
            <VcsReference attributes={attributes} />
          </div>
        </div>
        <RunHeaderActions
          workspacePath={props.workspacePath}
          canRerun={props.canRerun}
          rerunBlockedReason={props.rerunBlockedReason}
          rerunPending={props.rerunPending}
          pendingAction={props.pendingAction}
          rerunError={props.rerunError}
          copiedPermalink={copiedPermalink}
          onCopyPermalink={(): void => { void copyRunPermalink(); }}
          onOpenRerunDialog={(): void => { props.setRerunDialogOpen(true); }}
        />
      </header>
      <RerunDialog
        open={props.rerunDialogOpen}
        onOpenChange={props.setRerunDialogOpen}
        rerunPending={props.rerunPending}
        onRerun={(mode): void => { props.onRerun(mode); }}
      />
    </>
  );
}
