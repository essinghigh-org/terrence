import { Button } from "./ui/button";

/**
 * Persistent degraded-data banner (kanban 14.13). Amber and non-dismissing:
 * the underlying data is still stale, so the refresh path stays visible
 * until the user acts or the next poll succeeds. Use for "may be out of
 * date / could not be refreshed" states, not for hard errors (use an
 * inline error alert for those).
 */
export function DegradedBanner(props: Readonly<{
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}>): React.JSX.Element {
  const { title, actionLabel, onAction } = props;
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <span>{title}</span>
      {actionLabel !== undefined && onAction !== undefined && (
        <Button variant="outline" onClick={onAction}>{actionLabel}</Button>
      )}
    </div>
  );
}