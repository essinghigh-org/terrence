import { cn } from "@/lib/utils";

/**
 * Skeleton placeholder for dense list/table pages (kanban 14.14). Renders
 * `rows` shimmer rows with `cols` columns so the layout reads as a table
 * while data loads, instead of a lone spinner. Accessible label announces
 * the loading state to assistive technology.
 */
export function TableSkeleton({
  rows = 5,
  cols = 6,
  className,
  label = "Loading",
}: Readonly<{ rows?: number; cols?: number; className?: string; label?: string }>): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("w-full", className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_unused, rowIndex): React.JSX.Element => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
        >
          {Array.from({ length: cols }, (_unused, colIndex): React.JSX.Element => (
            <div
              key={colIndex}
              className="h-3.5 animate-pulse rounded bg-muted"
              style={{ width: `${[22, 30, 14, 18, 26, 12][colIndex % 6] ?? 20}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}