import type { JSX, HTMLAttributes } from "react";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type BadgeProps = Readonly<{
  readonly variant?: "default" | "secondary" | "destructive" | "outline";
}> & DeepReadonly<HTMLAttributes<HTMLSpanElement>>;

export function Badge({ className = "", variant = "default", ...props }: BadgeProps): JSX.Element {
  const baseStyle = "inline-flex max-w-full items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  const variantStyles = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    destructive: "border-destructive/20 bg-destructive/10 text-destructive",
    outline: "border-border bg-background text-foreground",
  };

  const styleClass = variantStyles[variant];

  return (
// SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
    <span className={`${baseStyle} ${styleClass} ${className}`} {...(props as HTMLAttributes<HTMLSpanElement>)} />
  );
}
