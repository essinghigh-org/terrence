import * as React from "react";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";

/**
 * Renders field-level 422 details from an ApiError (26.9). Each entry is a
 * bullet with the offending field name and its message. Falls back to a
 * single line when there are no field errors or the error is not an
 * ApiError. `className` lets callers skip the wrapper entirely.
 */
export function FieldErrorList({
  error,
  className,
}: Readonly<{ error: unknown; className?: string }>): React.JSX.Element | null {
  if (error === null || error === undefined) return null;

  if (error instanceof ApiError && Object.keys(error.fieldErrors).length > 0) {
    const entries = Object.entries(error.fieldErrors);
    return (
      <ul
        role="alert"
        data-slot="field-error-list"
        className={cn(
          "my-1 list-disc space-y-1 text-sm text-destructive pl-5",
          className,
        )}
      >
        {entries.map(([field, message], index) => (
          // field name is stable across renders
          // eslint-disable-next-line react/no-array-index-key
          <li key={`${field}-${index}`}>
            <span className="font-medium">{field}:</span> {message}
          </li>
        ))}
      </ul>
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message === "") return null;
  return (
    <p role="alert" data-slot="field-error-list" className={cn("my-1 text-sm text-destructive", className)}>
      {message}
    </p>
  );
}