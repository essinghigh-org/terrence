import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export type PageShellVariant = "standard" | "wide" | "form";

type PageShellProps = Readonly<React.ComponentProps<"div"> & {
  children: ReactNode;
  variant?: PageShellVariant;
}>;

type PageHeaderProps = Readonly<{
  action?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}>;

export function PageShell({ children, className, variant = "standard", ...props }: PageShellProps): React.JSX.Element {
  const width = {
    standard: "max-w-6xl",
    wide: "max-w-[1440px]",
    form: "max-w-4xl",
  }[variant];
  return (
    <div className={cn("mx-auto w-full space-y-6 pb-12", width, className)} {...props}>
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
