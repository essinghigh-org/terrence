import { useState, type JSX } from "react";
import { AlertTriangle, Check, Copy, RotateCw } from "lucide-react";
import { ApiError } from "../../lib/api";
import { copyTextToClipboard } from "../../lib/utils";
import { Button } from "./button";

const SAFE_DIAGNOSTIC_KEYS = new Set([
  "screen", "workspaceId", "projectId", "organizationId", "runId", "resourceId", "endpoint", "operation", "phase",
]);

function resolveErrorCode(code: string | undefined, apiError: ApiError | null): string {
  return code ?? apiError?.code ?? "UI_UNEXPECTED_ERROR";
}

function resolveRequestReference(reference: string | undefined, apiError: ApiError | null): string | undefined {
  return reference ?? apiError?.requestId ?? undefined;
}

function hasVisibleText(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function hasReferenceText(reference: string | undefined): boolean {
  return reference !== undefined && reference.trim() !== "";
}

function buildDiagnosticDetails(
  stableCode: string,
  apiError: ApiError | null,
  requestReference: string | undefined,
  diagnosticContext: Readonly<Record<string, string | number | boolean>> | undefined,
): string {
  return [
    `code=${stableCode}`,
    ...(apiError === null ? [] : [`status=${String(apiError.status)}`]),
    ...(requestReference === undefined || requestReference.trim() === "" ? [] : [`reference=${requestReference}`]),
    ...Object.entries(diagnosticContext ?? {})
      .filter(([key]): boolean => SAFE_DIAGNOSTIC_KEYS.has(key))
      .map(([key, value]): string => `${key}=${String(value)}`),
  ].join("\n");
}

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
  error,
  code,
  reference,
  diagnosticContext,
  onRetry,
  retryLabel = "Retry",
  className,
}: Readonly<{
  title?: string;
  message?: string | undefined;
  /** Preserve structured API error metadata when the caller has it. */
  error?: unknown;
  /** Override the stable code derived from an ApiError. */
  code?: string | undefined;
  /** Override the request/correlation reference derived from an ApiError. */
  reference?: string | undefined;
  /** Safe, non-secret context to include in copied diagnostics. */
  diagnosticContext?: Readonly<Record<string, string | number | boolean>> | undefined;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
  className?: string | undefined;
}>): JSX.Element {
  const [copied, setCopied] = useState(false);
  const apiError = error instanceof ApiError ? error : null;
  const displayMessage = message ?? (error instanceof Error ? error.message : undefined);
  const stableCode = resolveErrorCode(code, apiError);
  const requestReference = resolveRequestReference(reference, apiError);
  const diagnosticDetails = buildDiagnosticDetails(stableCode, apiError, requestReference, diagnosticContext);

  const copyDiagnostics = (): void => {
    void copyTextToClipboard(diagnosticDetails).then((didCopy): void => {
      if (didCopy) setCopied(true);
    });
  };

  return (
    <div
      role="alert"
      className={`flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive ${className ?? ""}`}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle data-icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium text-destructive">{title}</p>
          {hasVisibleText(displayMessage) && (
            <p className="mt-0.5 text-sm text-destructive/90">{displayMessage}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-destructive/80">
            <span data-testid="error-code">Code: {stableCode}</span>
            {hasReferenceText(requestReference) && (
              <span data-testid="error-reference">Reference: {requestReference}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copyDiagnostics}
          className="gap-1.5 text-destructive hover:text-destructive"
        >
          {copied ? <Check data-icon="inline-start" className="size-3.5" /> : <Copy data-icon="inline-start" className="size-3.5" />}
          {copied ? "Copied diagnostics" : "Copy diagnostic details"}
        </Button>
      </div>
    </div>
  );
}
