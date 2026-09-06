import { ArrowDownToLine, Copy, Pause, Play } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { safeHttpUrl } from "@/lib/safe-url";
import { copyTextToClipboard } from "../lib/utils";

type LogPhase = "plan" | "apply";

export function RunLogOutput({
  active,
  children,
  className,
  phase,
  showControls = true,
  onPhaseChange,
  truncated = false,
  wrap = false,
  onToggleWrap,
  logUrl,
}: Readonly<{
  active: boolean;
  children: string;
  className: string;
  phase?: LogPhase;
  showControls?: boolean;
  onPhaseChange?: (phase: LogPhase) => void;
  truncated?: boolean;
  wrap?: boolean;
  onToggleWrap?: () => void;
  logUrl?: string | null | undefined;
}>): React.JSX.Element {
  const element = useRef<HTMLPreElement>(null);
  const followingRef = useRef(true);
  const previousTop = useRef(0);
  const previousLength = useRef(children.length);
  const positioned = useRef(false);
  const [following, setFollowing] = useState(true);
  const [newLines, setNewLines] = useState(0);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);

  const lineCount = (text: string): number => text === "" ? 0 : text.split("\n").length;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const matchCount = normalizedSearch === ""
    ? 0
    : children.toLocaleLowerCase().split(normalizedSearch).length - 1;

  useLayoutEffect((): (() => void) | undefined => {
    const pane = element.current;
    if (pane === null) return;
    const follow = (): void => {
      if ((!active && !positioned.current) || !followingRef.current || pane.clientHeight === 0) return;
      const smooth = positioned.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      pane.scrollTo({ top: pane.scrollHeight, behavior: smooth ? "smooth" : "instant" });
      positioned.current = true;
    };
    follow();
    // A log may mount inside a closed disclosure; follow when it becomes visible.
    const observer = new ResizeObserver(follow);
    observer.observe(pane);
    return (): void => { observer.disconnect(); };
  }, [active, children]);

  useLayoutEffect((): void => {
    const previous = previousLength.current;
    previousLength.current = children.length;
    if (followingRef.current || children.length <= previous) return;
    const appended = children.slice(previous);
    setNewLines((current): number => current + lineCount(appended));
  }, [children]);

  const jumpToLatest = (): void => {
    const pane = element.current;
    followingRef.current = true;
    setFollowing(true);
    setNewLines(0);
    if (pane === null) return;
    pane.scrollTo({ top: pane.scrollHeight, behavior: "instant" });
    positioned.current = true;
  };

  const toggleFollowing = (): void => {
    if (followingRef.current) {
      followingRef.current = false;
      setFollowing(false);
      return;
    }
    jumpToLatest();
  };

  const copyLog = (): void => {
    void copyTextToClipboard(children).then((didCopy): void => {
      if (didCopy) {
        setCopied(true);
        window.setTimeout((): void => { setCopied(false); }, 1_500);
      }
    });
  };

  const safeLogUrl = safeHttpUrl(logUrl);
  const toolbarLabel = phase === undefined ? "Log controls" : `${phase === "plan" ? "Plan" : "Apply"} log controls`;

  return (
    <div className="flex min-w-0 flex-col">
      {phase !== undefined && showControls && (
        <div role="toolbar" aria-label={toolbarLabel} className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-3 py-2 text-xs">
          {onPhaseChange !== undefined && (
            <label className="inline-flex items-center gap-1.5 font-medium text-muted-foreground">
              <span>Phase</span>
              <select
                aria-label="Log phase"
                value={phase}
                onChange={(event): void => {
                  const next = event.currentTarget.value;
                  if (next === "plan" || next === "apply") onPhaseChange(next);
                }}
                className="h-7 rounded border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="plan">Plan</option>
                <option value="apply">Apply</option>
              </select>
            </label>
          )}
          <button
            type="button"
            aria-pressed={following}
            aria-label={following ? "Pause following log" : "Follow log output"}
            onClick={toggleFollowing}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-input bg-background px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {following ? <Pause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
            {following ? "Following" : "Paused"}
          </button>
          <button
            type="button"
            aria-label="Jump to latest log output"
            onClick={jumpToLatest}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-input bg-background px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowDownToLine className="size-3.5" aria-hidden="true" />
            Jump to latest{newLines > 0 ? ` · ${newLines} new line${newLines === 1 ? "" : "s"}` : ""}
          </button>
          <label className="ml-auto inline-flex min-w-[180px] flex-1 items-center gap-1.5 text-muted-foreground sm:flex-none">
            <span className="sr-only">Search loaded log output</span>
            <input
              type="search"
              value={search}
              onInput={(event): void => { setSearch(event.currentTarget.value); }}
              placeholder="Search loaded output…"
              aria-label="Search loaded log output"
              className="h-7 w-full rounded border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span aria-live="polite" className="shrink-0 tabular-nums text-muted-foreground">
              {normalizedSearch === "" ? "" : `${matchCount} match${matchCount === 1 ? "" : "es"}`}
            </span>
          </label>
          <button
            type="button"
            aria-label={copied ? "Log copied" : "Copy loaded log"}
            onClick={copyLog}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-input bg-background px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Copy className="size-3.5" aria-hidden="true" />
            {copied ? "Copied" : "Copy"}
          </button>
          {onToggleWrap !== undefined && (
            <button
              type="button"
              aria-pressed={wrap}
              onClick={onToggleWrap}
              className="inline-flex h-7 items-center rounded border border-input bg-background px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Wrap {wrap ? "on" : "off"}
            </button>
          )}
          {safeLogUrl !== null && (
            <>
              <a
                href={safeLogUrl}
                download
                aria-label="Download raw log"
                title="Provider output may contain secrets; Terrence applies best-effort masking."
                className="inline-flex h-7 items-center rounded border border-input bg-background px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Download raw log
              </a>
              <span className="text-warning-text" title="Provider output may contain secrets; Terrence applies best-effort masking.">
                May contain secrets
              </span>
            </>
          )}
        </div>
      )}
      {truncated && (
        <p role="status" className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning-text">
          Earlier log ranges are unavailable because this output exceeded the retention limit. Showing the retained tail.
        </p>
      )}
      <pre
        ref={element}
        aria-label={phase === undefined ? "Log output" : `${phase === "plan" ? "Plan" : "Apply"} operational log output`}
        className={className}
        onScroll={(event): void => {
          const pane = event.currentTarget;
          if (pane.scrollTop < previousTop.current) {
            followingRef.current = false;
            setFollowing(false);
          }
          if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 24) {
            followingRef.current = true;
            setFollowing(true);
            setNewLines(0);
          }
          previousTop.current = pane.scrollTop;
        }}
      >
        {children}
      </pre>
    </div>
  );
}
