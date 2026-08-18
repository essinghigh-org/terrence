import type { JSX } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "./button";

/**
 * Consistent, retryable error panel for failed reads (kanban 14.12).
 *
 * Failed reads should not disappear into a transient toast. This panel
 * surfaces the error inline, is announced via `role="alert"`, and offers a
 * Retry affordance for cases where a refresh of the failed data may succeed.
 */
export function ErrorPanel({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Retry",
  className,
}: Readonly<{
  title?: string;
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
  className?: string | undefined;
}>): JSX.Element {
  return (
    <div
      role="alert"
      className={`flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive ${className ?? ""}`}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle data-icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium text-destructive">{title}</p>
          {message !== undefined && message !== "" && (
            <p className="mt-0.5 text-sm text-destructive/90">{message}</p>
          )}
        </div>
      </div>
      {onRetry !== undefined && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="gap-1.5 text-destructive"
        >
          <RotateCw data-icon="inline-start" className="size-3.5" />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}