import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A collapsible section.
 *
 * The app had nineteen hand-rolled `<details>`/`<summary>` pairs and no shared
 * primitive, each re-typing the same recipe — and inconsistently. Some
 * remembered `list-none [&::-webkit-details-marker]:hidden` and some did not,
 * so a stray triangle appeared next to the chevron in about half of them; some
 * had `focus-visible:ring-inset` and some did not, so the focus ring was
 * clipped in the others. Four of them also forgot the chevron entirely, giving
 * no visual cue that the row could open.
 *
 * Built on native `<details>` deliberately: it is keyboard- and
 * screen-reader-accessible without any JavaScript, works with in-page find,
 * and needs no open-state wiring for the common case.
 */
export function Disclosure({
  label,
  meta,
  children,
  open,
  onToggle,
  className,
  summaryClassName,
  bodyClassName,
  labelledById,
}: Readonly<{
  /** The clickable heading content. A string, or richer nodes. */
  label: React.ReactNode;
  /** Right-aligned status, counts or controls, shown on the summary row. */
  meta?: React.ReactNode;
  children: React.ReactNode;
  /** Controlled open state. Omit to let the browser own it. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
  summaryClassName?: string;
  bodyClassName?: string;
  /** id of an element that names this section, for `aria-labelledby`. */
  labelledById?: string;
}>): React.JSX.Element {
  return (
    <details
      {...(open === undefined ? {} : { open })}
      {...(labelledById === undefined ? {} : { "aria-labelledby": labelledById })}
      className={cn("group overflow-hidden rounded-lg border border-border bg-card", className)}
      onToggle={(event: React.SyntheticEvent<HTMLDetailsElement>): void => {
        onToggle?.(event.currentTarget.open);
      }}
    >
      <summary
        className={cn(
          // list-none plus the webkit marker rule: without both, the native
          // triangle renders beside the chevron in some browsers.
          "flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3",
          "text-sm font-medium text-foreground hover:bg-muted/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          "[&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground/70 transition-transform group-open:rotate-90"
          />
          <span className="min-w-0">{label}</span>
        </span>
        {meta !== undefined && <span className="flex shrink-0 items-center gap-3">{meta}</span>}
      </summary>
      <div className={cn("border-t border-border", bodyClassName)}>{children}</div>
    </details>
  );
}
