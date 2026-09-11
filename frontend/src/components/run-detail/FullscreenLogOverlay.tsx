import { X } from "lucide-react";
import { truncateLogForDisplay } from "@/lib/log-display";
import type { FullscreenLogPhase } from "@/lib/use-fullscreen-log";
import type { RefObject } from "react";
import { RunLogOutput } from "../RunLogOutput";
import { Button } from "../ui/button";

export type FullscreenLogOverlayProps = Readonly<{
  phase: FullscreenLogPhase;
  planStatus: string;
  applyStatus: string;
  planLogTruncated: boolean;
  applyLogTruncated: boolean;
  logWrap: boolean;
  onToggleWrap: () => void;
  planLogUrl: string | null | undefined;
  applyLogUrl: string | null | undefined;
  planLogs: string;
  applyLogs: string;
  planRawLogMessage: string;
  applyRawLogMessage: string;
  closeRef: RefObject<HTMLButtonElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}>;

export function FullscreenLogOverlay(props: FullscreenLogOverlayProps): React.JSX.Element {
  const isPlan = props.phase === "plan";
  return (
    <div
      ref={props.containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={isPlan ? "Raw plan log" : "Raw apply log"}
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">
          {isPlan ? "Raw plan log" : "Raw apply log"}
        </h2>
        <Button
          ref={props.closeRef}
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onClose}
          aria-label="Close fullscreen log"
        >
          <X className="size-4" aria-hidden="true" />
          Close
        </Button>
      </div>
      <RunLogOutput
        key={props.phase}
        active={(isPlan ? props.planStatus : props.applyStatus) === "running"}
        phase={props.phase}
        truncated={isPlan ? props.planLogTruncated : props.applyLogTruncated}
        wrap={props.logWrap}
        onToggleWrap={props.onToggleWrap}
        logUrl={isPlan ? props.planLogUrl : props.applyLogUrl}
        className={`flex-1 overflow-auto ${props.logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}
      >
        {isPlan
          ? props.planLogs !== "" ? truncateLogForDisplay(props.planLogs) : props.planRawLogMessage
          : props.applyLogs !== "" ? truncateLogForDisplay(props.applyLogs) : props.applyRawLogMessage}
      </RunLogOutput>
    </div>
  );
}
