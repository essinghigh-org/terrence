import * as React from "react";

import { cn } from "../../lib/utils";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type CardProps = DeepReadonly<React.ComponentProps<"div">> & Readonly<{ size?: "default" | "sm" }>;
type CardHeaderProps = DeepReadonly<React.ComponentProps<"div">> & Readonly<{ variant?: "default" | "section" | "danger" }>;

function Card({
  className,
  size = "default",
  ...props
}: CardProps): React.JSX.Element {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground shadow-[0_1px_2px_hsl(var(--foreground)/.04)] ring-1 ring-border/80 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

function CardHeader({ className, variant = "default", ...props }: CardHeaderProps): React.JSX.Element {
  return (
    <div
      data-slot="card-header"
      data-variant={variant}
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        variant === "section" && "-mt-(--card-spacing) border-b bg-muted/50 pt-(--card-spacing)",
        variant === "danger" && "-mt-(--card-spacing) border-b border-destructive/30 bg-destructive/15 pt-(--card-spacing) text-destructive",
        className
      )}
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

function CardTitle({ className, ...props }: DeepReadonly<React.ComponentProps<"div">>): React.JSX.Element {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

function CardDescription({ className, ...props }: DeepReadonly<React.ComponentProps<"div">>): React.JSX.Element {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

function CardAction({ className, ...props }: DeepReadonly<React.ComponentProps<"div">>): React.JSX.Element {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

function CardContent({ className, ...props }: DeepReadonly<React.ComponentProps<"div">>): React.JSX.Element {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

function CardFooter({ className, ...props }: DeepReadonly<React.ComponentProps<"div">>): React.JSX.Element {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center border-t bg-muted/30 p-(--card-spacing)",
        className
      )}
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
