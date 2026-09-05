import { createElement, type JSX } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "../lib/utils";

/**
 * Names the thing whose navigation is on screen — an org, a project, a
 * workspace, or the settings area you drilled into. One style, used by every
 * sidebar branch, so the hierarchy reads the same everywhere.
 */
export function SidebarContextLabel({
  children,
  collapsed,
  title,
  tone = "primary",
}: Readonly<{
  children: React.ReactNode;
  collapsed: boolean;
  title?: string;
  /** `primary` names the resource; `secondary` names the settings area inside it. */
  tone?: "primary" | "secondary";
}>): JSX.Element {
  return (
    <div
      className={cn(
        "shrink-0 truncate px-3 pb-2 pt-4 text-xs font-semibold",
        tone === "primary" ? "text-foreground" : "text-muted-foreground",
        collapsed && "lg:sr-only",
      )}
      title={title}
    >
      {children}
    </div>
  );
}

/** Divides a long nav list into scannable groups. */
export function SidebarGroupLabel({
  children,
  collapsed,
}: Readonly<{ children: React.ReactNode; collapsed: boolean }>): JSX.Element {
  return (
    <div
      className={cn(
        "px-3 pb-1 pt-4 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground",
        collapsed && "lg:sr-only",
      )}
    >
      {children}
    </div>
  );
}

export type SidebarNavLinkProps = Readonly<{
  active: boolean;
  collapsed: boolean;
  icon: LucideIcon;
  label: string;
  onNavigate: () => void;
  to: string;
  trailing?: boolean;
}>;

export function SidebarNavLink({
  active,
  collapsed,
  icon,
  label,
  onNavigate,
  to,
  trailing = false,
}: SidebarNavLinkProps): JSX.Element {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // Native tooltip in collapsed icon mode; the label is visually hidden
      // there, so hover/focus needs to reveal where the icon goes.
      title={collapsed ? label : undefined}
      className={cn(
        "group flex min-h-10 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/15 bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {createElement(icon, {
        "aria-hidden": true,
        className: cn("size-4 shrink-0", collapsed && "lg:mx-auto"),
      })}
      <span className={cn("truncate", collapsed && "lg:sr-only")}>{label}</span>
      {trailing && (
        <ChevronRight
          aria-hidden="true"
          className={cn("ml-auto size-4", collapsed && "lg:hidden")}
        />
      )}
    </Link>
  );
}
