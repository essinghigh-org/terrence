import { cn } from "@/lib/utils";

/**
 * A grid of label/value pairs — the "Status / Created by / Duration" blocks
 * that appear on nearly every detail page.
 *
 * The app wrote this by hand 23 times in four different spellings: the same
 * `text-xs font-semibold uppercase tracking-wide text-muted-foreground` label
 * recipe appeared 13 times verbatim, plus a `tracking-wider` variant, plus one
 * that used `<div>` instead of `<dt>` and so lost the definition-list
 * semantics a screen reader relies on to pair a value with its label, plus a
 * fourth with opacity suffixes. Class order also drifted between adjacent
 * instances in the same file, which defeated any grep-based cleanup.
 */

export type MetaItem = Readonly<{
  label: string;
  value: React.ReactNode;
  /** Extra note under the value — a caveat, a comparison, a hint. */
  note?: React.ReactNode;
  /** Native tooltip on the value. */
  title?: string;
}>;

/** How many columns the grid uses at the widest breakpoint. */
export type MetaColumns = 2 | 3 | 4 | 5;

const COLUMN_CLASSES: Readonly<Record<MetaColumns, string>> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-5",
};

export function MetaList({
  items,
  columns = 4,
  className,
  "aria-label": ariaLabel,
}: Readonly<{
  items: readonly MetaItem[];
  columns?: MetaColumns;
  className?: string;
  "aria-label"?: string;
}>): React.JSX.Element {
  return (
    <dl
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      className={cn("grid gap-4 text-sm", COLUMN_CLASSES[columns], className)}
    >
      {items.map((item: MetaItem): React.JSX.Element => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {item.label}
          </dt>
          <dd
            className="mt-1 font-medium text-foreground"
            {...(item.title === undefined ? {} : { title: item.title })}
          >
            {item.value}
          </dd>
          {item.note !== undefined && (
            <div className="mt-1 text-xs text-muted-foreground">{item.note}</div>
          )}
        </div>
      ))}
    </dl>
  );
}

/**
 * The three-across summary strip at the top of a detail page: the same pairs,
 * but as separated cells in a bordered card rather than a plain grid.
 */
export function MetaStrip({
  items,
  className,
}: Readonly<{ items: readonly MetaItem[]; className?: string }>): React.JSX.Element {
  return (
    <dl
      className={cn(
        "grid overflow-hidden rounded-lg border border-border bg-card",
        items.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2",
        className,
      )}
    >
      {items.map((item: MetaItem, index: number): React.JSX.Element => (
        <div
          key={item.label}
          className={cn(
            "px-5 py-4",
            index < items.length - 1 && "border-b border-border sm:border-b-0 sm:border-r",
          )}
        >
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {item.label}
          </dt>
          <dd
            className="mt-1 text-sm font-semibold text-foreground"
            {...(item.title === undefined ? {} : { title: item.title })}
          >
            {item.value}
          </dd>
          {item.note !== undefined && (
            <div className="mt-1 text-xs">{item.note}</div>
          )}
        </div>
      ))}
    </dl>
  );
}
