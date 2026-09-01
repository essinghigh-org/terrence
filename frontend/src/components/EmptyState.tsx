import { Link } from "react-router-dom";

import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

/**
 * Consistent empty state (kanban 14.11): explanation, permission-aware
 * primary action, and a docs link when relevant. Callers gate the action
 * props on the current user's permissions (e.g. only pass onAction when the
 * user can create workspaces); DegradedBanner is the sibling component for
 * stale-data states.
 *
 * Built on the `Empty` primitives so that views composing those directly (the
 * registry pages) and views using this wrapper render the same thing — before,
 * the app had two unrelated empty-state treatments.
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
  return (
    <Empty className={compact === true ? "p-6" : "p-12"}>
      <EmptyHeader>
        {/* EmptyTitle is a div; render a real heading inside it so empty
            states still land in the document outline. */}
        <EmptyTitle className="text-foreground">
          {headingLevel === "h4"
            ? <h4>{title}</h4>
            : headingLevel === "h3"
              ? <h3>{title}</h3>
              : <h2>{title}</h2>}
        </EmptyTitle>
        {description !== undefined && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {footerVisible && (
        <EmptyContent className="max-w-none flex-row items-center justify-center gap-3">
          {hasAction && <Button onClick={onAction}>{actionLabel}</Button>}
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
        </EmptyContent>
      )}
    </Empty>
  );
}
