import type { ReactNode } from "react";

import { cn } from "../lib/utils";

type PageShellProps = Readonly<React.ComponentProps<"div"> & { children: ReactNode }>;

type PageHeaderProps = Readonly<{
  action?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}>;

export function PageShell({ children, className, ...props }: PageShellProps): React.JSX.Element {
  return (
    <div className={cn("mx-auto w-full max-w-6xl space-y-6 pb-12", className)} {...props}>
      {children}
    </div>
  );
}

export function PageHeader({ action, description, eyebrow, title }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
      <div className="min-w-0">
        {eyebrow !== undefined && (
          <div className="mb-3 text-xs font-medium text-muted-foreground">{eyebrow}</div>
        )}
        <h1 className="text-balance text-3xl font-bold tracking-tight text-foreground">{title}</h1>
        {description !== undefined && (
          <p className="mt-1 max-w-3xl text-pretty text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </header>
  );
}
