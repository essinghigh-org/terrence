import { Link } from "react-router-dom";

export type BreadcrumbItem = Readonly<{
  label: string;
  /** Route path for clickable ancestors. Omit for the current (last) item. */
  to?: string;
}>;

/**
 * Standardized Org / Project / Workspace / Run breadcrumb trail (kanban
 * 14.19). Ancestors link to their routes; the last item renders as the
 * current page with aria-current="page".
 */
export function Breadcrumbs(props: Readonly<{ items: readonly BreadcrumbItem[] }>): React.JSX.Element {
  const { items } = props;
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-medium text-gray-500">
      <ol className="flex min-w-0 flex-wrap items-center gap-1.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const clickable = item.to !== undefined && !isLast;
          return (
            <li key={`${item.label}:${index}`} className="flex min-w-0 items-center gap-1.5">
              {clickable ? (
                <Link to={item.to!} className="truncate hover:text-gray-900 hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? "page" : undefined} className="truncate text-gray-900">
                  {item.label}
                </span>
              )}
              {!isLast && <span aria-hidden="true" className="text-gray-300">/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}