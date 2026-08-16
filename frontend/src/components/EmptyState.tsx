import { Link } from "react-router-dom";
import { Button } from "./ui/button";

/**
 * Consistent empty state (kanban 14.11): explanation, permission-aware
 * primary action, and a docs link when relevant. Callers gate the action
 * props on the current user's permissions (e.g. only pass onAction when the
 * user can create workspaces); DegradedBanner is the sibling component for
 * stale-data states.
 */
export function EmptyState(props: Readonly<{
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  docsHref?: string;
  compact?: boolean;
  headingLevel?: "h2" | "h3" | "h4";
}>): React.JSX.Element {
  const { title, description, actionLabel, onAction, docsHref, compact, headingLevel = "h2" } = props;
  const hasAction = actionLabel !== undefined && onAction !== undefined;
  const footerVisible = hasAction || docsHref !== undefined;
  const Heading = headingLevel;
  return (
    <div className={`text-center text-muted-foreground ${compact ? "p-6" : "p-12"}`}>
      <Heading className="font-medium text-foreground">{title}</Heading>
      {description !== undefined && (
        <p className={`mx-auto mt-1 max-w-md text-sm ${footerVisible ? "mb-4" : ""}`}>{description}</p>
      )}
      {footerVisible && (
        <div className="mt-4 flex items-center justify-center gap-3">
          {hasAction && (
            <Button
              className="h-9 rounded-[4px] bg-primary px-4 text-primary-foreground shadow-none hover:bg-primary/90"
              onClick={onAction}
            >
              {actionLabel}
            </Button>
          )}
          {docsHref !== undefined &&
            (docsHref.startsWith("/app/") ? (
              <Link
                to={docsHref}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Read the docs
              </Link>
            ) : (
              <a
                href={docsHref}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Read the docs
              </a>
            ))}
        </div>
      )}
    </div>
  );
}