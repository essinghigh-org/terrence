import { useEffect, useRef, useState, type JSX } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, BookOpen, ChevronRight } from "lucide-react";

import { groupDocsByCategory, type DocSummary } from "../lib/docs-index";
import { cn } from "../lib/utils";
import { SidebarNavLink } from "./SidebarNavLink";

type DocsSidebarNavProps = Readonly<{
  index: DocSummary[] | null;
  selectedSlug: string | undefined;
  collapsed: boolean;
  onNavigate: () => void;
}>;

/**
 * Documentation tree for the application sidebar. Rendered only while on a
 * /app/docs route. Categories are collapsed by default; the category of the
 * currently viewed document is expanded automatically.
 */
export function DocsSidebarNav({
  index,
  selectedSlug,
  collapsed,
  onNavigate,
}: DocsSidebarNavProps): JSX.Element {
  const groups = groupDocsByCategory(index ?? []);
  const activeCategory = groups.find((group): boolean =>
    group.docs.some((doc): boolean => doc.slug === selectedSlug),
  )?.category;
  const [expanded, setExpanded] = useState<Set<string>>((): Set<string> =>
    new Set(activeCategory === undefined ? [] : [activeCategory]),
  );
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // Reveal the active document's category once the index arrives or the
  // selection changes. Manual collapses are respected while browsing the
  // same document; navigating to another document re-opens its category.
  useEffect((): void => {
    if (activeCategory === undefined || index === null) return;
    setExpanded((previous): Set<string> =>
      previous.has(activeCategory) ? previous : new Set(previous).add(activeCategory),
    );
  }, [activeCategory, index]);

  // Keep the active document visible after navigation and after the index
  // arrives (the sidebar has its own scroll area).
  useEffect((): void => {
    if (index === null || activeRef.current === null) return;
    activeRef.current.scrollIntoView({ block: "nearest" });
  }, [index, selectedSlug]);

  if (collapsed) {
    return (
      <SidebarNavLink
        active={false}
        collapsed={collapsed}
        icon={BookOpen}
        label="Documentation"
        onNavigate={onNavigate}
        to="/app/docs"
      />
    );
  }

  const toggleCategory = (category: string): void => {
    setExpanded((previous): Set<string> => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  return (
    <>
      <SidebarNavLink
        active={false}
        collapsed={collapsed}
        icon={ArrowLeft}
        label="Organizations"
        onNavigate={onNavigate}
        to="/app"
      />
      <div className="px-3 pb-2 pt-4 text-xs font-semibold text-muted-foreground">
        Documentation
      </div>
      {index === null ? (
        <div className="px-3 py-1.5 text-sm text-muted-foreground">Loading documentation…</div>
      ) : (
        <nav aria-label="Documentation index" className="space-y-1">
          {groups.map((group, groupIndex): JSX.Element => {
            const open = expanded.has(group.category);
            const listId = `docs-category-${groupIndex}`;
            return (
              <div key={group.category}>
                <button
                  type="button"
                  onClick={(): void => {
                    toggleCategory(group.category);
                  }}
                  aria-expanded={open}
                  aria-controls={listId}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    open
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("size-4 shrink-0 transition-transform", open && "rotate-90 text-primary")}
                  />
                  <span className="truncate">{group.category}</span>
                </button>
                {open && (
                  <ul id={listId} className="mt-0.5 space-y-0.5 pb-1">
                    {group.docs.map((doc): JSX.Element => {
                      const active = doc.slug === selectedSlug;
                      return (
                        <li key={doc.slug}>
                          <Link
                            to={`/app/docs/${encodeURIComponent(doc.slug)}`}
                            onClick={onNavigate}
                            ref={active ? activeRef : undefined}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex w-full items-center rounded-md py-1.5 pl-10 pr-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                              active
                                ? "bg-primary/10 font-medium text-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                          >
                            <span className="truncate">{doc.title}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>
      )}
    </>
  );
}
