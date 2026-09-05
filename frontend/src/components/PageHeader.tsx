import { createElement, type ReactNode } from "react";

import { Breadcrumbs, type BreadcrumbItem } from "./Breadcrumbs";
import { Card, CardFooter } from "./ui/card";
import { cn } from "../lib/utils";

export type PageShellVariant = "standard" | "wide" | "form";

type PageShellProps = Readonly<React.ComponentProps<"div"> & {
  children: ReactNode;
  variant?: PageShellVariant;
}>;

type PageHeaderProps = Readonly<{
  action?: ReactNode;
  /**
   * Real, linked breadcrumb trail. Prefer this over `eyebrow` whenever the
   * ancestors are navigable — `eyebrow` renders the same pixels but without
   * links or the Breadcrumb landmark.
   */
  breadcrumbs?: readonly BreadcrumbItem[];
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}>;

type SettingsSectionProps = Readonly<{
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  /** Rendered in the card footer, right-aligned. Usually the save button. */
  footer?: ReactNode | false;
  headingLevel?: "h2" | "h3";
  /** Applies the destructive treatment used by irreversible actions. */
  tone?: "default" | "danger";
  title: ReactNode;
}>;

/**
 * The single authority on page width. Views must not re-center or re-cap
 * their content: pick the variant that matches the content shape and let
 * every child fill it.
 *
 * - `standard` — list and index pages.
 * - `wide` — data-dense tables, run output, workspace detail.
 * - `form` — settings and forms, which pair with `SettingsSection`.
 */
export function PageShell({ children, className, variant = "standard", ...props }: PageShellProps): React.JSX.Element {
  const width = {
    standard: "max-w-[1280px]",
    wide: "max-w-[1680px]",
    form: "max-w-[1100px]",
  }[variant];
  return (
    <div className={cn("mx-auto w-full space-y-6 pb-12", width, className)} {...props}>
      {children}
    </div>
  );
}

export function PageHeader({ action, breadcrumbs, description, eyebrow, title }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
      <div className="min-w-0">
        {breadcrumbs !== undefined && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} />}
        {eyebrow !== undefined && (
          <div className="mb-3 text-xs font-medium text-muted-foreground">{eyebrow}</div>
        )}
        <h1 className="font-heading text-balance text-3xl font-bold tracking-tight text-foreground">{title}</h1>
        {description !== undefined && (
          <p className="mt-2 max-w-3xl text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {action !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </header>
  );
}

/**
 * Standard settings block: the title and description sit in a left rail and
 * the controls fill the remaining width, so a settings page reads as a scannable
 * index rather than a single narrow column of stacked cards.
 *
 * The rail is a container query, not a viewport one. What decides whether two
 * columns fit is the width of this card, and with a permanent 280px sidebar
 * that is not a function of the viewport: a `lg:` breakpoint would split the
 * card into columns while the content area was still narrow. Keying off the
 * card's own width also makes the component reusable anywhere.
 */
export function SettingsSection({
  children,
  className,
  description,
  footer,
  headingLevel = "h2",
  title,
  tone = "default",
}: SettingsSectionProps): React.JSX.Element {
  return (
    <Card
      className={cn(
        "@container/settings-section",
        tone === "danger" && "ring-destructive/30",
        className,
      )}
    >
      {/* Two columns only once the card itself is wide enough to seat a 16rem
          rail beside a usable control column (@3xl = 48rem). */}
      <div className="grid gap-x-10 gap-y-4 px-(--card-spacing) @3xl/settings-section:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          {createElement(
            headingLevel,
            {
              className: cn(
                "font-heading text-base font-medium leading-snug",
                tone === "danger" && "text-destructive",
              ),
            },
            title,
          )}
          {description !== undefined && (
            <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
      {/* `false` is the natural value when a caller conditions the footer on a
          permission, and it must not leave an empty footer bar behind. */}
      {footer !== undefined && footer !== null && footer !== false && (
        <CardFooter className="justify-end gap-2">{footer}</CardFooter>
      )}
    </Card>
  );
}
