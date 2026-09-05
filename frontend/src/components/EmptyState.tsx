import { Terrence, type TerrencePose } from "./brand/Terrence";
import { Link } from "react-router-dom";

import { Button, buttonVariants } from "./ui/button";
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
  illustration?: TerrencePose | undefined;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /**
   * Where the primary action goes, when the next step is a different page
   * rather than a callback on this one.
   *
   * Several empty states used to *describe* the way out in prose — "Create a
   * workspace in this project to get started", "Add one in organization VCS
   * settings" — without offering a control, leaving the user to go and find
   * the page named. Pass this with `actionLabel` and the description can stop
   * doing the navigation's job.
   */
  actionHref?: string;
  docsHref?: string;
  compact?: boolean;
  headingLevel?: "h2" | "h3" | "h4";
}>): React.JSX.Element {
  const { illustration, title, description, actionLabel, onAction, actionHref, docsHref, compact, headingLevel = "h2" } = props;
  const hasAction = actionLabel !== undefined && (onAction !== undefined || actionHref !== undefined);
  const footerVisible = hasAction || docsHref !== undefined;
  return (
    <Empty className={compact === true ? "p-6" : "px-6 py-12"}>
      {illustration !== undefined && <Terrence pose={illustration} className={compact === true ? "w-32" : "w-44"} />}
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
        <EmptyContent className="max-w-none flex-row flex-wrap items-center justify-center gap-3">
          {hasAction && (onAction !== undefined
            ? <Button onClick={onAction}>{actionLabel}</Button>
            : (
              <Link to={actionHref ?? "#"} className={buttonVariants()}>
                {actionLabel}
              </Link>
            ))}
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
