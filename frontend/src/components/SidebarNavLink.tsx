import { createElement, type JSX } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "../lib/utils";

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
        "group flex min-h-9 items-center gap-3 rounded-md border-l-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
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
